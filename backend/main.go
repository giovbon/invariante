package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"

	_ "github.com/mattn/go-sqlite3"
)

const (
	defaultPageSize = 30
	maxPageSize     = 100
	maxContentSize  = 5 << 20
	maxRequestSize  = maxContentSize + (64 << 10)
)

var ErrVersionConflict = errors.New("note was modified by another session")
var ErrFolderExists = errors.New("folder already exists")

type Note struct {
	ID        int64    `json:"id"`
	Title     string   `json:"title"`
	Content   string   `json:"content"`
	Folder    string   `json:"folder"`
	Tags      []string `json:"tags,omitempty"`
	Version   int64    `json:"version"`
	CreatedAt string   `json:"created_at"`
	UpdatedAt string   `json:"updated_at"`
}

type NoteSummary struct {
	ID          int64    `json:"id"`
	Title       string   `json:"title"`
	Folder      string   `json:"folder"`
	Tags        []string `json:"tags,omitempty"`
	Preview     string   `json:"preview"`
	Snippets    []string `json:"snippets,omitempty"`
	Occurrences int      `json:"occurrences,omitempty"`
	UpdatedAt   string   `json:"updated_at"`
}

type Page struct {
	Items  []NoteSummary `json:"items"`
	Total  int           `json:"total"`
	Limit  int           `json:"limit"`
	Offset int           `json:"offset"`
}

type Folder struct {
	Name     string   `json:"name"`
	Path     string   `json:"path"`
	Children []Folder `json:"children"`
}

type TagCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type tagCountsCache struct {
	revision uint64
	tags     []TagCount
}

type notesPageCache struct {
	revision uint64
	key      string
	page     Page
}

type searchPageCache struct {
	revision uint64
	key      string
	page     Page
}

type App struct {
	db *sql.DB
	// readDB is a separate pool for read-only queries. SQLite in WAL mode
	// supports concurrent readers, so a slow scan (tasks, table, search) no
	// longer blocks edits or other tabs while the writer holds the only
	// writable connection.
	readDB         *sql.DB
	attachmentsDir string
	auth           *authenticator
	backupMu       sync.Mutex
	eventsMu       sync.Mutex
	events         map[chan uint64]struct{}
	eventsSeq      uint64
	// dataMu keeps the attachments directory consistent with the database.
	// Uploads and exports take a read lock; restores and deletions take the
	// write lock, so a restore can never swap the directory while a file is
	// being written or while a backup is reading it.
	dataMu sync.RWMutex
	// shutdown asks long-lived handlers (the event stream) to stop during a
	// graceful shutdown. Without it, Shutdown waits for the full timeout while
	// open browser tabs keep their SSE connections alive.
	shutdownOnce sync.Once
	shutdown     chan struct{}
	// cacheMu guards the revision-keyed read caches. dataRevision advances on
	// every mutation that can change note titles, folders or links, so caches
	// never serve stale graph, tag or link data.
	cacheMu      sync.RWMutex
	dataRevision uint64
	linkIndex    *noteLinkIndex
	graphCache   *noteGraphCache
	tagsCache    *tagCountsCache
	taskCache    []taskPageCache
	tableCache   []tablePageCache
	notesCache   []notesPageCache
	searchCache  []searchPageCache
}

type folderBuilder struct {
	Folder
	children map[string]*folderBuilder
}

func NewApp(dataDir string) (*App, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}

	dbPath := filepath.Join(dataDir, "notes.db")
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	app := &App{
		db:             db,
		attachmentsDir: filepath.Join(dataDir, "attachments"),
		shutdown:       make(chan struct{}),
	}

	for _, statement := range []string{
		"PRAGMA busy_timeout = 5000",
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = NORMAL",
		"PRAGMA foreign_keys = ON",
		"PRAGMA cache_size = -16384",
	} {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			return nil, fmt.Errorf("configure database (%s): %w", statement, err)
		}
	}
	if err := app.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate database: %w", err)
	}
	if err := os.MkdirAll(app.attachmentsDir, 0700); err != nil {
		db.Close()
		return nil, fmt.Errorf("create attachment storage: %w", err)
	}
	app.auth, err = newAuthenticator(os.Getenv("AUTHENTICATION_PASSWORD"))
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize authentication: %w", err)
	}
	if configured := os.Getenv("AUTHENTICATION_COOKIE_SECURE"); configured != "" {
		app.auth.secure, err = strconv.ParseBool(configured)
		if err != nil {
			db.Close()
			return nil, fmt.Errorf("parse AUTHENTICATION_COOKIE_SECURE: %w", err)
		}
	}
	app.readDB, err = openReadDatabase(dbPath)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("open read-only database: %w", err)
	}
	if app.auth.enabled() {
		log.Printf("Authentication enabled")
	} else {
		log.Printf("Authentication disabled; set AUTHENTICATION_PASSWORD to require login")
	}
	log.Printf("Database initialized at %s", filepath.Join(dataDir, "notes.db"))
	return app, nil
}

// openReadDatabase creates a small pool of read-only connections. WAL mode
// lets them run while a write transaction is in flight, which keeps the UI
// responsive during saves and removes the single-connection bottleneck.
func openReadDatabase(dbPath string) (*sql.DB, error) {
	absolutePath, err := filepath.Abs(dbPath)
	if err != nil {
		return nil, err
	}
	dsn := (&url.URL{
		Scheme:   "file",
		Path:     absolutePath,
		RawQuery: "_busy_timeout=5000&_query_only=on&_cache_size=-8192",
	}).String()
	readDB, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	readDB.SetMaxOpenConns(4)
	readDB.SetMaxIdleConns(4)
	if err := readDB.Ping(); err != nil {
		readDB.Close()
		return nil, err
	}
	return readDB, nil
}

func (a *App) Close() error {
	// Let SQLite refresh its statistics for the next run. Errors are not
	// actionable during shutdown and must not prevent closing the pools.
	if _, err := a.db.Exec("PRAGMA optimize"); err != nil {
		log.Printf("optimize database on close: %v", err)
	}
	var readErr error
	if a.readDB != nil {
		readErr = a.readDB.Close()
		a.readDB = nil
	}
	return errors.Join(a.db.Close(), readErr)
}

// markDataChanged invalidates the read caches. It is called after every
// mutation that may change note titles, folders or links, including content
// saves that do not need to notify the folder tree.
func (a *App) markDataChanged() {
	a.cacheMu.Lock()
	a.dataRevision++
	a.cacheMu.Unlock()
}

func (a *App) currentDataRevision() uint64 {
	a.cacheMu.RLock()
	defer a.cacheMu.RUnlock()
	return a.dataRevision
}

