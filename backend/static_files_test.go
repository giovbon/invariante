package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStaticFilesExposeOnlyPublicFrontendPaths(t *testing.T) {
	frontend := t.TempDir()
	files := map[string]string{
		"index.html":                      "<!doctype html>",
		"login.html":                      "<!doctype html>",
		"src/main.js":                     "console.log('app')",
		"src/lib/markdown-editor.js":      "export {}",
		"src/lib/markdown-editor.test.js": "test",
		"styles/base.css":                 "body{}",
		"vendor/highlight.js/x.js":        "hljs",
		"assets/brand/logo.svg":           "<svg/>",
		".auth/state.json":                `{"cookies":[{"name":"pkm_notes_session"}]}`,
		"node_modules/pkg/index.js":       "module",
		"package.json":                    "{}",
		"playwright.config.js":            "export default {}",
		"e2e/notes.spec.js":               "test",
		"test-results/.last-run.json":     "{}",
	}
	for name, content := range files {
		full := filepath.Join(frontend, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}

	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	handler := app.Handler(frontend)

	allowed := []string{
		"/", "/index.html", "/login.html", "/src/main.js",
		"/src/lib/markdown-editor.js", "/styles/base.css",
		"/vendor/highlight.js/x.js", "/assets/brand/logo.svg",
	}
	for _, path := range allowed {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200", path, response.Code)
		}
	}

	blocked := []string{
		"/.auth/state.json",
		"/node_modules/pkg/index.js",
		"/package.json",
		"/playwright.config.js",
		"/e2e/notes.spec.js",
		"/test-results/.last-run.json",
		"/src/lib/markdown-editor.test.js",
	}
	for _, path := range blocked {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("GET %s status = %d, want 404", path, response.Code)
		}
		if strings.Contains(response.Body.String(), "pkm_notes_session") {
			t.Fatalf("GET %s leaked session data", path)
		}
	}

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/src/main.js", nil))
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("static response has no ETag")
	}
	if cacheControl := first.Header().Get("Cache-Control"); cacheControl != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache", cacheControl)
	}
	conditional := httptest.NewRequest(http.MethodGet, "/src/main.js", nil)
	conditional.Header.Set("If-None-Match", etag)
	second := httptest.NewRecorder()
	handler.ServeHTTP(second, conditional)
	if second.Code != http.StatusNotModified {
		t.Fatalf("conditional status = %d, want 304", second.Code)
	}
	if second.Body.Len() != 0 {
		t.Fatalf("304 response carried a body: %q", second.Body.String())
	}

	directory := httptest.NewRecorder()
	handler.ServeHTTP(directory, httptest.NewRequest(http.MethodGet, "/src/", nil))
	if directory.Code != http.StatusNotFound {
		t.Fatalf("directory listing status = %d, want 404", directory.Code)
	}
}
