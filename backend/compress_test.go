package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGzipCompressesStaticFilesAndJSON(t *testing.T) {
	frontend := t.TempDir()
	staticBody := strings.Repeat("console.log('invariante');\n", 128)
	if err := os.MkdirAll(filepath.Join(frontend, "src"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(frontend, "src", "main.js"), []byte(staticBody), 0644); err != nil {
		t.Fatal(err)
	}

	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	handler := app.Handler(frontend)

	request := func(path string, acceptGzip bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if acceptGzip {
			req.Header.Set("Accept-Encoding", "gzip, deflate")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}

	static := request("/src/main.js", true)
	if static.Code != http.StatusOK {
		t.Fatalf("static status = %d", static.Code)
	}
	if encoding := static.Header().Get("Content-Encoding"); encoding != "gzip" {
		t.Fatalf("static Content-Encoding = %q, want gzip", encoding)
	}
	if varying := static.Header().Values("Vary"); !strings.Contains(strings.Join(varying, ","), "Accept-Encoding") {
		t.Fatalf("static Vary = %#v", varying)
	}
	if body := gunzip(t, static.Body.Bytes()); body != staticBody {
		t.Fatalf("static body changed after decompression")
	}

	json := request("/api/notes?limit=1", true)
	if json.Code != http.StatusOK {
		t.Fatalf("json status = %d", json.Code)
	}
	if encoding := json.Header().Get("Content-Encoding"); encoding != "gzip" {
		t.Fatalf("json Content-Encoding = %q, want gzip", encoding)
	}
	if body := gunzip(t, json.Body.Bytes()); !strings.Contains(body, `"items"`) {
		t.Fatalf("json body = %q", body)
	}

	plain := request("/src/main.js", false)
	if encoding := plain.Header().Get("Content-Encoding"); encoding != "" {
		t.Fatalf("plain Content-Encoding = %q, want empty", encoding)
	}
	if plain.Body.String() != staticBody {
		t.Fatalf("plain body changed")
	}
}

func TestGzipHonorsExplicitRefusal(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Accept-Encoding", "gzip;q=0, deflate")
	if acceptsGzip(req) {
		t.Fatal("gzip;q=0 should disable compression")
	}
}

func TestGzipSkipsAttachmentDownloads(t *testing.T) {
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	handler := app.Handler(t.TempDir())

	req := httptest.NewRequest(http.MethodGet, "/api/notes/1/attachments/1", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusNotFound {
		t.Fatalf("attachment status = %d", response.Code)
	}
	if encoding := response.Header().Get("Content-Encoding"); encoding != "" {
		t.Fatalf("attachment Content-Encoding = %q, want empty", encoding)
	}
}

func gunzip(t *testing.T, data []byte) string {
	t.Helper()
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
