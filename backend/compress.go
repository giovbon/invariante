package main

import (
	"compress/gzip"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// gzipWriters reuses the ~32 KB internal buffer of each gzip.Writer. JSON and
// JavaScript responses are frequent, and allocating a new writer per request
// showed up in the allocation profile. Level 5 keeps most of the compression
// ratio with less CPU than the default level.
var gzipWriters = sync.Pool{
	New: func() any {
		writer, err := gzip.NewWriterLevel(io.Discard, 5)
		if err != nil {
			panic(err)
		}
		return writer
	},
}

// gzipResponses compresses text and JSON responses when the client accepts
// gzip. The mini app ships ~800 KB of JavaScript and CSS, so this cuts the
// initial transfer to roughly a quarter. Ranges and downloads are skipped
// because compressing them would break Content-Length/Range semantics.
func gzipResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !acceptsGzip(r) || r.Header.Get("Range") != "" || isUncompressedPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		writer := &gzipResponseWriter{ResponseWriter: w, request: r}
		defer writer.close()
		next.ServeHTTP(writer, r)
	})
}

func acceptsGzip(r *http.Request) bool {
	encoding := strings.ToLower(r.Header.Get("Accept-Encoding"))
	if !strings.Contains(encoding, "gzip") {
		return false
	}
	// Honor an explicit refusal such as "gzip;q=0".
	return !strings.Contains(encoding, "gzip;q=0")
}

func isUncompressedPath(value string) bool {
	return value == "/api/events" ||
		value == "/api/backup" ||
		(strings.HasPrefix(value, "/api/notes/") && strings.Contains(value, "/attachments"))
}

func compressibleContentType(value string) bool {
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(value, ";")[0]))
	switch mediaType {
	case "application/json", "application/javascript", "application/xml",
		"image/svg+xml", "text/html", "text/css", "text/plain", "text/markdown",
		"text/javascript", "text/xml":
		return true
	default:
		return false
	}
}

type gzipResponseWriter struct {
	http.ResponseWriter
	request     *http.Request
	writer      *gzip.Writer
	compress    bool
	wroteHeader bool
}

func (w *gzipResponseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	compress := w.request.Method != http.MethodHead &&
		status >= http.StatusOK && status < http.StatusMultipleChoices &&
		status != http.StatusPartialContent &&
		w.Header().Get("Content-Encoding") == "" &&
		compressibleContentType(w.Header().Get("Content-Type"))
	if compress {
		if length := w.Header().Get("Content-Length"); length != "" {
			if size, err := strconv.Atoi(length); err == nil && size < 1024 {
				compress = false
			}
		}
	}
	w.compress = compress
	if compress {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Del("Content-Length")
		w.Header().Set("Vary", "Accept-Encoding")
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *gzipResponseWriter) Write(data []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if !w.compress {
		return w.ResponseWriter.Write(data)
	}
	if w.writer == nil {
		w.writer = gzipWriters.Get().(*gzip.Writer)
		w.writer.Reset(w.ResponseWriter)
	}
	return w.writer.Write(data)
}

func (w *gzipResponseWriter) Flush() {
	if w.writer != nil {
		_ = w.writer.Flush()
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *gzipResponseWriter) close() {
	if w.writer != nil {
		_ = w.writer.Close()
		// Drop the reference to the response writer before pooling the
		// compressor; otherwise the pool would keep whole responses alive.
		w.writer.Reset(io.Discard)
		gzipWriters.Put(w.writer)
		w.writer = nil
	}
}

// Unwrap keeps http.ResponseController working through the compression layer.
func (w *gzipResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}
