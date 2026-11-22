package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// benchmarkNoteCount is large enough to expose the costs that only appear in a
// real library (index scans, OFFSET pagination, FTS tokenization on save)
// without making the benchmark take minutes to seed.
const benchmarkNoteCount = 10000

// benchmarkNoteContent builds a realistic note: frontmatter, wikilinks, tags,
// a code block, a task and two dynamic blocks. The dynamic blocks are what the
// preview expands with SQL, so they show up in the preview benchmarks.
func benchmarkNoteContent(index int) string {
	var builder strings.Builder
	builder.Grow(1400)
	fmt.Fprintf(&builder, "---\ntitle: Nota %05d\nstatus: ativo\n---\n\n# Nota %05d\n\n", index, index)
	fmt.Fprintf(&builder, "Resumo da nota %d com [[Nota %05d]] e [[Nota %05d]].\n\n",
		index, (index+1)%benchmarkNoteCount, (index+17)%benchmarkNoteCount)
	for line := 0; line < 20; line++ {
		fmt.Fprintf(&builder, "- item %d da nota %d com texto de preenchimento para simular um documento real\n", line, index)
	}
	builder.WriteString("\n```go\nfunc exemplo() int { return 42 }\n```\n\n- [ ] tarefa pendente\n")
	builder.WriteString("<!-- ton618:tasks limite=5 -->\n\n<!-- ton618:recentes limite=5 -->\n")
	return builder.String()
}

// seedBenchmarkLibrary inserts the synthetic notes in a single transaction.
// It mirrors CreateNote (link index and derived metadata) so the benchmark
// measures the same database shape as a library built through the API.
func seedBenchmarkLibrary(b *testing.B, app *App) []int64 {
	b.Helper()
	tx, err := app.db.Begin()
	if err != nil {
		b.Fatal(err)
	}
	defer tx.Rollback()
	ids := make([]int64, 0, benchmarkNoteCount)
	for index := 0; index < benchmarkNoteCount; index++ {
		content := benchmarkNoteContent(index)
		tags := []string{fmt.Sprintf("tag-%02d", index%25), "benchmark"}
		result, err := tx.Exec(
			"INSERT INTO notes(title, content, folder, tags) VALUES (?, ?, ?, ?)",
			fmt.Sprintf("Nota %05d", index), content,
			fmt.Sprintf("Pasta %02d", index%40), strings.Join(tags, ","))
		if err != nil {
			b.Fatal(err)
		}
		id, err := result.LastInsertId()
		if err != nil {
			b.Fatal(err)
		}
		if err := replaceNoteLinks(tx, id, content); err != nil {
			b.Fatal(err)
		}
		if err := syncNoteMetadata(tx, id, content, tags); err != nil {
			b.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := tx.Commit(); err != nil {
		b.Fatal(err)
	}
	app.markDataChanged()
	return ids
}

// BenchmarkLibrary exercises the hot backend paths against a 10k-note library.
// Run it with:
//
//	go test -tags sqlite_fts5 -run '^$' -bench BenchmarkLibrary -benchtime 10x ./...
func BenchmarkLibrary(b *testing.B) {
	app, err := NewApp(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	defer app.Close()
	ids := seedBenchmarkLibrary(b, app)
	handler := app.Handler(filepath.Join("..", "web", "frontend"))
	noteID := ids[len(ids)/2]
	previewBody := []byte(benchmarkNoteContent(int(noteID)))
	updated := Note{
		Title:   fmt.Sprintf("Nota %05d", int(noteID)),
		Folder:  "Pasta 00",
		Content: benchmarkNoteContent(int(noteID)) + "\nlinha extra\n",
		Tags:    []string{"tag-00", "benchmark"},
	}

	b.Run("ListNotes/all/cold", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			// Every autosave advances the revision, so the first list after a
			// save is the one that actually runs the SQL.
			app.markDataChanged()
			if _, err := app.ListNotes("", "", defaultPageSize, 0); err != nil {
				b.Fatal(err)
			}
		}
	})

	b.Run("ListNotes/all/cached", func(b *testing.B) {
		b.ReportAllocs()
		if _, err := app.ListNotes("", "", defaultPageSize, 0); err != nil {
			b.Fatal(err)
		}
		for index := 0; index < b.N; index++ {
			if _, err := app.ListNotes("", "", defaultPageSize, 0); err != nil {
				b.Fatal(err)
			}
		}
	})

	b.Run("ListNotes/folder+tag/cold", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			app.markDataChanged()
			if _, err := app.ListNotes("Pasta 07", "tag-07", defaultPageSize, 0); err != nil {
				b.Fatal(err)
			}
		}
	})

	b.Run("SearchNotes/title", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			app.markDataChanged()
			if _, err := app.SearchNotes("Nota 0123", "title", "", "", defaultPageSize, 0); err != nil {
				b.Fatal(err)
			}
		}
	})

	b.Run("SearchNotes/content", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			app.markDataChanged()
			if _, err := app.SearchNotes("preenchimento", "content", "", "", defaultPageSize, 0); err != nil {
				b.Fatal(err)
			}
		}
	})

	b.Run("UpdateNote/content", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			updated.Content = benchmarkNoteContent(int(noteID) + index)
			if err := app.UpdateNote(noteID, updated); err != nil {
				b.Fatal(err)
			}
		}
	})

	b.Run("Preview/plain", func(b *testing.B) {
		b.ReportAllocs()
		body := []byte("# Título\n\nParágrafo com **ênfase**, uma lista:\n\n- um\n- dois\n- três\n")
		for index := 0; index < b.N; index++ {
			request := httptest.NewRequest(http.MethodPost, "/api/preview", strings.NewReader(string(body)))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				b.Fatalf("preview status = %d", response.Code)
			}
		}
	})

	b.Run("Preview/blocks-cached", func(b *testing.B) {
		b.ReportAllocs()
		// Warm the block cache once; previews within the same revision must
		// not run the block queries again.
		app.expandNoteBlocks(string(previewBody), noteBlockContext{NoteID: noteID})
		for index := 0; index < b.N; index++ {
			request := httptest.NewRequest(http.MethodPost, "/api/preview", strings.NewReader(string(previewBody)))
			request.Header.Set("X-Note-ID", fmt.Sprint(noteID))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				b.Fatalf("preview status = %d", response.Code)
			}
		}
	})

	b.Run("ExpandBlocks/cold", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			app.markDataChanged()
			app.expandNoteBlocks(string(previewBody), noteBlockContext{NoteID: noteID})
		}
	})

	b.Run("ExpandBlocks/cached", func(b *testing.B) {
		b.ReportAllocs()
		app.expandNoteBlocks(string(previewBody), noteBlockContext{NoteID: noteID})
		for index := 0; index < b.N; index++ {
			app.expandNoteBlocks(string(previewBody), noteBlockContext{NoteID: noteID})
		}
	})
}