func (a *App) migrate() error {
	baseSchema := []string{
		`CREATE TABLE IF NOT EXISTS notes (
			rowid INTEGER PRIMARY KEY AUTOINCREMENT,
			title TEXT NOT NULL,
			content TEXT DEFAULT '',
			folder TEXT DEFAULT '',
			tags TEXT DEFAULT '',
			version INTEGER NOT NULL DEFAULT 1,
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder)`,
		`CREATE INDEX IF NOT EXISTS idx_notes_folder_title ON notes(folder, title COLLATE NOCASE)`,
		`CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC, rowid DESC)`,
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS attachments (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			note_id INTEGER NOT NULL REFERENCES notes(rowid) ON DELETE CASCADE,
			filename TEXT NOT NULL,
			storage_name TEXT NOT NULL,
			media_type TEXT NOT NULL,
			size INTEGER NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(note_id, storage_name)
		)`,
		`CREATE TABLE IF NOT EXISTS folders (
			path TEXT PRIMARY KEY,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS app_settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id, id)`,
	}
	for _, statement := range baseSchema {
		if _, err := a.db.Exec(statement); err != nil {
			return err
		}
	}

	migrations := []struct {
		version int
		apply   func(*sql.Tx) error
	}{
		{version: 1, apply: migrateSearchIndex},
		{version: 2, apply: migrateNoteLinks},
		{version: 3, apply: migrateNoteVersions},
		{version: 5, apply: migrateRemoveNoteHistory},
		{version: 6, apply: migrateAppSettings},
		{version: 7, apply: migrateConditionalFTSTrigger},
		{version: 8, apply: migrateDerivedNoteMetadata},
		{version: 9, apply: migrateQueryIndexes},
	}
	for _, migration := range migrations {
		var applied int
		if err := a.db.QueryRow("SELECT COUNT(*) FROM schema_migrations WHERE version = ?",
			migration.version).Scan(&applied); err != nil {
			return err
		}
		if applied != 0 {
			continue
		}
		tx, err := a.db.Begin()
		if err != nil {
			return err
		}
		if err := migration.apply(tx); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", migration.version, err)
		}
		if _, err := tx.Exec("INSERT INTO schema_migrations(version) VALUES (?)", migration.version); err != nil {
			tx.Rollback()
			return fmt.Errorf("record migration %d: %w", migration.version, err)
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func insertFolderPath(tx *sql.Tx, folder string) error {
	parts := strings.Split(folder, "/")
	current := ""
	for _, part := range parts {
		if current == "" {
			current = part
		} else {
			current += "/" + part
		}
		if _, err := tx.Exec("INSERT OR IGNORE INTO folders(path) VALUES (?)", current); err != nil {
			return err
		}
	}
	return nil
}

func migrateSearchIndex(tx *sql.Tx) error {
	statements := []string{
		`CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
			title,
			content,
			content='notes',
			content_rowid='rowid',
			tokenize='unicode61 remove_diacritics 2'
		)`,
		`CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
			INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
		END`,
		`CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
			INSERT INTO notes_fts(notes_fts, rowid, title, content)
			VALUES ('delete', old.rowid, old.title, old.content);
		END`,
		`CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes
			WHEN old.title IS NOT new.title OR old.content IS NOT new.content
			BEGIN
			INSERT INTO notes_fts(notes_fts, rowid, title, content)
			VALUES ('delete', old.rowid, old.title, old.content);
			INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
		END`,
		`INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}

// migrateNoteLinks stores the raw link targets found in each note. Resolution
// against current titles and folder paths happens at read time, so creating a
// note with a previously dangling title keeps existing links consistent
// without re-parsing every note. Renames and folder moves rewrite only the
// notes whose links would break (see rewriteIncomingLinks and
// relinkNotesAfterMove).
func migrateNoteLinks(tx *sql.Tx) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS note_links (
			source_id INTEGER NOT NULL REFERENCES notes(rowid) ON DELETE CASCADE,
			target_key TEXT NOT NULL,
			kind TEXT NOT NULL,
			PRIMARY KEY (source_id, target_key, kind)
		)`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}

	ids := make([]int64, 0)
	rows, err := tx.Query("SELECT rowid FROM notes ORDER BY rowid")
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for _, id := range ids {
		var content string
		if err := tx.QueryRow("SELECT COALESCE(content, '') FROM notes WHERE rowid = ?", id).Scan(&content); err != nil {
			return err
		}
		if err := replaceNoteLinks(tx, id, content); err != nil {
			return err
		}
	}
	return nil
}

// migrateNoteVersions adds the optimistic-concurrency counter used by the
// editor. Existing databases get the column through ALTER TABLE; new
// databases already create it in the base schema.
func migrateNoteVersions(tx *sql.Tx) error {
	rows, err := tx.Query("PRAGMA table_info(notes)")
	if err != nil {
		return err
	}
	hasVersion := false
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			rows.Close()
			return err
		}
		if name == "version" {
			hasVersion = true
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if hasVersion {
		return nil
	}
	_, err = tx.Exec("ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
	return err
}

// migrateRemoveNoteHistory deletes the snapshot table left behind by older
// versions that shipped a per-note history feature.
func migrateRemoveNoteHistory(tx *sql.Tx) error {
	_, err := tx.Exec("DROP TABLE IF EXISTS note_versions")
	return err
}

// migrateAppSettings stores small application-wide preferences, such as the
// list of task markers, so every browser sees the same configuration.
func migrateAppSettings(tx *sql.Tx) error {
	_, err := tx.Exec(`CREATE TABLE IF NOT EXISTS app_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`)
	return err
}

// migrateConditionalFTSTrigger replaces the original trigger, which reindexed
// the whole note content on every UPDATE. Moving a folder, renaming a tag or
// bumping the version only needs a new FTS row when the indexed columns change.
func migrateConditionalFTSTrigger(tx *sql.Tx) error {
	statements := []string{
		`DROP TRIGGER IF EXISTS notes_fts_update`,
		`CREATE TRIGGER notes_fts_update AFTER UPDATE ON notes
			WHEN old.title IS NOT new.title OR old.content IS NOT new.content
			BEGIN
			INSERT INTO notes_fts(notes_fts, rowid, title, content)
			VALUES ('delete', old.rowid, old.title, old.content);
			INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
		END`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}

// migrateQueryIndexes aligns the hot-path indexes with the actual ORDER BY
// clauses (updated_at DESC, rowid DESC) and adds the target lookup used by
// link maintenance and future backlink queries.
func migrateQueryIndexes(tx *sql.Tx) error {
	statements := []string{
		`DROP INDEX IF EXISTS idx_notes_updated`,
		`CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC, rowid DESC)`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) ListNotes(folder, tag string, limit, offset int) (Page, error) {
	revision := a.currentDataRevision()
	cacheKey := fmt.Sprintf("%s\x00%s|%d|%d", folder, tag, limit, offset)
	a.cacheMu.Lock()
	for _, entry := range a.notesCache {
		if entry.revision == revision && entry.key == cacheKey {
			page := entry.page
			a.cacheMu.Unlock()
			return page, nil
		}
	}
	a.cacheMu.Unlock()
	var total int
	if err := a.readDB.QueryRow(`SELECT COUNT(*) FROM notes
		WHERE (folder = ? OR ? = '')
		AND (? = '' OR EXISTS (
			SELECT 1 FROM note_tags nt WHERE nt.note_id = notes.rowid AND nt.tag = ?
		))`,
		folder, folder, tag, tag).Scan(&total); err != nil {
		return Page{}, err
	}
	rows, err := a.readDB.Query(`SELECT rowid, title, folder, substr(COALESCE(content, ''), 1, 180), updated_at, COALESCE(tags, '')
		FROM notes
		WHERE (folder = ? OR ? = '')
		AND (? = '' OR EXISTS (
			SELECT 1 FROM note_tags nt WHERE nt.note_id = notes.rowid AND nt.tag = ?
		))
		ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`,
		folder, folder, tag, tag, limit, offset)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	items, err := scanSummaries(rows)
	if err != nil {
		return Page{}, err
	}
	page := Page{Items: items, Total: total, Limit: limit, Offset: offset}
	a.cacheMu.Lock()
	a.notesCache = append(a.notesCache, notesPageCache{revision: revision, key: cacheKey, page: page})
	if len(a.notesCache) > 8 {
		a.notesCache = a.notesCache[len(a.notesCache)-8:]
	}
	a.cacheMu.Unlock()
	return page, nil
}

func (a *App) ListFolderNotes(folder string, limit, offset int) (Page, error) {
	var total int
	if err := a.readDB.QueryRow(`SELECT COUNT(*) FROM notes
		WHERE folder = ? AND hide_from_explorer = 0`, folder).Scan(&total); err != nil {
		return Page{}, err
	}
	rows, err := a.readDB.Query(`SELECT rowid, title, folder, substr(COALESCE(content, ''), 1, 180),
		updated_at, COALESCE(tags, '')
		FROM notes WHERE folder = ? AND hide_from_explorer = 0
		ORDER BY title COLLATE NOCASE, rowid LIMIT ? OFFSET ?`, folder, limit, offset)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	items, err := scanSummaries(rows)
	if err != nil {
		return Page{}, err
	}
	return Page{Items: items, Total: total, Limit: limit, Offset: offset}, nil
}

func (a *App) Tags() ([]TagCount, error) {
	revision := a.currentDataRevision()
	a.cacheMu.RLock()
	cached := a.tagsCache
	a.cacheMu.RUnlock()
	if cached != nil && cached.revision == revision {
		return cached.tags, nil
	}

	rows, err := a.readDB.Query(`SELECT tag, COUNT(*) FROM note_tags
		GROUP BY tag ORDER BY COUNT(*) DESC, lower(tag)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make([]TagCount, 0)
	for rows.Next() {
		var item TagCount
		if err := rows.Scan(&item.Name, &item.Count); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	a.cacheMu.Lock()
	a.tagsCache = &tagCountsCache{revision: revision, tags: result}
	a.cacheMu.Unlock()
	return result, nil
}

