package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type agendaPublish struct {
	Topic   string   `json:"topic"`
	Title   string   `json:"title"`
	Message string   `json:"message"`
	Tags    []string `json:"tags"`
}

type agendaSink struct {
	server   *httptest.Server
	mu       sync.Mutex
	requests []agendaPublish
	status   int
}

func newAgendaSink(t *testing.T) *agendaSink {
	t.Helper()
	sink := &agendaSink{status: http.StatusOK}
	sink.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read ntfy body: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var payload agendaPublish
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("decode ntfy body: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		sink.mu.Lock()
		sink.requests = append(sink.requests, payload)
		status := sink.status
		sink.mu.Unlock()
		w.WriteHeader(status)
	}))
	t.Cleanup(sink.server.Close)
	return sink
}

func (s *agendaSink) published() []agendaPublish {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]agendaPublish(nil), s.requests...)
}

func newAgendaTestApp(t *testing.T) *App {
	t.Helper()
	configureAgendaTestNtfy(t, "", "")
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.Close() })
	return app
}

// configureAgendaTestNtfy points the notifier at the test sink and clears the
// capture settings so ambient environment variables cannot leak between tests.
func configureAgendaTestNtfy(t *testing.T, serverURL, topic string) {
	t.Helper()
	t.Setenv("NTFY_SERVER_URL", serverURL)
	t.Setenv("AGENDA_NTFY_TOPIC", topic)
	t.Setenv("NTFY_TOPIC", "")
	t.Setenv("NTFY_USERNAME", "")
	t.Setenv("NTFY_PASSWORD", "")
}

