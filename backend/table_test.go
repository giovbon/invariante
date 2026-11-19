package main

import (
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestFrontmatterProperties(t *testing.T) {
	content := `---
title: ignored
status: ativo
priority: 2
draft: false
tags: [projeto, "referência"]
owner:
  name: Ana
  team: Produto
steps:
  - primeiro
  - segundo
notes: |
  linha um
  linha dois
---

Corpo da nota.`
	properties := frontmatterProperties(content)

	if got := properties["status"]; got != "ativo" {
		t.Fatalf("status = %#v", got)
	}
	if got := properties["priority"]; got != int64(2) {
		t.Fatalf("priority = %#v", got)
	}
	if got := properties["draft"]; got != false {
		t.Fatalf("draft = %#v", got)
	}
	tags, ok := properties["tags"].([]any)
	if !ok || len(tags) != 2 || tags[0] != "projeto" || tags[1] != "referência" {
		t.Fatalf("tags = %#v", properties["tags"])
	}
	owner, ok := properties["owner"].(map[string]any)
	if !ok || owner["name"] != "Ana" || owner["team"] != "Produto" {
		t.Fatalf("owner = %#v", properties["owner"])
	}
	steps, ok := properties["steps"].([]any)
	if !ok || len(steps) != 2 || steps[1] != "segundo" {
		t.Fatalf("steps = %#v", properties["steps"])
	}
	if got := properties["notes"]; got != "linha um\nlinha dois" {
		t.Fatalf("notes = %#v", got)
	}
	if properties["title"] != "ignored" {
		t.Fatalf("title property = %#v", properties["title"])
	}
}

func TestTableHandlerReturnsPropertiesAndAttachments(t *testing.T) {
	app := newTestApp(t)
	handler := app.Handler(filepath.Join("..", "web", "frontend"))

	noteID, err := app.CreateNote(Note{
		Title:  "Plano",
		Folder: "Projetos",
		Content: `---
status: ativo
prioridade: alta
tags: [projeto, sqlite]
---
Corpo`,
	})
	if err != nil {
		t.Fatal(err)
	}
	attachment, err := app.SaveAttachment(noteID, strings.NewReader("conteúdo"), "diagrama.png")
	if err != nil {
		t.Fatal(err)
	}

	response := performJSONRequest(t, handler, http.MethodGet, "/api/table?folder=Projetos", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	payload := decodeResponse[struct {
		Items []TableNote `json:"items"`
	}](t, response)
	if len(payload.Items) != 1 {
		t.Fatalf("items = %#v", payload.Items)
	}
	item := payload.Items[0]
	if item.Title != "Plano" || item.Folder != "Projetos" {
		t.Fatalf("unexpected note: %#v", item)
	}
	if item.Properties["status"] != "ativo" || item.Properties["prioridade"] != "alta" {
		t.Fatalf("properties = %#v", item.Properties)
	}
	if len(item.Attachments) != 1 || item.Attachments[0].ID != attachment.ID {
		t.Fatalf("attachments = %#v", item.Attachments)
	}
	if item.Attachments[0].URL == "" {
		t.Fatalf("attachment URL is empty")
	}
}

func TestTableEndpointPaginates(t *testing.T) {
	app := newTestApp(t)
	handler := app.Handler(filepath.Join("..", "web", "frontend"))
	for index := 1; index <= 5; index++ {
		if _, err := app.CreateNote(Note{Title: "Nota " + strconv.Itoa(index), Content: "corpo"}); err != nil {
			t.Fatal(err)
		}
	}
	response := performJSONRequest(t, handler, http.MethodGet, "/api/table?limit=2&offset=2", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	payload := decodeResponse[struct {
		Items     []TableNote `json:"items"`
		Total     int         `json:"total"`
		Limit     int         `json:"limit"`
		Offset    int         `json:"offset"`
		Truncated bool        `json:"truncated"`
	}](t, response)
	if payload.Total != 5 || len(payload.Items) != 2 || payload.Limit != 2 || payload.Offset != 2 {
		t.Fatalf("payload = %#v", payload)
	}
	if !payload.Truncated {
		t.Fatal("expected truncated flag")
	}
}

func TestTableColumnSettingsPersistAcrossBrowsers(t *testing.T) {
	dataDir := t.TempDir()
	app, err := NewApp(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	handler := app.Handler(filepath.Join("..", "web", "frontend"))

	initial := performJSONRequest(t, handler, http.MethodGet, "/api/table-columns", nil)
	if initial.Code != http.StatusOK {
		t.Fatalf("initial status = %d, body = %s", initial.Code, initial.Body.String())
	}
	initialPayload := decodeResponse[TableColumnSettings](t, initial)
	if initialPayload.Configured || len(initialPayload.Hidden) != 0 {
		t.Fatalf("unexpected initial settings: %#v", initialPayload)
	}

	saved := performJSONRequest(t, handler, http.MethodPut, "/api/table-columns",
		map[string]any{"hidden": []string{" status ", "autor", "status", "  "}})
	if saved.Code != http.StatusOK {
		t.Fatalf("save status = %d, body = %s", saved.Code, saved.Body.String())
	}
	savedPayload := decodeResponse[TableColumnSettings](t, saved)
	if !savedPayload.Configured || len(savedPayload.Hidden) != 2 ||
		savedPayload.Hidden[0] != "status" || savedPayload.Hidden[1] != "autor" {
		t.Fatalf("unexpected saved settings: %#v", savedPayload)
	}

	tooLong := strings.Repeat("a", maxTableColumnKeyLength+1)
	invalid := performJSONRequest(t, handler, http.MethodPut, "/api/table-columns",
		map[string]any{"hidden": []string{tooLong}})
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid status = %d", invalid.Code)
	}

	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewApp(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	settings, err := reopened.TableColumnSettings()
	if err != nil {
		t.Fatal(err)
	}
	if !settings.Configured || len(settings.Hidden) != 2 || settings.Hidden[1] != "autor" {
		t.Fatalf("settings did not survive reopening: %#v", settings)
	}
}