func (a *App) SearchNotes(query, mode, folder, tag string, limit, offset int) (Page, error) {
	expressions, err := ftsMatchExpressions(query, mode)
	if err != nil {
		return Page{}, err
	}
	normalizedMode, err := normalizeSearchMode(mode)
	if err != nil {
		return Page{}, err
	}
	revision := a.currentDataRevision()
	cacheKey := fmt.Sprintf("%s\x00%s\x00%s\x00%s|%d|%d", query, normalizedMode, folder, tag, limit, offset)
	a.cacheMu.Lock()
	for _, entry := range a.searchCache {
		if entry.revision == revision && entry.key == cacheKey {
			page := entry.page
			a.cacheMu.Unlock()
			return page, nil
		}
	}
	a.cacheMu.Unlock()
	// A busca relaxada só entra quando a estrita não encontra nada, então a
	// precisão do caso comum não muda.
	for index, match := range expressions {
		page, err := a.searchNotesWithMatch(match, normalizedMode, folder, tag, limit, offset)
		if err != nil {
			return Page{}, err
		}
		if page.Total == 0 && index < len(expressions)-1 {
			continue
		}
		return a.cacheSearchPage(revision, cacheKey, page), nil
	}
	return a.cacheSearchPage(revision, cacheKey, Page{Limit: limit, Offset: offset}), nil
}

func (a *App) searchNotesWithMatch(match, mode, folder, tag string, limit, offset int) (Page, error) {
	var total int
	if err := a.readDB.QueryRow(`SELECT COUNT(*)
		FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
		WHERE notes_fts MATCH ? AND (n.folder = ? OR ? = '')
		AND (? = '' OR EXISTS (
			SELECT 1 FROM note_tags nt WHERE nt.note_id = n.rowid AND nt.tag = ?
		))`,
		match, folder, folder, tag, tag).Scan(&total); err != nil {
		return Page{}, err
	}

	if mode == "content" {
		rows, err := a.readDB.Query(`SELECT n.rowid, n.title, n.folder,
			highlight(notes_fts, 1, char(30), char(31)), n.updated_at, COALESCE(n.tags, '')
			FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
			WHERE notes_fts MATCH ? AND (n.folder = ? OR ? = '')
			AND (? = '' OR EXISTS (
				SELECT 1 FROM note_tags nt WHERE nt.note_id = n.rowid AND nt.tag = ?
			))
			ORDER BY notes_fts.rank, n.updated_at DESC, n.rowid DESC LIMIT ? OFFSET ?`,
			match, folder, folder, tag, tag, limit, offset)
		if err != nil {
			return Page{}, err
		}
		defer rows.Close()
		items, err := scanContentSummaries(rows)
		if err != nil {
			return Page{}, err
		}
		return Page{Items: items, Total: total, Limit: limit, Offset: offset}, nil
	}

	rows, err := a.readDB.Query(`SELECT n.rowid, n.title, n.folder, substr(COALESCE(n.content, ''), 1, 180), n.updated_at, COALESCE(n.tags, '')
		FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
		WHERE notes_fts MATCH ? AND (n.folder = ? OR ? = '')
		AND (? = '' OR EXISTS (
			SELECT 1 FROM note_tags nt WHERE nt.note_id = n.rowid AND nt.tag = ?
		))
		ORDER BY notes_fts.rank, n.updated_at DESC, n.rowid DESC LIMIT ? OFFSET ?`,
		match, folder, folder, tag, tag, limit, offset)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	items, err := scanSummaries(rows)
	if err != nil {
		return Page{}, err
	}
	return Page{Items: items, Total: total, Limit: limit, Offset: offset}, nil
}

func (a *App) cacheSearchPage(revision uint64, key string, page Page) Page {
	a.cacheMu.Lock()
	a.searchCache = append(a.searchCache, searchPageCache{revision: revision, key: key, page: page})
	if len(a.searchCache) > 8 {
		a.searchCache = a.searchCache[len(a.searchCache)-8:]
	}
	a.cacheMu.Unlock()
	return page
}

// NoteOccurrences returns every excerpt where the query matches the content of
// a single note. The search result card only carries a couple of snippets, so
// expanding a result asks for the complete list on demand.
func (a *App) NoteOccurrences(id int64, query string) ([]string, int, error) {
	expressions, err := ftsMatchExpressions(query, "content")
	if err != nil {
		return nil, 0, err
	}
	for index, match := range expressions {
		var marked string
		err = a.readDB.QueryRow(`SELECT highlight(notes_fts, 1, char(30), char(31))
			FROM notes_fts WHERE rowid = ? AND notes_fts MATCH ?`, id, match).Scan(&marked)
		if errors.Is(err, sql.ErrNoRows) {
			// Mesma ordem de fallback usada na busca: se a expressão estrita não
			// casa com a nota, a relaxada ainda pode encontrar os trechos.
			if index < len(expressions)-1 {
				continue
			}
			return nil, 0, nil
		}
		if err != nil {
			return nil, 0, err
		}
		occurrences := strings.Count(marked, string(contentMatchStart))
		return buildContentSnippets(marked, maxOccurrenceSnippets), occurrences, nil
	}
	return nil, 0, nil
}

const (
	contentMatchStart       = '\x1e'
	contentMatchEnd         = '\x1f'
	maxContentSnippets      = 2
	maxOccurrenceSnippets   = 100
	maxContentSnippetLength = 480
	snippetContextBefore    = 110
	snippetContextAfter     = 190
)

