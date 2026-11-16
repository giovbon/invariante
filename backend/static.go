package main

import (
	"fmt"
	"net/http"
	"path"
	"strings"
)

// publicFrontendFiles restricts the static file server to the assets that the
// browser actually needs. The frontend directory also holds development-only
// files (node_modules, Playwright specs, test results and .auth/state.json
// with a real session cookie), so serving it wholesale would leak credentials
// and test data in a local installation.
func publicFrontendFiles(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isPublicFrontendPath(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isPublicFrontendPath(value string) bool {
	cleaned := path.Clean("/" + value)
	if cleaned == "/" || cleaned == "/index.html" || cleaned == "/login.html" {
		return true
	}
	for _, prefix := range []string{"/assets/", "/styles/", "/vendor/", "/src/"} {
		if !strings.HasPrefix(cleaned, prefix) {
			continue
		}
		// Unit tests live under src/ and are not part of the application.
		return !strings.HasSuffix(cleaned, ".test.js")
	}
	return false
}

// staticFiles serves the allowlisted frontend files with a nanosecond ETag.
// Last-Modified alone has one-second resolution, which is not enough while the
// server is being rebuilt in place: two different bundles can share a
// timestamp and the browser would keep the stale one.
func staticFiles(root string) http.Handler {
	fs := http.Dir(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			methodNotAllowed(w)
			return
		}
		cleaned := path.Clean("/" + r.URL.Path)
		if cleaned == "/" {
			cleaned = "/index.html"
		}
		file, err := fs.Open(cleaned)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		etag := fmt.Sprintf(`W/"%x-%x"`, info.ModTime().UnixNano(), info.Size())
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Vary", "Accept-Encoding")
		if header := r.Header.Get("If-None-Match"); header != "" {
			if etagMatches(header, etag) {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			// A present but non-matching validator takes precedence over the
			// coarser If-Modified-Since header.
			r.Header.Del("If-Modified-Since")
		}
		http.ServeContent(w, r, info.Name(), info.ModTime(), file)
	})
}

func etagMatches(header, etag string) bool {
	weak := strings.TrimPrefix(etag, "W/")
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || strings.TrimPrefix(candidate, "W/") == weak {
			return true
		}
	}
	return false
}
