package main

import (
	"bytes"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNewAppSupportsDataDirectoryWithSpaces(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "Área de trabalho", "notas")
	app, err := NewApp(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	if _, err := app.CreateNote(Note{Title: "Acento", Content: "conteúdo"}); err != nil {
		t.Fatal(err)
	}
	page, err := app.ListNotes("", "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 {
		t.Fatalf("total = %d, want 1", page.Total)
	}
}

func TestReadsAreNotBlockedByOpenWriteTransaction(t *testing.T) {
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	tx, err := app.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO notes(title, content, folder) VALUES ('Pendente', 'x', '')`); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		page, err := app.ListNotes("", "", 10, 0)
		if err == nil && page.Total != 0 {
			err = fmt.Errorf("read saw uncommitted rows: total = %d", page.Total)
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("read blocked behind the open write transaction")
	}
}

func TestSourceLineAtMatchesNaiveNewlineCount(t *testing.T) {
	source := []byte("first\nsecond line\n\nfourth\n")
	starts := markdownLineStarts(source)
	for offset := 0; offset <= len(source); offset++ {
		want := bytes.Count(source[:offset], []byte{'\n'})
		if got := sourceLineAt(starts, offset); got != want {
			t.Fatalf("sourceLineAt(%d) = %d, want %d", offset, got, want)
		}
	}
}

func TestFTSUpdateTriggerSkipsUnrelatedColumns(t *testing.T) {
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	var triggerSQL string
	if err := app.db.QueryRow(`SELECT sql FROM sqlite_master
		WHERE type = 'trigger' AND name = 'notes_fts_update'`).Scan(&triggerSQL); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(triggerSQL, "WHEN") {
		t.Fatalf("notes_fts_update is not conditional: %s", triggerSQL)
	}

	id, err := app.CreateNote(Note{Title: "Busca", Content: "conteúdo indexado", Folder: "Antiga"})
	if err != nil {
		t.Fatal(err)
	}
	if err := app.MoveNoteFolder(id, "Nova"); err != nil {
		t.Fatal(err)
	}
	page, err := app.SearchNotes("indexado", "content", "", "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || page.Items[0].ID != id {
		t.Fatalf("search after folder move = %#v", page)
	}
}

func TestReadCachesFollowMutations(t *testing.T) {
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	researcher, err := app.CreateNote(Note{Title: "Pesquisa", Content: "ver [[Destino]]", Tags: []string{"antiga"}})
	if err != nil {
		t.Fatal(err)
	}
	target, err := app.CreateNote(Note{Title: "Destino", Content: "alvo"})
	if err != nil {
		t.Fatal(err)
	}

	tags, err := app.Tags()
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 1 || tags[0].Name != "antiga" {
		t.Fatalf("initial tags = %#v", tags)
	}
	graph, err := app.NoteGraph()
	if err != nil {
		t.Fatal(err)
	}
	if len(graph.Edges) != 1 {
		t.Fatalf("initial graph edges = %#v", graph.Edges)
	}

	// Cached tags and graph must be invalidated by a content/tag update.
	note, err := app.GetNote(researcher)
	if err != nil {
		t.Fatal(err)
	}
	note.Content = "sem links"
	note.Tags = []string{"nova"}
	if err := app.UpdateNote(researcher, note); err != nil {
		t.Fatal(err)
	}
	tags, err = app.Tags()
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 1 || tags[0].Name != "nova" {
		t.Fatalf("tags after update = %#v", tags)
	}
	graph, err = app.NoteGraph()
	if err != nil {
		t.Fatal(err)
	}
	if len(graph.Edges) != 0 {
		t.Fatalf("graph edges after removing link = %#v", graph.Edges)
	}

	if err := app.DeleteNote(target); err != nil {
		t.Fatal(err)
	}
	tags, err = app.Tags()
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 1 {
		t.Fatalf("tags after delete = %#v", tags)
	}
}

func TestDerivedMetadataTracksUpdates(t *testing.T) {
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	id, err := app.CreateNote(Note{
		Title:   "Metadados",
		Folder:  "Pasta",
		Content: "---\nhide_from_explorer: true\ntags: antiga\n---\ncorpo",
	})
	if err != nil {
		t.Fatal(err)
	}
	page, err := app.ListFolderNotes("Pasta", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 0 {
		t.Fatalf("hidden note appeared in explorer: %#v", page)
	}

	note, err := app.GetNote(id)
	if err != nil {
		t.Fatal(err)
	}
	note.Content = "---\nhide_from_explorer: false\ntags: nova\n---\ncorpo"
	if err := app.UpdateNote(id, note); err != nil {
		t.Fatal(err)
	}

	page, err = app.ListFolderNotes("Pasta", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || page.Items[0].Title != "Metadados" {
		t.Fatalf("visible note missing from explorer: %#v", page)
	}
	tags, err := app.Tags()
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 1 || tags[0].Name != "nova" || tags[0].Count != 1 {
		t.Fatalf("tags after update = %#v", tags)
	}
	rows, _, err := app.ListTableNotes("", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Properties["hide_from_explorer"] != false {
		t.Fatalf("table properties = %#v", rows)
	}
}

func TestMigrationBackfillsTagsAndFrontmatter(t *testing.T) {
	dataDir := t.TempDir()
	db, err := sql.Open("sqlite3", filepath.Join(dataDir, "notes.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE notes (
		rowid INTEGER PRIMARY KEY AUTOINCREMENT,
		title TEXT NOT NULL,
		content TEXT,
		folder TEXT DEFAULT '',
		tags TEXT DEFAULT '',
		created_at TEXT DEFAULT (datetime('now')),
		updated_at TEXT DEFAULT (datetime('now'))
	)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO notes(title, content, folder, tags) VALUES (?, ?, ?, ?)`,
		"Old hidden", "---\nhide_from_explorer: true\n---\nbody", "Pasta", "Tag, outra"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO notes(title, content, folder, tags) VALUES (?, ?, ?, ?)`,
		"Visible", "TODO: revisar", "Pasta", "Tag"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	app, err := NewApp(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	page, err := app.ListFolderNotes("Pasta", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || page.Items[0].Title != "Visible" {
		t.Fatalf("backfilled explorer page = %#v", page)
	}
	tags, err := app.Tags()
	if err != nil {
		t.Fatal(err)
	}
	counts := make(map[string]int, len(tags))
	for _, tag := range tags {
		counts[tag.Name] = tag.Count
	}
	if counts["Tag"] != 2 || counts["outra"] != 1 {
		t.Fatalf("backfilled tags = %#v", tags)
	}
	filtered, err := app.ListNotes("", "tag", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if filtered.Total != 2 {
		t.Fatalf("tag filter after migration = %#v", filtered)
	}

	tasks, err := app.ListTasks(DefaultTaskMarkers)
	if err != nil {
		t.Fatal(err)
	}
	if tasks.Total != 1 || tasks.Items[0].NoteTitle != "Visible" || tasks.Items[0].Text != "revisar" {
		t.Fatalf("backfilled tasks = %#v", tasks)
	}
}

func TestTasksTrackContentAndMarkerChanges(t *testing.T) {
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	id, err := app.CreateNote(Note{
		Title:   "Tarefas",
		Content: "---\nTODO: metadado\n---\nTODO: revisar\nlinha comum\n",
	})
	if err != nil {
		t.Fatal(err)
	}
	tasks, err := app.ListTasks(DefaultTaskMarkers)
	if err != nil {
		t.Fatal(err)
	}
	if tasks.Total != 1 || tasks.Items[0].Text != "revisar" || tasks.Items[0].Line != 4 {
		t.Fatalf("initial tasks = %#v", tasks)
	}

	note, err := app.GetNote(id)
	if err != nil {
		t.Fatal(err)
	}
	note.Content = "---\nTODO: metadado\n---\nLATER: nova tarefa\ntodo: minúsculo não conta\n"
	if err := app.UpdateNote(id, note); err != nil {
		t.Fatal(err)
	}
	tasks, err = app.ListTasks(DefaultTaskMarkers)
	if err != nil {
		t.Fatal(err)
	}
	if tasks.Total != 0 {
		t.Fatalf("old marker still indexed: %#v", tasks)
	}
	later, err := app.ListTasks([]string{"LATER"})
	if err != nil {
		t.Fatal(err)
	}
	if later.Total != 1 || later.Items[0].Text != "nova tarefa" || later.Items[0].Line != 4 {
		t.Fatalf("custom marker = %#v", later)
	}

	if _, err := app.SaveTaskMarkers([]string{"LATER"}); err != nil {
		t.Fatal(err)
	}
	saved, err := app.TaskMarkers()
	if err != nil {
		t.Fatal(err)
	}
	tasks, err = app.ListTasks(saved)
	if err != nil {
		t.Fatal(err)
	}
	if tasks.Total != 1 || tasks.Items[0].Marker != "LATER" {
		t.Fatalf("marker change did not update tasks: %#v", tasks)
	}
}

// TestAttachmentMediaTypeCoversPhoneImages keeps phone photos recognizable
// even when the server runs on a minimal image without /etc/mime.types, where
// mime.TypeByExtension does not know formats such as webp or heic.
func TestAttachmentMediaTypeCoversPhoneImages(t *testing.T) {
	cases := map[string]string{
		"IMG_0001.HEIC":   "image/heic",
		"foto.webp":       "image/webp",
		"scan.avif":       "image/avif",
		"retrato.jpeg":    "image/jpeg",
		"nota.txt":        "text/plain; charset=utf-8",
		"backup.zip":      "application/zip",
		"arquivo.pkmtest": "application/octet-stream",
	}
	for name, want := range cases {
		if got := attachmentMediaType(name); got != want {
			t.Errorf("attachmentMediaType(%q) = %q, want %q", name, got, want)
		}
	}
}

// TestContentOnlyUpdateKeepsLinkIndexFresh guards the autosave hot path. The
// link index only stores IDs, titles and folders, so a save that touches just
// the body must not force the next backlinks/preview/graph request to rescan
// the whole notes table. A title or folder change still has to invalidate it.
func TestContentOnlyUpdateKeepsLinkIndexFresh(t *testing.T) {
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	targetID, err := app.CreateNote(Note{Title: "Alvo", Content: "corpo"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := app.CreateNote(Note{Title: "Origem", Content: "ver [[Alvo]]"})
	if err != nil {
		t.Fatal(err)
	}

	index, err := app.noteIndex()
	if err != nil {
		t.Fatal(err)
	}
	if index.revision != app.currentDataRevision() {
		t.Fatalf("warm index revision = %d, want %d", index.revision, app.currentDataRevision())
	}

	note, err := app.GetNote(targetID)
	if err != nil {
		t.Fatal(err)
	}
	note.Content += "\nparágrafo novo"
	if err := app.UpdateNote(targetID, note); err != nil {
		t.Fatal(err)
	}

	fresh, err := app.noteIndex()
	if err != nil {
		t.Fatal(err)
	}
	if fresh != index {
		t.Fatal("content-only update rebuilt the link index")
	}
	if fresh.revision != app.currentDataRevision() {
		t.Fatalf("index revision = %d, want %d", fresh.revision, app.currentDataRevision())
	}

	backlinks, err := app.Backlinks(targetID)
	if err != nil {
		t.Fatal(err)
	}
	if len(backlinks) != 1 || backlinks[0].ID != sourceID {
		t.Fatalf("backlinks after content save = %#v", backlinks)
	}

	note, err = app.GetNote(targetID)
	if err != nil {
		t.Fatal(err)
	}
	note.Title = "Alvo renomeado"
	if err := app.UpdateNote(targetID, note); err != nil {
		t.Fatal(err)
	}
	afterRename, err := app.noteIndex()
	if err != nil {
		t.Fatal(err)
	}
	if afterRename == index {
		t.Fatal("title change reused the stale link index")
	}
	if afterRename.revision != app.currentDataRevision() {
		t.Fatalf("renamed index revision = %d, want %d", afterRename.revision, app.currentDataRevision())
	}
}

// TestBacklinkIndexTracksLinkChanges keeps the revision-keyed backlink index
// honest: it may only be reused while note_links and the title/folder index
// are unchanged, even when the save itself touched just the note body.
func TestBacklinkIndexTracksLinkChanges(t *testing.T) {
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	targetID, err := app.CreateNote(Note{Title: "Alvo", Content: "corpo"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := app.CreateNote(Note{Title: "Origem", Content: "[[Alvo]]"})
	if err != nil {
		t.Fatal(err)
	}

	wantBacklinks := func(step string, want int) {
		t.Helper()
		links, err := app.Backlinks(targetID)
		if err != nil {
			t.Fatal(err)
		}
		if len(links) != want {
			t.Fatalf("%s: backlinks = %#v, want %d", step, links, want)
		}
		if want > 0 && links[0].ID != sourceID {
			t.Fatalf("%s: backlink source = %d, want %d", step, links[0].ID, sourceID)
		}
	}

	wantBacklinks("initial", 1)

	source, err := app.GetNote(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	source.Content = "sem links"
	if err := app.UpdateNote(sourceID, source); err != nil {
		t.Fatal(err)
	}
	wantBacklinks("link removed", 0)

	source, err = app.GetNote(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	source.Content = "[[Alvo]] de novo"
	if err := app.UpdateNote(sourceID, source); err != nil {
		t.Fatal(err)
	}
	wantBacklinks("link restored", 1)

	target, err := app.GetNote(targetID)
	if err != nil {
		t.Fatal(err)
	}
	target.Title = "Alvo renomeado"
	if err := app.UpdateNote(targetID, target); err != nil {
		t.Fatal(err)
	}
	wantBacklinks("target renamed", 1)
}