func scanContentSummaries(rows *sql.Rows) ([]NoteSummary, error) {
	items := make([]NoteSummary, 0)
	for rows.Next() {
		var item NoteSummary
		var marked, tags string
		if err := rows.Scan(&item.ID, &item.Title, &item.Folder, &marked, &item.UpdatedAt, &tags); err != nil {
			return nil, err
		}
		item.Tags = splitTags(tags)
		item.Snippets = buildContentSnippets(marked, maxContentSnippets)
		item.Occurrences = strings.Count(marked, string(contentMatchStart))
		if len(item.Snippets) > 0 {
			item.Preview = item.Snippets[0]
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// buildContentSnippets turns the fully highlighted note content produced by
// FTS5 highlight() into short excerpts around the matches.
func buildContentSnippets(marked string, limit int) []string {
	if limit < 1 {
		return nil
	}
	type matchSpan struct{ start, end int }
	spans := make([]matchSpan, 0)
	for index := 0; index < len(marked); index++ {
		if marked[index] != contentMatchStart {
			continue
		}
		relativeEnd := strings.IndexByte(marked[index+1:], contentMatchEnd)
		if relativeEnd < 0 {
			break
		}
		end := index + 1 + relativeEnd + 1
		spans = append(spans, matchSpan{start: index, end: end})
		index = end - 1
	}
	if len(spans) == 0 {
		return nil
	}

	type snippetGroup struct {
		start, end  int
		first, last int
	}
	groups := make([]snippetGroup, 0, limit)
	for _, span := range spans {
		start := max(0, span.start-snippetContextBefore)
		end := min(len(marked), span.end+snippetContextAfter)
		if len(groups) > 0 && start <= groups[len(groups)-1].end &&
			end-groups[len(groups)-1].start <= maxContentSnippetLength {
			last := len(groups) - 1
			groups[last].end = max(groups[last].end, end)
			groups[last].last = span.end
			continue
		}
		groups = append(groups, snippetGroup{start: start, end: end, first: span.start, last: span.end})
	}

	if len(groups) > limit {
		groups = groups[:limit]
	}
	snippets := make([]string, 0, len(groups))
	for _, group := range groups {
		start, end := group.start, group.end
		if start > 0 {
			if offset := strings.IndexAny(marked[start:group.first], " \t\r\n"); offset >= 0 {
				start += offset + 1
			}
		}
		if end < len(marked) {
			if offset := strings.LastIndexAny(marked[group.last:end], " \t\r\n"); offset >= 0 {
				end = group.last + offset
			}
		}
		excerpt := strings.Join(strings.Fields(marked[start:end]), " ")
		if excerpt == "" {
			continue
		}
		excerpt = strings.ReplaceAll(excerpt, string(contentMatchStart), "<mark>")
		excerpt = strings.ReplaceAll(excerpt, string(contentMatchEnd), "</mark>")
		if start > 0 {
			excerpt = "…" + excerpt
		}
		if end < len(marked) {
			excerpt += "…"
		}
		snippets = append(snippets, excerpt)
	}
	return snippets
}

func splitTags(tags string) []string {
	if tags == "" {
		return nil
	}
	result := make([]string, 0)
	for _, tag := range strings.Split(tags, ",") {
		if tag = strings.TrimSpace(tag); tag != "" {
			result = append(result, tag)
		}
	}
	return result
}

func scanSummaries(rows *sql.Rows) ([]NoteSummary, error) {
	items := make([]NoteSummary, 0)
	for rows.Next() {
		var item NoteSummary
		var tags string
		if err := rows.Scan(&item.ID, &item.Title, &item.Folder, &item.Preview, &item.UpdatedAt, &tags); err != nil {
			return nil, err
		}
		item.Tags = splitTags(tags)
		items = append(items, item)
	}
	return items, rows.Err()
}

func normalizeSearchMode(mode string) (string, error) {
	switch mode {
	case "", "title":
		return "title", nil
	case "content":
		return "content", nil
	default:
		return "", errors.New("mode must be title or content")
	}
}

// ftsMatchExpressions returns the search expressions in priority order. The
// strict one requires every term; the relaxed one accepts any term and is used
// when the strict search finds nothing, so a single typo or a different
// inflection does not hide the note completely.
func ftsMatchExpressions(query, mode string) ([]string, error) {
	mode, err := normalizeSearchMode(mode)
	if err != nil {
		return nil, err
	}
	query = strings.TrimSpace(query)
	if query == "" || len([]rune(query)) > 256 {
		return nil, errors.New("query must contain between 1 and 256 characters")
	}
	parts := ftsQueryParts(query)
	if len(parts) == 0 {
		return nil, errors.New("query must contain searchable characters")
	}
	strict := mode + " : (" + strings.Join(parts, " AND ") + ")"
	if len(parts) == 1 {
		return []string{strict}, nil
	}
	return []string{strict, mode + " : (" + strings.Join(parts, " OR ") + ")"}, nil
}

// ftsQueryParts turns the typed query into FTS5 terms. Words are matched by
// prefix ("term"*); text between double quotes becomes an exact phrase.
func ftsQueryParts(query string) []string {
	runes := []rune(query)
	parts := make([]string, 0, 4)
	seen := make(map[string]struct{}, 4)
	add := func(part string) {
		if _, exists := seen[part]; exists {
			return
		}
		seen[part] = struct{}{}
		parts = append(parts, part)
	}
	for index := 0; index < len(runes); {
		if runes[index] == '"' {
			index++
			var phrase strings.Builder
			for index < len(runes) && runes[index] != '"' {
				if unicode.IsLetter(runes[index]) || unicode.IsNumber(runes[index]) || unicode.IsSpace(runes[index]) {
					phrase.WriteRune(runes[index])
				} else {
					phrase.WriteRune(' ')
				}
				index++
			}
			if index < len(runes) {
				index++
			}
			if words := strings.Join(strings.Fields(phrase.String()), " "); words != "" {
				add(`"` + strings.ReplaceAll(words, `"`, `""`) + `"`)
			}
			continue
		}
		if unicode.IsLetter(runes[index]) || unicode.IsNumber(runes[index]) {
			start := index
			for index < len(runes) && (unicode.IsLetter(runes[index]) || unicode.IsNumber(runes[index])) {
				index++
			}
			add(`"` + string(runes[start:index]) + `"*`)
			continue
		}
		index++
	}
	return parts
}

func (a *App) GetNote(id int64) (Note, error) {
	var note Note
	var tags string
	err := a.readDB.QueryRow(`SELECT rowid, title, COALESCE(content, ''), COALESCE(folder, ''),
		COALESCE(tags, ''), version, created_at, updated_at FROM notes WHERE rowid = ?`, id).
		Scan(&note.ID, &note.Title, &note.Content, &note.Folder, &tags, &note.Version,
			&note.CreatedAt, &note.UpdatedAt)
	if err != nil {
		return Note{}, err
	}
	if tags != "" {
		for _, tag := range strings.Split(tags, ",") {
			if tag = strings.TrimSpace(tag); tag != "" {
				note.Tags = append(note.Tags, tag)
			}
		}
	}
	return note, nil
}

func (a *App) CreateNote(note Note) (int64, error) {
	if err := validateNote(&note); err != nil {
		return 0, err
	}
	tx, err := a.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	result, err := tx.Exec("INSERT INTO notes(title, content, folder, tags) VALUES (?, ?, ?, ?)",
		note.Title, note.Content, note.Folder, strings.Join(note.Tags, ","))
	if err != nil {
		return 0, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	if err := replaceNoteLinks(tx, id, note.Content); err != nil {
		return 0, err
	}
	if err := syncNoteMetadata(tx, id, note.Content, note.Tags); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	a.markDataChanged()
	a.notifyChange()
	return id, nil
}

func (a *App) UpdateNote(id int64, note Note) error {
	if err := validateNote(&note); err != nil {
		return err
	}
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var oldTitle, oldFolder string
	var oldVersion int64
	if err := tx.QueryRow("SELECT title, COALESCE(folder, ''), version FROM notes WHERE rowid = ?", id).
		Scan(&oldTitle, &oldFolder, &oldVersion); err != nil {
		return err
	}
	if note.Version > 0 && note.Version != oldVersion {
		return ErrVersionConflict
	}
	titleChanged := oldTitle != note.Title
	folderChanged := oldFolder != note.Folder
	var before []indexedNote
	var byPath, byTitle map[string]int64
	if titleChanged || folderChanged {
		index, err := a.noteIndex()
		if err != nil {
			return err
		}
		before = index.notes
		if titleChanged && !folderChanged {
			byPath, byTitle = index.byPath, index.byTitle
		}
	}
	result, err := tx.Exec(`UPDATE notes SET title = ?, content = ?, folder = ?, tags = ?,
		version = version + 1, updated_at = datetime('now') WHERE rowid = ?`,
		note.Title, note.Content, note.Folder, strings.Join(note.Tags, ","), id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return sql.ErrNoRows
	}
	if folderChanged {
		after := notesWithFolder(before, id, note.Title, note.Folder)
		if err := relinkNotesAfterMove(tx, before, after, id); err != nil {
			return err
		}
	} else if titleChanged {
		if err := rewriteIncomingLinks(tx, id, note.Title, byPath, byTitle); err != nil {
			return err
		}
	}
	if err := replaceNoteLinks(tx, id, note.Content); err != nil {
		return err
	}
	if err := syncNoteMetadata(tx, id, note.Content, note.Tags); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	a.markDataChanged()
	if titleChanged || folderChanged {
		a.notifyChange()
	}
	return nil
}

func (a *App) MoveNoteFolder(id int64, folder string) error {
	normalized, err := normalizeFolder(folder)
	if err != nil || normalized != folder {
		return errors.New("folder must be a normalized relative path")
	}
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	index, err := a.noteIndex()
	if err != nil {
		return err
	}
	before := index.notes
	old, found := indexedNoteByID(before, id)
	if !found {
		// The cache should contain every note; fall back to the transaction
		// view if an inconsistent write ever left it behind.
		before, err = readNotesForLinksWith(tx)
		if err != nil {
			return err
		}
		old, found = indexedNoteByID(before, id)
	}
	result, err := tx.Exec(`UPDATE notes SET folder = ?, version = version + 1,
		updated_at = datetime('now') WHERE rowid = ?`, folder, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return sql.ErrNoRows
	}
	if found && old.Folder != folder {
		after := notesWithFolder(before, id, old.Title, folder)
		if err := relinkNotesAfterMove(tx, before, after, 0); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	a.markDataChanged()
	a.notifyChange()
	return nil
}

func (a *App) MoveFolder(source, target string) (string, int64, error) {
	normalizedSource, err := normalizeFolder(source)
	if err != nil || normalizedSource != source || source == "" {
		return "", 0, errors.New("source must be a non-empty normalized folder path")
	}
	normalizedTarget, err := normalizeFolder(target)
	if err != nil || normalizedTarget != target {
		return "", 0, errors.New("target must be a normalized relative folder path")
	}
	if target == source || strings.HasPrefix(target, source+"/") {
		return "", 0, errors.New("a folder cannot be moved into itself or one of its descendants")
	}

	name := path.Base(source)
	destination := name
	if target != "" {
		destination = path.Join(target, name)
	}
	return a.moveFolder(source, destination)
}

// RenameFolder changes only the final segment of a folder path, keeping its
// parent and rewriting every note below it.
func (a *App) RenameFolder(source, name string) (string, int64, error) {
	normalizedSource, err := normalizeFolder(source)
	if err != nil || normalizedSource != source || source == "" {
		return "", 0, errors.New("source must be a non-empty normalized folder path")
	}
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." ||
		strings.ContainsAny(name, `/\`) || len([]byte(name)) > 255 {
		return "", 0, errors.New("folder name must be a single non-empty path segment")
	}
	parent := path.Dir(source)
	destination := name
	if parent != "." {
		destination = path.Join(parent, name)
	}
	return a.moveFolder(source, destination)
}

func (a *App) DeleteFolder(folder string) (int64, error) {
	normalized, err := normalizeFolder(folder)
	if err != nil || normalized != folder || folder == "" {
		return 0, errors.New("folder must be a non-empty normalized relative path")
	}

	tx, err := a.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var noteCount, folderCount int64
	if err := tx.QueryRow(`SELECT COUNT(*) FROM notes
		WHERE folder = ? OR substr(folder, 1, length(?) + 1) = ? || '/'`,
		folder, folder, folder).Scan(&noteCount); err != nil {
		return 0, err
	}
	if err := tx.QueryRow(`SELECT COUNT(*) FROM folders
		WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'`,
		folder, folder, folder).Scan(&folderCount); err != nil {
		return 0, err
	}
	if noteCount == 0 && folderCount == 0 {
		return 0, sql.ErrNoRows
	}

	index, err := a.noteIndex()
	if err != nil {
		return 0, err
	}
	before := index.notes
	if _, err := tx.Exec(`UPDATE notes SET folder = '', version = version + 1,
		updated_at = datetime('now')
		WHERE folder = ? OR substr(folder, 1, length(?) + 1) = ? || '/'`,
		folder, folder, folder); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`DELETE FROM folders
		WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'`,
		folder, folder, folder); err != nil {
		return 0, err
	}
	after := notesAfterFolderDelete(before, folder)
	if err := relinkNotesAfterMove(tx, before, after, 0); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	a.markDataChanged()
	a.notifyChange()
	return noteCount, nil
}

func (a *App) moveFolder(source, destination string) (string, int64, error) {
	if len(destination) > 1024 {
		return "", 0, errors.New("destination folder path exceeds the 1024 character limit")
	}
	if destination == source {
		return "", 0, errors.New("folder is already in that location")
	}
	if strings.HasPrefix(destination, source+"/") {
		return "", 0, errors.New("a folder cannot be moved into itself or one of its descendants")
	}

	tx, err := a.db.Begin()
	if err != nil {
		return "", 0, err
	}
	defer tx.Rollback()
	index, err := a.noteIndex()
	if err != nil {
		return "", 0, err
	}
	before := index.notes

	var count, folderCount int64
	if err := tx.QueryRow(`SELECT COUNT(*) FROM notes
		WHERE folder = ? OR substr(folder, 1, length(?) + 1) = ? || '/'`,
		source, source, source).Scan(&count); err != nil {
		return "", 0, err
	}
	if err := tx.QueryRow(`SELECT COUNT(*) FROM folders
		WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'`,
		source, source, source).Scan(&folderCount); err != nil {
		return "", 0, err
	}
	if count == 0 && folderCount == 0 {
		return "", 0, sql.ErrNoRows
	}
	var maxPathLength int
	if err := tx.QueryRow(`SELECT COALESCE(MAX(length(CAST(? || substr(folder, length(?) + 1) AS BLOB))), 0)
		FROM notes WHERE folder = ? OR substr(folder, 1, length(?) + 1) = ? || '/'`,
		destination, source, source, source, source).Scan(&maxPathLength); err != nil {
		return "", 0, err
	}
	if maxPathLength > 1024 {
		return "", 0, errors.New("destination would make a folder path exceed the 1024 byte limit")
	}
	rows, err := tx.Query(`SELECT path FROM folders
		WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'`, source, source, source)
	if err != nil {
		return "", 0, err
	}
	folderPaths := make([]string, 0, folderCount)
	for rows.Next() {
		var folder string
		if err := rows.Scan(&folder); err != nil {
			rows.Close()
			return "", 0, err
		}
		movedPath := destination + strings.TrimPrefix(folder, source)
		if len([]byte(movedPath)) > 1024 {
			rows.Close()
			return "", 0, errors.New("destination would make a folder path exceed the 1024 byte limit")
		}
		folderPaths = append(folderPaths, movedPath)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return "", 0, err
	}
	if err := rows.Close(); err != nil {
		return "", 0, err
	}
	if _, err := tx.Exec(`UPDATE notes SET folder = ? || substr(folder, length(?) + 1),
		version = version + 1, updated_at = datetime('now')
		WHERE folder = ? OR substr(folder, 1, length(?) + 1) = ? || '/'`,
		destination, source, source, source, source); err != nil {
		return "", 0, err
	}
	if _, err := tx.Exec(`DELETE FROM folders
		WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'`, source, source, source); err != nil {
		return "", 0, err
	}
	for _, folder := range folderPaths {
		if err := insertFolderPath(tx, folder); err != nil {
			return "", 0, err
		}
	}
	after := notesAfterFolderMove(before, source, destination)
	if err := relinkNotesAfterMove(tx, before, after, 0); err != nil {
		return "", 0, err
	}
	if err := tx.Commit(); err != nil {
		return "", 0, err
	}
	a.markDataChanged()
	a.notifyChange()
	return destination, count, nil
}

func (a *App) DeleteNote(id int64) error {
	a.dataMu.Lock()
	defer a.dataMu.Unlock()

	result, err := a.db.Exec("DELETE FROM notes WHERE rowid = ?", id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return sql.ErrNoRows
	}
	noteDir := filepath.Join(a.attachmentsDir, strconv.FormatInt(id, 10))
	if err := os.RemoveAll(noteDir); err != nil {
		log.Printf("remove attachments for deleted note %d: %v", id, err)
	}
	a.markDataChanged()
	a.notifyChange()
	return nil
}

func validateNote(note *Note) error {
	note.Title = strings.TrimSpace(note.Title)
	if note.Title == "" || len([]rune(note.Title)) > 256 {
		return errors.New("title must contain between 1 and 256 characters")
	}
	if len(note.Content) > maxContentSize {
		return errors.New("content exceeds the 5 MiB limit")
	}
	folder, err := normalizeFolder(note.Folder)
	if err != nil {
		return err
	}
	note.Folder = folder
	if tags, found := frontmatterTags(note.Content); found {
		note.Tags = tags
	}
	for i := range note.Tags {
		note.Tags[i] = strings.TrimSpace(note.Tags[i])
		if strings.Contains(note.Tags[i], ",") {
			return errors.New("tags cannot contain commas")
		}
	}
	return nil
}

func frontmatterTags(content string) ([]string, bool) {
	if !hasFrontmatter(content) {
		return nil, false
	}
	lines := strings.Split(content, "\n")
	if len(lines) < 3 || strings.TrimSpace(lines[0]) != "---" {
		return nil, false
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if marker := strings.TrimSpace(lines[i]); marker == "---" || marker == "..." {
			end = i
			break
		}
	}
	if end < 0 {
		return nil, false
	}
	for i := 1; i < end; i++ {
		key, value, found := strings.Cut(strings.TrimSpace(lines[i]), ":")
		if !found || strings.TrimSpace(strings.TrimSuffix(key, " ")) != "tags" {
			continue
		}
		value = strings.TrimSpace(value)
		if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
			value = strings.TrimSpace(value[1 : len(value)-1])
		}
		tags := make([]string, 0)
		if value != "" {
			for _, tag := range strings.Split(value, ",") {
				tag = strings.TrimSpace(strings.Trim(tag, `"'`))
				if tag != "" {
					tags = append(tags, tag)
				}
			}
		} else {
			for j := i + 1; j < end; j++ {
				item := strings.TrimSpace(lines[j])
				if !strings.HasPrefix(item, "-") {
					if strings.Contains(item, ":") {
						break
					}
					continue
				}
				tag := strings.TrimSpace(strings.Trim(strings.TrimSpace(strings.TrimPrefix(item, "-")), `"'`))
				if tag != "" {
					tags = append(tags, tag)
				}
			}
		}
		return tags, true
	}
	return nil, false
}

// hasFrontmatter cheaply checks the first line before any full-content split.
// Notes without metadata are the common case, and splitting several MiB just
// to discover there is no frontmatter is wasteful.
func hasFrontmatter(content string) bool {
	end := strings.IndexByte(content, '\n')
	if end < 0 {
		end = len(content)
	}
	return strings.TrimSpace(content[:end]) == "---"
}

func normalizeFolder(value string) (string, error) {
	if len(value) > 1024 {
		return "", errors.New("folder path exceeds the 1024 character limit")
	}
	folder := strings.TrimSpace(strings.ReplaceAll(value, `\`, "/"))
	if strings.HasPrefix(folder, "/") {
		return "", errors.New("folder path must be relative")
	}
	if folder != "" {
		for _, component := range strings.Split(folder, "/") {
			if component == ".." {
				return "", errors.New("folder path cannot contain '..'")
			}
		}
		folder = path.Clean(folder)
		if folder == "." {
			folder = ""
		}
	}
	return folder, nil
}

func (a *App) FolderTree() ([]Folder, error) {
	rows, err := a.readDB.Query(`SELECT path FROM folders
		UNION SELECT DISTINCT folder FROM notes WHERE folder != ''
		ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	root := &folderBuilder{children: make(map[string]*folderBuilder)}
	for rows.Next() {
		var folder string
		if err := rows.Scan(&folder); err != nil {
			return nil, err
		}
		current := root
		parts := strings.Split(strings.Trim(folder, "/"), "/")
		currentPath := ""
		for _, name := range parts {
			if name == "" {
				continue
			}
			if currentPath == "" {
				currentPath = name
			} else {
				currentPath += "/" + name
			}
			child := current.children[name]
			if child == nil {
				child = &folderBuilder{Folder: Folder{Name: name, Path: currentPath}, children: make(map[string]*folderBuilder)}
				current.children[name] = child
			}
			current = child
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return folderValues(root), nil
}

func folderValues(parent *folderBuilder) []Folder {
	names := make([]string, 0, len(parent.children))
	for name := range parent.children {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]Folder, 0, len(names))
	for _, name := range names {
		child := parent.children[name]
		child.Children = folderValues(child)
		result = append(result, child.Folder)
	}
	return result
}

func (a *App) Handler(frontendDir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", a.handleHealth)
	mux.HandleFunc("/api/auth/status", a.auth.status)
	mux.HandleFunc("/api/auth/login", a.auth.login)
	mux.HandleFunc("/api/auth/logout", a.auth.logout)
	mux.HandleFunc("/api/notes", a.handleNotes)
	mux.HandleFunc("/api/notes/", a.handleNote)
	mux.HandleFunc("/api/search", a.handleSearch)
	mux.HandleFunc("/api/tags", a.handleTags)
	mux.HandleFunc("/api/tasks", a.handleTasks)
	mux.HandleFunc("/api/task-markers", a.handleTaskMarkers)
	mux.HandleFunc("/api/backup", a.handleBackup)
	mux.HandleFunc("/api/folders", a.handleFolders)
	mux.HandleFunc("/api/folders/move", a.handleFolderMove)
	mux.HandleFunc("/api/folders/rename", a.handleFolderRename)
	mux.HandleFunc("/api/folders/delete", a.handleFolderDelete)
	mux.HandleFunc("/api/folder-notes", a.handleFolderNotes)
	mux.HandleFunc("/api/events", a.handleEvents)
	mux.HandleFunc("/api/table", a.handleTable)
	mux.HandleFunc("/api/graph", a.handleGraph)
	mux.HandleFunc("/api/preview", a.handlePreview)
	mux.Handle("/", publicFrontendFiles(staticFiles(frontendDir)))
	return requestLogger(a.auth.middleware(gzipResponses(mux)))
}

// requestLogger records failed or slow requests plus API mutations. Static
// assets and the high-frequency preview endpoint stay quiet on the happy path.
func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		elapsed := time.Since(start)
		isAPIMutation := strings.HasPrefix(r.URL.Path, "/api/") &&
			r.Method != http.MethodGet && r.URL.Path != "/api/preview"
		isEventStream := r.URL.Path == "/api/events"
		if !isEventStream && (recorder.status >= http.StatusBadRequest || elapsed >= 500*time.Millisecond || isAPIMutation) {
			log.Printf("%s %s %d %dB %s", r.Method, r.URL.RequestURI(), recorder.status,
				recorder.bytes, elapsed.Round(time.Millisecond))
		}
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	bytes       int
	wroteHeader bool
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.wroteHeader {
		return
	}
	r.wroteHeader = true
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(data []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	written, err := r.ResponseWriter.Write(data)
	r.bytes += written
	return written, err
}

// Unwrap lets http.ResponseController reach the underlying connection, which
// is required for flushing server-sent events through the logging wrapper.
func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.db.PingContext(ctx); err != nil {
		log.Printf("health check: %v", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "error"})
		return
	}
	if err := a.readDB.PingContext(ctx); err != nil {
		log.Printf("health check (read pool): %v", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *App) handleNotes(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		limit, offset, err := pageParameters(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		page, err := a.ListNotes(r.URL.Query().Get("folder"), r.URL.Query().Get("tag"), limit, offset)
		if err != nil {
			log.Printf("list notes: %v", err)
			http.Error(w, "failed to list notes", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, page)
	case http.MethodPost:
		var note Note
		if err := decodeNote(w, r, &note); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := validateNote(&note); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		id, err := a.CreateNote(note)
		if err != nil {
			log.Printf("create note: %v", err)
			http.Error(w, "failed to create note", http.StatusInternalServerError)
			return
		}
		created, err := a.GetNote(id)
		if err != nil {
			log.Printf("read created note %d: %v", id, err)
			http.Error(w, "note created but could not be loaded", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, created)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) handleNote(w http.ResponseWriter, r *http.Request) {
	rawID := strings.TrimPrefix(r.URL.Path, "/api/notes/")
	parts := strings.Split(rawID, "/")
	id, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || id < 1 || len(parts) > 4 {
		http.Error(w, "invalid note ID", http.StatusBadRequest)
		return
	}
	if len(parts) >= 2 && parts[1] == "versions" {
		http.Error(w, "note history is no longer available", http.StatusNotFound)
		return
	}
	if len(parts) == 2 && parts[1] == "folder" {
		a.handleNoteFolderMove(w, r, id)
		return
	}
	if len(parts) == 2 && parts[1] == "backlinks" {
		a.handleBacklinks(w, r, id)
		return
	}
	if len(parts) == 2 && parts[1] == "occurrences" {
		a.handleNoteOccurrences(w, r, id)
		return
	}
	if len(parts) >= 2 && parts[1] == "attachments" {
		if len(parts) == 2 {
			a.handleAttachments(w, r, id)
			return
		}
		if len(parts) == 3 {
			attachmentID, parseErr := strconv.ParseInt(parts[2], 10, 64)
			if parseErr != nil || attachmentID < 1 {
				http.Error(w, "invalid attachment ID", http.StatusBadRequest)
				return
			}
			a.handleAttachment(w, r, id, attachmentID)
			return
		}
	}
	if len(parts) != 1 {
		http.Error(w, "invalid note endpoint", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet:
		note, err := a.GetNote(id)
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
			return
		}
		if err != nil {
			log.Printf("get note %d: %v", id, err)
			http.Error(w, "failed to load note", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, note)
	case http.MethodPut:
		var note Note
		if err := decodeNote(w, r, &note); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := validateNote(&note); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := a.UpdateNote(id, note); errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
		} else if errors.Is(err, ErrVersionConflict) {
			current, getErr := a.GetNote(id)
			if getErr != nil {
				log.Printf("read conflicting note %d: %v", id, getErr)
				http.Error(w, "note was modified by another session", http.StatusConflict)
				return
			}
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": "note was modified by another session",
				"note":  current,
			})
		} else if err != nil {
			log.Printf("update note %d: %v", id, err)
			http.Error(w, "failed to update note", http.StatusInternalServerError)
		} else {
			updated, err := a.GetNote(id)
			if err != nil {
				log.Printf("read updated note %d: %v", id, err)
				http.Error(w, "note saved but could not be loaded", http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, updated)
		}
	case http.MethodDelete:
		if err := a.DeleteNote(id); errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
		} else if err != nil {
			log.Printf("delete note %d: %v", id, err)
			http.Error(w, "failed to delete note", http.StatusInternalServerError)
		} else {
			w.WriteHeader(http.StatusNoContent)
		}
	default:
		methodNotAllowed(w)
	}
}

func (a *App) handleNoteOccurrences(w http.ResponseWriter, r *http.Request, id int64) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		http.Error(w, "missing search query", http.StatusBadRequest)
		return
	}
	snippets, occurrences, err := a.NoteOccurrences(id, query)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"snippets":    snippets,
		"occurrences": occurrences,
	})
}

func (a *App) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	limit, offset, err := pageParameters(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	page, err := a.SearchNotes(r.URL.Query().Get("q"), r.URL.Query().Get("mode"),
		r.URL.Query().Get("folder"), r.URL.Query().Get("tag"), limit, offset)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (a *App) handleFolders(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var request struct {
			Path string `json:"path"`
		}
		if err := decodeJSON(w, r, &request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		normalized, err := normalizeFolder(request.Path)
		if err != nil || normalized != request.Path || normalized == "" {
			http.Error(w, "path must be a non-empty normalized relative folder path", http.StatusBadRequest)
			return
		}
		err = a.CreateFolder(normalized)
		if errors.Is(err, ErrFolderExists) {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		if err != nil {
			log.Printf("create folder %q: %v", normalized, err)
			http.Error(w, "failed to create folder", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]string{"path": normalized})
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	// Read the revision before the query so a change committed while the tree
	// is being built still produces an event with a higher revision.
	revision := a.currentRevision()
	folders, err := a.FolderTree()
	if err != nil {
		log.Printf("load folder tree: %v", err)
		http.Error(w, "failed to load folders", http.StatusInternalServerError)
		return
	}
	w.Header().Set("X-Notes-Revision", strconv.FormatUint(revision, 10))
	writeJSON(w, http.StatusOK, folders)
}

func (a *App) CreateFolder(folder string) error {
	normalized, err := normalizeFolder(folder)
	if err != nil || normalized != folder || folder == "" {
		return errors.New("folder path must be a non-empty normalized relative path")
	}
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists int
	if err := tx.QueryRow(`SELECT
		EXISTS(SELECT 1 FROM folders WHERE path = ?) OR
		EXISTS(SELECT 1 FROM notes
			WHERE folder = ? OR substr(folder, 1, length(?) + 1) = ? || '/')`,
		folder, folder, folder, folder).Scan(&exists); err != nil {
		return err
	}
	if exists != 0 {
		return ErrFolderExists
	}
	if err := insertFolderPath(tx, folder); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	a.notifyChange()
	return nil
}

func (a *App) handleTags(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	tags, err := a.Tags()
	if err != nil {
		log.Printf("load tags: %v", err)
		http.Error(w, "failed to load tags", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, tags)
}

func (a *App) handleTasks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	var markers []string
	if raw := strings.TrimSpace(r.URL.Query().Get("markers")); raw != "" {
		parsed, err := ParseTaskMarkers(raw)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		markers = parsed
	} else {
		saved, err := a.TaskMarkers()
		if err != nil {
			log.Printf("load task markers: %v", err)
			http.Error(w, "failed to load task markers", http.StatusInternalServerError)
			return
		}
		markers = saved
	}
	tasks, err := a.listTasks(markers, taskLimit(r), taskOffset(r))
	if err != nil {
		log.Printf("load tasks: %v", err)
		http.Error(w, "failed to load tasks", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, tasks)
}

func taskLimit(r *http.Request) int {
	limit := maxTaskResults
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= maxTaskResults {
			limit = parsed
		}
	}
	return limit
}

func taskOffset(r *http.Request) int {
	offset := 0
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 0 {
			offset = parsed
		}
	}
	return offset
}

func (a *App) handleFolderMove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var request struct {
		Source string `json:"source"`
		Target string `json:"target"`
	}
	if err := decodeJSON(w, r, &request); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	destination, count, err := a.MoveFolder(request.Source, request.Target)
	if errors.Is(err, sql.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"folder": destination, "moved": count})
}

func (a *App) handleFolderRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var request struct {
		Source string `json:"source"`
		Name   string `json:"name"`
	}
	if err := decodeJSON(w, r, &request); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	destination, count, err := a.RenameFolder(request.Source, request.Name)
	if errors.Is(err, sql.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"folder": destination, "moved": count})
}

func (a *App) handleFolderDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var request struct {
		Path string `json:"path"`
	}
	if err := decodeJSON(w, r, &request); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	count, err := a.DeleteFolder(request.Path)
	if errors.Is(err, sql.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"moved": count})
}

