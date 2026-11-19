package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	// Embed the IANA database so the weekly summary keeps the right local
	// time on minimal images that ship without /usr/share/zoneinfo.
	_ "time/tzdata"
)

const (
	agendaSettingsKey          = "agenda_settings"
	agendaDefaultTimezone      = "America/Sao_Paulo"
	agendaDefaultReminderHours = 24
	agendaDefaultWeeklyDay     = 1 // Monday, ISO numbering.
	agendaDefaultWeeklyHour    = 8
	agendaMaxTitleRunes        = 500
	agendaMaxEvents            = 5000
	agendaReminderKind         = "reminder"
	agendaWeeklyKind           = "weekly"
	agendaCheckInterval        = time.Minute
	agendaInitialDelay         = 20 * time.Second
	agendaMaxMessageBytes      = 3500
)

var agendaTopicPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// AgendaSettings holds the reminder preferences. They live in app_settings
// instead of the environment so the settings panel can change them without
// restarting the container. AGENDA_* environment variables act as defaults
// for a fresh installation.
//
// The ntfy destination is deliberately not part of these settings: the topic
// comes from AGENDA_NTFY_TOPIC and the server/credentials are reused from the
// capture configuration (NTFY_SERVER_URL, NTFY_USERNAME, NTFY_PASSWORD), so
// the panel never has to store them.
type AgendaSettings struct {
	ReminderHours int    `json:"reminder_hours"`
	WeeklyEnabled bool   `json:"weekly_enabled"`
	WeeklyDay     int    `json:"weekly_day"`
	WeeklyHour    int    `json:"weekly_hour"`
	Timezone      string `json:"timezone"`
}

// AgendaNtfyConfig is the environment-driven ntfy destination used by the
// agenda notifier. An empty Topic disables the notifications.
type AgendaNtfyConfig struct {
	ServerURL string
	Topic     string
	Username  string
	Password  string
}

