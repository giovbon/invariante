package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHelpRendersMarkdownFromProjectRoot(t *testing.T) {
	root := t.TempDir()
	frontend := filepath.Join(root, "web", "frontend")
	if err := os.MkdirAll(frontend, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "HELP.md"), []byte("# Central de ajuda\n\nUse **Ctrl+K** para buscar."), 0644); err != nil {
		t.Fatal(err)
	}

	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	response := httptest.NewRecorder()
	app.Handler(frontend).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/help", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/help status = %d, want 200; body = %q", response.Code, response.Body.String())
	}
	if contentType := response.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "text/html") {
		t.Fatalf("Content-Type = %q, want text/html", contentType)
	}
	body := response.Body.String()
	for _, want := range []string{"<h1", "Central de ajuda", "<strong>Ctrl+K</strong>"} {
		if !strings.Contains(body, want) {
			t.Fatalf("response does not contain %q: %s", want, body)
		}
	}
}

func TestHelpMissingFileReturnsNotFound(t *testing.T) {
	root := t.TempDir()
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	response := httptest.NewRecorder()
	app.Handler(filepath.Join(root, "web", "frontend")).
		ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/help", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("GET /api/help status = %d, want 404", response.Code)
	}
}

func TestHelpRejectsNonGetMethods(t *testing.T) {
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	response := httptest.NewRecorder()
	app.Handler(filepath.Join("..", "web", "frontend")).
		ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/help", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /api/help status = %d, want 405", response.Code)
	}
}