func (a *App) handleNoteFolderMove(w http.ResponseWriter, r *http.Request, id int64) {
	if r.Method != http.MethodPatch {
		methodNotAllowed(w)
		return
	}
	var request struct {
		Folder string `json:"folder"`
	}
	if err := decodeJSON(w, r, &request); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := a.MoveNoteFolder(id, request.Folder); errors.Is(err, sql.ErrNoRows) {
		http.NotFound(w, r)
	} else if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
	} else {
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "folder": request.Folder})
	}
}

func (a *App) handleFolderNotes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	limit, offset, err := pageParameters(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	folder := r.URL.Query().Get("folder")
	normalized, err := normalizeFolder(folder)
	if err != nil || normalized != folder {
		http.Error(w, "folder must be a normalized relative path", http.StatusBadRequest)
		return
	}
	page, err := a.ListFolderNotes(folder, limit, offset)
	if err != nil {
		log.Printf("list notes in folder %q: %v", folder, err)
		http.Error(w, "failed to list folder notes", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func pageParameters(r *http.Request) (int, int, error) {
	limit := defaultPageSize
	offset := 0
	var err error
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > maxPageSize {
			return 0, 0, fmt.Errorf("limit must be between 1 and %d", maxPageSize)
		}
	}
	if raw := r.URL.Query().Get("offset"); raw != "" {
		offset, err = strconv.Atoi(raw)
		if err != nil || offset < 0 {
			return 0, 0, errors.New("offset must be a non-negative integer")
		}
	}
	return limit, offset, nil
}

func decodeNote(w http.ResponseWriter, r *http.Request, note *Note) error {
	return decodeJSON(w, r, note)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestSize)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("invalid JSON request: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("request must contain one JSON object")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write JSON response: %v", err)
	}
}