type AgendaEvent struct {
	ID        int64  `json:"id"`
	Title     string `json:"title"`
	EventAt   string `json:"event_at"`
	Done      bool   `json:"done"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type AgendaList struct {
	Items      []AgendaEvent `json:"items"`
	Total      int           `json:"total"`
	ServerTime string        `json:"server_time"`
}

type agendaEventInput struct {
	Title   string `json:"title"`
	EventAt string `json:"event_at"`
}

// agendaEventPatch keeps every field optional so the panel can toggle "done"
// without having to resend the title and the date.
type agendaEventPatch struct {
	Title   *string `json:"title"`
	EventAt *string `json:"event_at"`
	Done    *bool   `json:"done"`
}

func defaultAgendaSettings() AgendaSettings {
	settings := AgendaSettings{
		ReminderHours: agendaDefaultReminderHours,
		WeeklyEnabled: true,
		WeeklyDay:     agendaDefaultWeeklyDay,
		WeeklyHour:    agendaDefaultWeeklyHour,
		Timezone:      strings.TrimSpace(os.Getenv("AGENDA_TIMEZONE")),
	}
	if settings.Timezone == "" {
		settings.Timezone = agendaDefaultTimezone
	}
	if raw := strings.TrimSpace(os.Getenv("AGENDA_REMINDER_HOURS")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil {
			settings.ReminderHours = value
		}
	}
	if raw := strings.TrimSpace(os.Getenv("AGENDA_WEEKLY_ENABLED")); raw != "" {
		if value, err := strconv.ParseBool(raw); err == nil {
			settings.WeeklyEnabled = value
		}
	}
	if raw := strings.TrimSpace(os.Getenv("AGENDA_WEEKLY_DAY")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil {
			settings.WeeklyDay = value
		}
	}
	if raw := strings.TrimSpace(os.Getenv("AGENDA_WEEKLY_HOUR")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil {
			settings.WeeklyHour = value
		}
	}
	return settings
}

// AgendaSettings returns the stored preferences with defaults applied. A
// malformed stored value falls back to the defaults instead of breaking the
// notifier or the settings panel.
func (a *App) AgendaSettings() (AgendaSettings, error) {
	settings := defaultAgendaSettings()
	var raw string
	err := a.readDB.QueryRow("SELECT value FROM app_settings WHERE key = ?", agendaSettingsKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return normalizeAgendaSettings(settings), nil
	}
	if err != nil {
		return AgendaSettings{}, err
	}
	if err := json.Unmarshal([]byte(raw), &settings); err != nil {
		log.Printf("ignore invalid agenda settings: %v", err)
		return normalizeAgendaSettings(defaultAgendaSettings()), nil
	}
	return normalizeAgendaSettings(settings), nil
}

func normalizeAgendaSettings(settings AgendaSettings) AgendaSettings {
	settings.Timezone = strings.TrimSpace(settings.Timezone)
	if settings.Timezone == "" {
		settings.Timezone = agendaDefaultTimezone
	}
	if settings.ReminderHours < 1 {
		settings.ReminderHours = agendaDefaultReminderHours
	}
	if settings.WeeklyDay < 1 || settings.WeeklyDay > 7 {
		settings.WeeklyDay = agendaDefaultWeeklyDay
	}
	if settings.WeeklyHour < 0 || settings.WeeklyHour > 23 {
		settings.WeeklyHour = agendaDefaultWeeklyHour
	}
	return settings
}

func validateAgendaSettings(settings AgendaSettings) error {
	if settings.ReminderHours < 1 || settings.ReminderHours > 168 {
		return errors.New("o aviso antecipado deve ficar entre 1 e 168 horas")
	}
	if settings.WeeklyDay < 1 || settings.WeeklyDay > 7 {
		return errors.New("o dia do resumo semanal deve ficar entre 1 (segunda) e 7 (domingo)")
	}
	if settings.WeeklyHour < 0 || settings.WeeklyHour > 23 {
		return errors.New("a hora do resumo semanal deve ficar entre 0 e 23")
	}
	if _, err := time.LoadLocation(settings.Timezone); err != nil {
		return fmt.Errorf("fuso horário inválido: %q", settings.Timezone)
	}
	return nil
}

// LoadAgendaNtfyConfig reads the agenda notification destination from the
// environment. It reuses the capture server and credentials (NTFY_*), so the
// only agenda-specific variable is AGENDA_NTFY_TOPIC. An empty topic disables
// the notifications instead of failing.
func LoadAgendaNtfyConfig() (AgendaNtfyConfig, error) {
	config := AgendaNtfyConfig{
		ServerURL: strings.TrimSpace(os.Getenv("NTFY_SERVER_URL")),
		Topic:     strings.TrimSpace(os.Getenv("AGENDA_NTFY_TOPIC")),
		Username:  strings.TrimSpace(os.Getenv("NTFY_USERNAME")),
		Password:  os.Getenv("NTFY_PASSWORD"),
	}
	if config.ServerURL == "" {
		config.ServerURL = ntfyDefaultServerURL
	}
	config.ServerURL = strings.TrimRight(config.ServerURL, "/")
	if config.Topic == "" {
		return config, nil
	}
	if !agendaTopicPattern.MatchString(config.Topic) {
		return config, errors.New("AGENDA_NTFY_TOPIC deve ter de 1 a 64 caracteres: letras, números, hífen e sublinhado")
	}
	if capture := strings.TrimSpace(os.Getenv("NTFY_TOPIC")); capture != "" && config.Topic == capture {
		return config, errors.New("AGENDA_NTFY_TOPIC deve ser diferente de NTFY_TOPIC para os avisos não virarem notas")
	}
	if _, err := parseNtfyServerURL(config.ServerURL); err != nil {
		return config, err
	}
	if strings.ContainsAny(config.Username, "\r\n") || strings.ContainsAny(config.Password, "\r\n") {
		return config, errors.New("usuário e senha do ntfy não podem conter quebras de linha")
	}
	return config, nil
}

// agendaSettingsView adds the read-only ntfy status that comes from the
// environment, so the settings panel can explain why notifications are off
// without offering editable fields for the server or credentials.
type agendaSettingsView struct {
	AgendaSettings
	NtfyTopic      string `json:"ntfy_topic"`
	NtfyConfigured bool   `json:"ntfy_configured"`
	NtfyError      string `json:"ntfy_error,omitempty"`
}

func newAgendaSettingsView(settings AgendaSettings) agendaSettingsView {
	view := agendaSettingsView{AgendaSettings: settings}
	config, err := LoadAgendaNtfyConfig()
	if err != nil {
		view.NtfyError = err.Error()
		return view
	}
	view.NtfyTopic = config.Topic
	view.NtfyConfigured = config.Topic != ""
	return view
}

func (a *App) SaveAgendaSettings(settings AgendaSettings) (AgendaSettings, error) {
	settings = normalizeAgendaSettings(settings)
	if err := validateAgendaSettings(settings); err != nil {
		return AgendaSettings{}, err
	}
	encoded, err := json.Marshal(settings)
	if err != nil {
		return AgendaSettings{}, err
	}
	_, err = a.db.Exec(`INSERT INTO app_settings(key, value, updated_at)
		VALUES (?, ?, datetime('now'))
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
		agendaSettingsKey, string(encoded))
	if err != nil {
		return AgendaSettings{}, err
	}
	return settings, nil
}