func createAgendaTestEvent(t *testing.T, app *App, title string, when time.Time) AgendaEvent {
	t.Helper()
	event, err := app.CreateAgendaEvent(agendaEventInput{
		Title:   title,
		EventAt: when.UTC().Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	return event
}

func TestAgendaEventsListUpcomingThenRecentPast(t *testing.T) {
	app := newAgendaTestApp(t)
	now := time.Now()
	pastOld := createAgendaTestEvent(t, app, "antigo", now.Add(-72*time.Hour))
	pastRecent := createAgendaTestEvent(t, app, "recente", now.Add(-2*time.Hour))
	next := createAgendaTestEvent(t, app, "próximo", now.Add(2*time.Hour))
	later := createAgendaTestEvent(t, app, "depois", now.Add(48*time.Hour))

	list, err := app.ListAgendaEvents()
	if err != nil {
		t.Fatal(err)
	}
	if list.Total != 4 || len(list.Items) != 4 {
		t.Fatalf("unexpected list size: %#v", list)
	}
	got := []int64{list.Items[0].ID, list.Items[1].ID, list.Items[2].ID, list.Items[3].ID}
	want := []int64{next.ID, later.ID, pastRecent.ID, pastOld.ID}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
}

func TestAgendaHandlersCreatePatchDelete(t *testing.T) {
	app := newAgendaTestApp(t)
	handler := app.Handler(filepath.Join("..", "web", "frontend"))
	when := time.Now().Add(3 * time.Hour).UTC().Format(time.RFC3339)

	body := strings.NewReader(`{"title":"Dentista","event_at":"` + when + `"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/agenda", body)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", response.Code, response.Body.String())
	}
	var created AgendaEvent
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Title != "Dentista" || created.Done {
		t.Fatalf("unexpected event: %#v", created)
	}

	request = httptest.NewRequest(http.MethodPatch, "/api/agenda/"+strconv.FormatInt(created.ID, 10),
		strings.NewReader(`{"done":true}`))
	request.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("patch status = %d, body = %s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if !created.Done {
		t.Fatalf("event was not marked as done: %#v", created)
	}

	request = httptest.NewRequest(http.MethodDelete, "/api/agenda/"+strconv.FormatInt(created.ID, 10), nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", response.Code, response.Body.String())
	}
	if _, err := app.agendaEventByID(created.ID); err == nil {
		t.Fatal("deleted event still exists")
	}
}

func TestAgendaHandlersRejectInvalidInput(t *testing.T) {
	app := newAgendaTestApp(t)
	handler := app.Handler(filepath.Join("..", "web", "frontend"))

	for _, payload := range []string{
		`{"title":"","event_at":"2026-11-20T15:00:00Z"}`,
		`{"title":"Dentista","event_at":"sexta 15h"}`,
		`{"title":"Dentista"}`,
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/agenda", strings.NewReader(payload))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("payload %s status = %d, want 400", payload, response.Code)
		}
	}

	request := httptest.NewRequest(http.MethodPatch, "/api/agenda/999", strings.NewReader(`{"done":true}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing event status = %d, want 404", response.Code)
	}
}

func TestAgendaSettingsRoundTripAndValidation(t *testing.T) {
	app := newAgendaTestApp(t)

	current, err := app.AgendaSettings()
	if err != nil {
		t.Fatal(err)
	}
	if current.ReminderHours != agendaDefaultReminderHours || current.Timezone == "" {
		t.Fatalf("unexpected defaults: %#v", current)
	}

	invalid := current
	invalid.Timezone = "Marte/Olympus"
	if _, err := app.SaveAgendaSettings(invalid); err == nil {
		t.Fatal("invalid timezone should fail")
	}

	valid := current
	valid.ReminderHours = 12
	valid.WeeklyEnabled = false
	valid.Timezone = "America/Sao_Paulo"
	saved, err := app.SaveAgendaSettings(valid)
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := app.AgendaSettings()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.ReminderHours != 12 ||
		reloaded.WeeklyEnabled || reloaded.Timezone != "America/Sao_Paulo" {
		t.Fatalf("settings did not round trip: %#v", reloaded)
	}
	if reloaded != saved {
		t.Fatalf("saved = %#v, reloaded = %#v", saved, reloaded)
	}
}

func TestAgendaNtfyConfigReusesCaptureSettings(t *testing.T) {
	t.Setenv("NTFY_SERVER_URL", "https://ntfy.example.test/")
	t.Setenv("NTFY_USERNAME", "usuario")
	t.Setenv("NTFY_PASSWORD", "senha")
	t.Setenv("NTFY_TOPIC", "captura")
	t.Setenv("AGENDA_NTFY_TOPIC", "agenda")

	config, err := LoadAgendaNtfyConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.ServerURL != "https://ntfy.example.test" || config.Topic != "agenda" ||
		config.Username != "usuario" || config.Password != "senha" {
		t.Fatalf("unexpected config: %#v", config)
	}

	t.Setenv("AGENDA_NTFY_TOPIC", "captura")
	if _, err := LoadAgendaNtfyConfig(); err == nil {
		t.Fatal("topic equal to NTFY_TOPIC should fail")
	}

	t.Setenv("AGENDA_NTFY_TOPIC", "topico inválido")
	if _, err := LoadAgendaNtfyConfig(); err == nil {
		t.Fatal("invalid topic should fail")
	}

	t.Setenv("AGENDA_NTFY_TOPIC", "")
	config, err = LoadAgendaNtfyConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.Topic != "" {
		t.Fatalf("empty topic should disable notifications: %#v", config)
	}
}

func TestAgendaNotifierSendsReminderOnlyOnce(t *testing.T) {
	app := newAgendaTestApp(t)
	sink := newAgendaSink(t)
	now := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	configureAgendaTestNtfy(t, sink.server.URL, "agenda-teste")

	if _, err := app.SaveAgendaSettings(AgendaSettings{
		ReminderHours: 24,
		WeeklyEnabled: false,
		WeeklyDay:     1,
		WeeklyHour:    8,
		Timezone:      "UTC",
	}); err != nil {
		t.Fatal(err)
	}
	createAgendaTestEvent(t, app, "Dentista", now.Add(2*time.Hour))

	notifier := NewAgendaNotifier(app)
	if err := notifier.process(t.Context(), now); err != nil {
		t.Fatal(err)
	}
	published := sink.published()
	if len(published) != 1 {
		t.Fatalf("published = %d, want 1", len(published))
	}
	if published[0].Topic != "agenda-teste" || !strings.Contains(published[0].Message, "Dentista") {
		t.Fatalf("unexpected payload: %#v", published[0])
	}

	if err := notifier.process(t.Context(), now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if len(sink.published()) != 1 {
		t.Fatal("reminder was sent twice")
	}
}

func TestAgendaNotifierResendsAfterReschedule(t *testing.T) {
	app := newAgendaTestApp(t)
	sink := newAgendaSink(t)
	now := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	configureAgendaTestNtfy(t, sink.server.URL, "agenda-teste")

	if _, err := app.SaveAgendaSettings(AgendaSettings{
		ReminderHours: 24,
		WeeklyEnabled: false,
		Timezone:      "UTC",
	}); err != nil {
		t.Fatal(err)
	}
	event := createAgendaTestEvent(t, app, "Consulta", now.Add(2*time.Hour))
	notifier := NewAgendaNotifier(app)
	if err := notifier.process(t.Context(), now); err != nil {
		t.Fatal(err)
	}
	if len(sink.published()) != 1 {
		t.Fatalf("published = %d, want 1", len(sink.published()))
	}

	newTime := now.Add(5 * time.Hour).UTC().Format(time.RFC3339)
	if _, err := app.UpdateAgendaEvent(event.ID, agendaEventPatch{EventAt: &newTime}); err != nil {
		t.Fatal(err)
	}
	if err := notifier.process(t.Context(), now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if len(sink.published()) != 2 {
		t.Fatalf("published = %d after reschedule, want 2", len(sink.published()))
	}
}

func TestAgendaNotifierSkipsEventsOutsideLeadWindow(t *testing.T) {
	app := newAgendaTestApp(t)
	sink := newAgendaSink(t)
	now := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	configureAgendaTestNtfy(t, sink.server.URL, "agenda-teste")

	if _, err := app.SaveAgendaSettings(AgendaSettings{
		ReminderHours: 24,
		WeeklyEnabled: false,
		Timezone:      "UTC",
	}); err != nil {
		t.Fatal(err)
	}
	createAgendaTestEvent(t, app, "Longe", now.Add(48*time.Hour))
	createAgendaTestEvent(t, app, "Já passou", now.Add(-time.Hour))

	notifier := NewAgendaNotifier(app)
	if err := notifier.process(t.Context(), now); err != nil {
		t.Fatal(err)
	}
	if published := sink.published(); len(published) != 0 {
		t.Fatalf("unexpected notifications: %#v", published)
	}
}

func TestAgendaNotifierWeeklySummaryOnce(t *testing.T) {
	app := newAgendaTestApp(t)
	sink := newAgendaSink(t)
	now := time.Date(2026, 11, 16, 8, 5, 0, 0, time.UTC) // Monday.
	configureAgendaTestNtfy(t, sink.server.URL, "agenda-teste")

	if _, err := app.SaveAgendaSettings(AgendaSettings{
		ReminderHours: 1,
		WeeklyEnabled: true,
		WeeklyDay:     1,
		WeeklyHour:    8,
		Timezone:      "UTC",
	}); err != nil {
		t.Fatal(err)
	}
	createAgendaTestEvent(t, app, "Reunião", now.Add(26*time.Hour))
	createAgendaTestEvent(t, app, "Almoço", now.Add(3*time.Hour))

	notifier := NewAgendaNotifier(app)
	if err := notifier.process(t.Context(), now); err != nil {
		t.Fatal(err)
	}
	published := sink.published()
	if len(published) != 1 {
		t.Fatalf("published = %d, want 1", len(published))
	}
	if published[0].Title != "Agenda da semana" ||
		!strings.Contains(published[0].Message, "Reunião") ||
		!strings.Contains(published[0].Message, "Almoço") {
		t.Fatalf("unexpected weekly payload: %#v", published[0])
	}

	if err := notifier.process(t.Context(), now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if len(sink.published()) != 1 {
		t.Fatal("weekly summary was sent twice")
	}
}

func TestAgendaBackupRoundTrip(t *testing.T) {
	app := newAgendaTestApp(t)
	now := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	createAgendaTestEvent(t, app, "Dentista", now.Add(2*time.Hour))
	done := createAgendaTestEvent(t, app, "Consulta", now.Add(26*time.Hour))
	if _, err := app.UpdateAgendaEvent(done.ID, agendaEventPatch{Done: boolPointer(true)}); err != nil {
		t.Fatal(err)
	}

	var archive bytes.Buffer
	if err := app.ExportBackup(&archive); err != nil {
		t.Fatal(err)
	}

	restored := newAgendaTestApp(t)
	if _, _, err := restored.RestoreBackup(archive.Bytes()); err != nil {
		t.Fatal(err)
	}
	list, err := restored.ListAgendaEvents()
	if err != nil {
		t.Fatal(err)
	}
	if list.Total != 2 {
		t.Fatalf("restored events = %d, want 2: %#v", list.Total, list.Items)
	}
	titles := map[string]bool{}
	for _, event := range list.Items {
		titles[event.Title] = event.Done
	}
	if open, exists := titles["Dentista"]; !exists || open {
		t.Fatalf("unexpected restored events: %#v", list.Items)
	}
	if completed, exists := titles["Consulta"]; !exists || !completed {
		t.Fatalf("done flag was not restored: %#v", list.Items)
	}
}

func boolPointer(value bool) *bool {
	return &value
}

func TestAgendaNotifierSkipsWhenDisabled(t *testing.T) {
	app := newAgendaTestApp(t)
	sink := newAgendaSink(t)
	now := time.Now().UTC()
	configureAgendaTestNtfy(t, sink.server.URL, "")

	if _, err := app.SaveAgendaSettings(AgendaSettings{
		ReminderHours: 24,
		WeeklyEnabled: true,
		WeeklyDay:     1,
		WeeklyHour:    8,
		Timezone:      "UTC",
	}); err != nil {
		t.Fatal(err)
	}
	createAgendaTestEvent(t, app, "Nada", now.Add(time.Hour))
	if err := NewAgendaNotifier(app).process(t.Context(), now); err != nil {
		t.Fatal(err)
	}
	if published := sink.published(); len(published) != 0 {
		t.Fatalf("unexpected notifications: %#v", published)
	}
}

func TestAgendaNotifierKeepsReminderWhenPublishFails(t *testing.T) {
	app := newAgendaTestApp(t)
	sink := newAgendaSink(t)
	sink.status = http.StatusInternalServerError
	now := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	configureAgendaTestNtfy(t, sink.server.URL, "agenda-teste")

	if _, err := app.SaveAgendaSettings(AgendaSettings{
		ReminderHours: 24,
		WeeklyEnabled: false,
		Timezone:      "UTC",
	}); err != nil {
		t.Fatal(err)
	}
	createAgendaTestEvent(t, app, "Falha", now.Add(time.Hour))

	notifier := NewAgendaNotifier(app)
	if err := notifier.process(t.Context(), now); err == nil {
		t.Fatal("expected an error when ntfy rejects the message")
	}
	sink.mu.Lock()
	sink.status = http.StatusOK
	sink.mu.Unlock()
	if err := notifier.process(t.Context(), now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if published := sink.published(); len(published) != 2 {
		t.Fatalf("published = %d, want a retry after the failure", len(published))
	}
}