func methodNotAllowed(w http.ResponseWriter) {
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}

func main() {
	defaultDataDir := os.Getenv("NOTES_DIR")
	if defaultDataDir == "" {
		defaultDataDir = "./data"
	}
	// Normalize to absolute path if relative (for consistency with run.sh)
	if !filepath.IsAbs(defaultDataDir) {
		defaultDataDir = filepath.Clean(filepath.Join("./", defaultDataDir))
	}
	defaultPort := os.Getenv("PORT")
	if defaultPort == "" {
		defaultPort = "8000"
	}
	dataDir := flag.String("data-dir", defaultDataDir, "Directory for SQLite note data")
	port := flag.String("port", defaultPort, "HTTP port")
	flag.Parse()
	portNumber, err := strconv.Atoi(*port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		log.Fatalf("invalid port %q: expected 1-65535", *port)
	}

	app, err := NewApp(*dataDir)
	if err != nil {
		log.Fatalf("initialize application: %v", err)
	}
	defer app.Close()

	ntfyConfig, err := LoadNtfyConfig()
	if err != nil {
		log.Fatalf("configure ntfy capture: %v", err)
	}
	var ntfyMonitor *NtfyMonitor
	if ntfyConfig.Enabled {
		ntfyMonitor, err = NewNtfyMonitor(app, ntfyConfig)
		if err != nil {
			log.Fatalf("configure ntfy capture: %v", err)
		}
	}

	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", portNumber),
		Handler:           app.Handler("./web/frontend"),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Minute,
		WriteTimeout:      10 * time.Minute,
		IdleTimeout:       120 * time.Second,
	}
	signals, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	var ntfyDone chan struct{}
	if ntfyMonitor != nil {
		ntfyDone = make(chan struct{})
		go func() {
			defer close(ntfyDone)
			log.Printf("ntfy capture enabled for topic %q into folder %q",
				ntfyConfig.Topic, ntfyConfig.Folder)
			if err := ntfyMonitor.Run(signals); err != nil {
				log.Printf("ntfy monitor stopped: %v", err)
			}
		}()
	}

	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-signals.Done()
		log.Printf("Shutting down; closing database cleanly")
		app.closeEvents()
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			log.Printf("HTTP shutdown: %v", err)
		}
	}()
	log.Printf("Invariante listening on http://localhost:%d", portNumber)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve application: %v", err)
	}
	<-shutdownDone
	if ntfyDone != nil {
		<-ntfyDone
	}
}