func (a *App) handleAgendaSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		settings, err := a.AgendaSettings()
		if err != nil {
			log.Printf("load agenda settings: %v", err)
			http.Error(w, "failed to load agenda settings", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, newAgendaSettingsView(settings))
	case http.MethodPut:
		var request AgendaSettings
		if err := decodeJSON(w, r, &request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		settings, err := a.SaveAgendaSettings(request)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, newAgendaSettingsView(settings))
	default:
		methodNotAllowed(w)
	}
}

func normalizeAgendaTitle(raw string) (string, error) {
	title := strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ", "\t", " ").Replace(raw))
	title = strings.Join(strings.Fields(title), " ")
	if title == "" {
		return "", errors.New("escreva o compromisso")
	}
	if len([]rune(title)) > agendaMaxTitleRunes {
		return "", fmt.Errorf("o compromisso deve ter no máximo %d caracteres", agendaMaxTitleRunes)
	}
	for _, character := range title {
		if character < 0x20 || character == 0x7f {
			return "", errors.New("o compromisso contém caracteres inválidos")
		}
	}
	return title, nil
}

func parseAgendaTime(raw string) (time.Time, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return time.Time{}, errors.New("informe a data do compromisso")
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, errors.New("data inválida: use o formato ISO 8601")
	}
	if parsed.Year() < 1900 || parsed.Year() > 2200 {
		return time.Time{}, errors.New("ano fora do intervalo aceito")
	}
	return parsed.UTC(), nil
}

func (a *App) ListAgendaEvents() (AgendaList, error) {
	rows, err := a.readDB.Query(`SELECT id, title, event_at, done, created_at, updated_at
		FROM agenda_events ORDER BY event_at ASC, id ASC LIMIT ?`, agendaMaxEvents)
	if err != nil {
		return AgendaList{}, err
	}
	defer rows.Close()

	now := time.Now()
	future := make([]AgendaEvent, 0, 16)
	past := make([]AgendaEvent, 0, 16)
	for rows.Next() {
		var event AgendaEvent
		var stamp int64
		var done int
		if err := rows.Scan(&event.ID, &event.Title, &stamp, &done, &event.CreatedAt, &event.UpdatedAt); err != nil {
			return AgendaList{}, err
		}
		event.Done = done != 0
		event.EventAt = time.Unix(stamp, 0).UTC().Format(time.RFC3339)
		if !time.Unix(stamp, 0).Before(now) {
			future = append(future, event)
		} else {
			past = append(past, event)
		}
	}
	if err := rows.Err(); err != nil {
		return AgendaList{}, err
	}
	// Future events read top-down; past events read bottom-up so the most
	// recent history stays close to the upcoming list.
	sort.Slice(past, func(i, j int) bool {
		left, _ := time.Parse(time.RFC3339, past[i].EventAt)
		right, _ := time.Parse(time.RFC3339, past[j].EventAt)
		return left.After(right)
	})
	items := append(future, past...)
	return AgendaList{Items: items, Total: len(items), ServerTime: time.Now().UTC().Format(time.RFC3339)}, nil
}

