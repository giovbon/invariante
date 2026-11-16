package main

import (
	"bytes"
	"database/sql"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
)

func (a *App) handlePreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	source, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxContentSize))
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			http.Error(w, "markdown content exceeds the 5 MiB limit", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "failed to read markdown content", http.StatusBadRequest)
		}
		return
	}
	if rawID := r.Header.Get("X-Note-ID"); rawID != "" {
		noteID, err := strconv.ParseInt(rawID, 10, 64)
		if err != nil || noteID < 1 {
			http.Error(w, "invalid note ID", http.StatusBadRequest)
			return
		}
		var title, folder string
		err = a.readDB.QueryRow(`SELECT title, COALESCE(folder, '') FROM notes WHERE rowid = ?`, noteID).
			Scan(&title, &folder)
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
			return
		}
		if err != nil {
			log.Printf("load note %d for preview: %v", noteID, err)
			http.Error(w, "failed to load note for preview", http.StatusInternalServerError)
			return
		}
		index, err := a.noteIndex()
		if err != nil {
			log.Printf("load note index for preview: %v", err)
			http.Error(w, "failed to load notes for preview", http.StatusInternalServerError)
			return
		}
		source = []byte(convertWikilinksToMarkdown(string(source),
			indexedNote{GraphNode: GraphNode{ID: noteID, Title: title, Folder: folder}},
			index.byPath, index.byTitle))
	}
	renderMarkdownPreview(w, source)
}

var previewMarkdown = goldmark.New(goldmark.WithExtensions(extension.GFM))

func renderMarkdownPreview(w http.ResponseWriter, source []byte) {
	lineStarts := markdownLineStarts(source)
	document := previewMarkdown.Parser().Parse(text.NewReader(source))
	if err := ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch link := node.(type) {
		case *ast.Link:
			if !safeMarkdownDestination(link.Destination) {
				link.Destination = []byte("#")
			}
		case *ast.Image:
			if !safeMarkdownDestination(link.Destination) {
				link.Destination = []byte("#")
			}
		}
		// The preview is also used to jump to a specific line (tasks,
		// backlinks, outline). Annotate the blocks that can hold a line of
		// text so the client can locate the exact scroll position.
		switch node.Kind() {
		case ast.KindParagraph, ast.KindListItem, ast.KindBlockquote:
			if line, ok := previewSourceLine(node, source, lineStarts); ok {
				node.SetAttributeString("data-source-line", strconv.Itoa(line))
			}
		}
		return ast.WalkContinue, nil
	}); err != nil {
		log.Printf("walk markdown AST: %v", err)
		http.Error(w, "failed to render markdown", http.StatusInternalServerError)
		return
	}

	var rendered bytes.Buffer
	if err := previewMarkdown.Renderer().Render(&rendered, source, document); err != nil {
		log.Printf("render markdown: %v", err)
		http.Error(w, "failed to render markdown", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(rendered.Bytes()); err != nil {
		log.Printf("write markdown preview: %v", err)
	}
}

// markdownLineStarts records the byte offset of each line. Counting newlines
// in source[:start] for every block made preview rendering quadratic in the
// document size; one pass plus a binary search keeps it linear.
func markdownLineStarts(source []byte) []int {
	starts := make([]int, 1, bytes.Count(source, []byte{'\n'})+1)
	for index, value := range source {
		if value == '\n' {
			starts = append(starts, index+1)
		}
	}
	return starts
}

func sourceLineAt(starts []int, offset int) int {
	line := sort.Search(len(starts), func(index int) bool { return starts[index] > offset }) - 1
	if line < 0 {
		return 0
	}
	return line
}

// previewSourceLine returns the zero-based line of a block in the preview
// source. Lists and blockquotes do not expose line segments themselves, so
// their first descendant text block provides the position.
func previewSourceLine(node ast.Node, source []byte, lineStarts []int) (int, bool) {
	if node.Type() != ast.TypeBlock {
		return 0, false
	}
	if lines := node.Lines(); lines.Len() > 0 {
		start := lines.At(0).Start
		if start < 0 || start > len(source) {
			return 0, false
		}
		return sourceLineAt(lineStarts, start), true
	}
	for child := node.FirstChild(); child != nil; child = child.NextSibling() {
		if line, ok := previewSourceLine(child, source, lineStarts); ok {
			return line, true
		}
	}
	return 0, false
}

func safeMarkdownDestination(destination []byte) bool {
	parsed, err := url.Parse(strings.TrimSpace(string(destination)))
	if err != nil {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "", "http", "https", "mailto":
		return true
	default:
		return false
	}
}