func (a *App) agendaEventByID(id int64) (AgendaEvent, error) {
	var event AgendaEvent
	var stamp int64
	var done int
	err := a.db.QueryRow(`SELECT id, title, event_at, done, created_at, updated_at
		FROM agenda_events WHERE id = ?`, id).
		Scan(&event.ID, &event.Title, &stamp, &done, &event.CreatedAt, &event.UpdatedAt)
	if err != nil {
		return AgendaEvent{}, err
	}
	event.Done = done != 0
	event.EventAt = time.Unix(stamp, 0).UTC().Format(time.RFC3339)
	return event, nil
}

func (a *App) CreateAgendaEvent(input agendaEventInput) (AgendaEvent, error) {
	title, err := normalizeAgendaTitle(input.Title)
	if err != nil {
		return AgendaEvent{}, err
	}
	when, err := parseAgendaTime(input.EventAt)
	if err != nil {
		return AgendaEvent{}, err
	}
	result, err := a.db.Exec(`INSERT INTO agenda_events(title, event_at, done, created_at, updated_at)
		VALUES (?, ?, 0, datetime('now'), datetime('now'))`, title, when.Unix())
	if err != nil {
		return AgendaEvent{}, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return AgendaEvent{}, err
	}
	return a.agendaEventByID(id)
}

func (a *App) UpdateAgendaEvent(id int64, patch agendaEventPatch) (AgendaEvent, error) {
	event, err := a.agendaEventByID(id)
	if err != nil {
		return AgendaEvent{}, err
	}
	if patch.Title != nil {
		title, err := normalizeAgendaTitle(*patch.Title)
		if err != nil {
			return AgendaEvent{}, err
		}
		event.Title = title
	}
	if patch.EventAt != nil {
		when, err := parseAgendaTime(*patch.EventAt)
		if err != nil {
			return AgendaEvent{}, err
		}
		event.EventAt = when.UTC().Format(time.RFC3339)
	}
	if patch.Done != nil {
		event.Done = *patch.Done
	}
	if patch.Title == nil && patch.EventAt == nil && patch.Done == nil {
		return AgendaEvent{}, errors.New("nenhuma alteração informada")
	}
	when, err := time.Parse(time.RFC3339, event.EventAt)
	if err != nil {
		return AgendaEvent{}, err
	}
	done := 0
	if event.Done {
		done = 1
	}
	if _, err := a.db.Exec(`UPDATE agenda_events
		SET title = ?, event_at = ?, done = ?, updated_at = datetime('now') WHERE id = ?`,
		event.Title, when.Unix(), done, id); err != nil {
		return AgendaEvent{}, err
	}
	// A rescheduled or reopened event deserves a fresh reminder.
	a.clearAgendaNotifications(id)
	return a.agendaEventByID(id)
}

func (a *App) DeleteAgendaEvent(id int64) error {
	result, err := a.db.Exec("DELETE FROM agenda_events WHERE id = ?", id)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return sql.ErrNoRows
	}
	a.clearAgendaNotifications(id)
	return nil
}

func (a *App) clearAgendaNotifications(id int64) {
	if _, err := a.db.Exec("DELETE FROM agenda_notifications WHERE event_id = ?", id); err != nil {
		log.Printf("clear agenda notifications for event %d: %v", id, err)
	}
}

func parseAgendaEventPath(rawPath string) (int64, error) {
	value := strings.TrimPrefix(rawPath, "/api/agenda/")
	if value == "" || strings.Contains(value, "/") {
		return 0, errors.New("invalid agenda event path")
	}
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id < 1 {
		return 0, errors.New("invalid agenda event ID")
	}
	return id, nil
}

func (a *App) handleAgenda(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		list, err := a.ListAgendaEvents()
		if err != nil {
			log.Printf("list agenda: %v", err)
			http.Error(w, "failed to load agenda", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, list)
	case http.MethodPost:
		var request agendaEventInput
		if err := decodeJSON(w, r, &request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		event, err := a.CreateAgendaEvent(request)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusCreated, event)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) handleAgendaEvent(w http.ResponseWriter, r *http.Request) {
	id, err := parseAgendaEventPath(r.URL.Path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodPatch:
		var patch agendaEventPatch
		if err := decodeJSON(w, r, &patch); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		event, err := a.UpdateAgendaEvent(id, patch)
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "agenda event not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, event)
	case http.MethodDelete:
		if err := a.DeleteAgendaEvent(id); errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "agenda event not found", http.StatusNotFound)
			return
		} else if err != nil {
			log.Printf("delete agenda event %d: %v", id, err)
			http.Error(w, "failed to delete agenda event", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		methodNotAllowed(w)
	}
}

// AgendaNotifier checks the agenda every minute and publishes the reminder
// and the weekly summary through ntfy. Every send is recorded in
// agenda_notifications so restarts and multiple replicas never repeat a
// message.
type AgendaNotifier struct {
	app    *App
	client *http.Client
}

func NewAgendaNotifier(app *App) *AgendaNotifier {
	return &AgendaNotifier{
		app:    app,
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (n *AgendaNotifier) Run(ctx context.Context) error {
	timer := time.NewTimer(agendaInitialDelay)
	defer timer.Stop()
	ticker := time.NewTicker(agendaCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
		case <-ticker.C:
		}
		if err := n.process(ctx, time.Now()); err != nil {
			log.Printf("agenda notifier: %v", err)
		}
	}
}

func (n *AgendaNotifier) process(ctx context.Context, now time.Time) error {
	settings, err := n.app.AgendaSettings()
	if err != nil {
		return fmt.Errorf("load settings: %w", err)
	}
	config, err := LoadAgendaNtfyConfig()
	if err != nil {
		return fmt.Errorf("load ntfy config: %w", err)
	}
	if config.Topic == "" {
		return nil
	}
	location, err := time.LoadLocation(settings.Timezone)
	if err != nil {
		location = time.UTC
	}
	var failures []error
	if err := n.sendReminders(ctx, settings, config, location, now); err != nil {
		failures = append(failures, err)
	}
	if settings.WeeklyEnabled {
		if err := n.sendWeeklySummary(ctx, settings, config, location, now); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (n *AgendaNotifier) sendReminders(ctx context.Context, settings AgendaSettings, config AgendaNtfyConfig, location *time.Location, now time.Time) error {
	deadline := now.Add(time.Duration(settings.ReminderHours) * time.Hour)
	rows, err := n.app.readDB.Query(`SELECT e.id, e.title, e.event_at
		FROM agenda_events e
		WHERE e.done = 0 AND e.event_at >= ? AND e.event_at <= ?
			AND NOT EXISTS (
				SELECT 1 FROM agenda_notifications n
				WHERE n.event_id = e.id AND n.kind = ?
			)
		ORDER BY e.event_at ASC`, now.Unix(), deadline.Unix(), agendaReminderKind)
	if err != nil {
		return fmt.Errorf("load reminders: %w", err)
	}
	defer rows.Close()

	type reminder struct {
		id    int64
		title string
		when  time.Time
	}
	reminders := make([]reminder, 0, 4)
	for rows.Next() {
		var item reminder
		var stamp int64
		if err := rows.Scan(&item.id, &item.title, &stamp); err != nil {
			return err
		}
		item.when = time.Unix(stamp, 0).In(location)
		reminders = append(reminders, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	var failures []error
	for _, item := range reminders {
		title := truncateNtfyTitle("Lembrete: " + item.title)
		message := truncateNtfyText(fmt.Sprintf("%s\n%s", item.title, formatAgendaDateTime(item.when)), agendaMaxMessageBytes)
		if err := n.publish(ctx, config, title, message, []string{"calendar"}, 4); err != nil {
			failures = append(failures, fmt.Errorf("event %d: %w", item.id, err))
			continue
		}
		key := fmt.Sprintf("event:%d:%s", item.id, agendaReminderKind)
		if _, err := n.app.db.Exec(`INSERT OR IGNORE INTO agenda_notifications(dedup_key, event_id, kind, sent_at)
			VALUES (?, ?, ?, datetime('now'))`, key, item.id, agendaReminderKind); err != nil {
			failures = append(failures, fmt.Errorf("record reminder %d: %w", item.id, err))
		}
	}
	return errors.Join(failures...)
}

func (n *AgendaNotifier) sendWeeklySummary(ctx context.Context, settings AgendaSettings, config AgendaNtfyConfig, location *time.Location, now time.Time) error {
	local := now.In(location)
	if isoWeekday(local) != settings.WeeklyDay || local.Hour() < settings.WeeklyHour {
		return nil
	}
	weekStart := startOfAgendaWeek(local)
	key := "week:" + weekStart.Format("2006-01-02")
	var exists int
	if err := n.app.readDB.QueryRow("SELECT COUNT(*) FROM agenda_notifications WHERE dedup_key = ?", key).Scan(&exists); err != nil {
		return fmt.Errorf("check weekly summary: %w", err)
	}
	if exists != 0 {
		return nil
	}

	from := now
	if from.Before(weekStart) {
		from = weekStart
	}
	weekEnd := weekStart.AddDate(0, 0, 7)
	rows, err := n.app.readDB.Query(`SELECT title, event_at FROM agenda_events
		WHERE done = 0 AND event_at >= ? AND event_at < ?
		ORDER BY event_at ASC`, from.Unix(), weekEnd.Unix())
	if err != nil {
		return fmt.Errorf("load weekly agenda: %w", err)
	}
	defer rows.Close()

	lines := make([]string, 0, 16)
	for rows.Next() {
		var title string
		var stamp int64
		if err := rows.Scan(&title, &stamp); err != nil {
			return err
		}
		lines = append(lines, fmt.Sprintf("• %s — %s",
			formatAgendaDay(time.Unix(stamp, 0).In(location)), title))
	}
	if err := rows.Err(); err != nil {
		return err
	}

	if len(lines) > 0 {
		title := "Agenda da semana"
		message := truncateNtfyText(strings.Join(lines, "\n"), agendaMaxMessageBytes)
		if err := n.publish(ctx, config, title, message, []string{"calendar", "date"}, 3); err != nil {
			return err
		}
	}
	// Record the attempt even when the week is empty: an empty summary is not
	// worth a notification, and later events already have their own reminders.
	if _, err := n.app.db.Exec(`INSERT OR IGNORE INTO agenda_notifications(dedup_key, event_id, kind, sent_at)
		VALUES (?, NULL, ?, datetime('now'))`, key, agendaWeeklyKind); err != nil {
		return fmt.Errorf("record weekly summary: %w", err)
	}
	return nil
}

func (n *AgendaNotifier) publish(ctx context.Context, config AgendaNtfyConfig, title, message string, tags []string, priority int) error {
	serverURL, err := parseNtfyServerURL(config.ServerURL)
	if err != nil {
		return err
	}
	payload := map[string]any{
		"topic":   config.Topic,
		"title":   title,
		"message": message,
	}
	if len(tags) > 0 {
		payload["tags"] = tags
	}
	if priority > 0 {
		payload["priority"] = priority
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	endpoint := strings.TrimRight(serverURL.String(), "/") + "/"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if config.Username != "" {
		request.SetBasicAuth(config.Username, config.Password)
	}
	response, err := n.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("ntfy respondeu %s", response.Status)
	}
	return nil
}

func isoWeekday(value time.Time) int {
	weekday := int(value.Weekday())
	if weekday == 0 {
		return 7
	}
	return weekday
}

// startOfAgendaWeek returns Monday at 00:00 in the value's location.
func startOfAgendaWeek(value time.Time) time.Time {
	day := time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, value.Location())
	return day.AddDate(0, 0, -(isoWeekday(day) - 1))
}

var agendaWeekdays = [...]string{"dom", "seg", "ter", "qua", "qui", "sex", "sáb"}

func formatAgendaDateTime(value time.Time) string {
	return fmt.Sprintf("%s, %02d/%02d às %02d:%02d",
		agendaWeekdays[int(value.Weekday())], value.Day(), int(value.Month()), value.Hour(), value.Minute())
}

func formatAgendaDay(value time.Time) string {
	return fmt.Sprintf("%s %02d/%02d", agendaWeekdays[int(value.Weekday())], value.Day(), int(value.Month()))
}
