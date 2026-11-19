package main

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// DefaultTaskMarkers are the words that turn a line into a task when they
// appear as a standalone word. They mirror the default list in the frontend.
var DefaultTaskMarkers = []string{"TODO", "FIXME", "HACK", "XXX", "BUG", "NOTE"}

const (
	maxTaskMarkers      = 20
	maxTaskMarkerLength = 32
	maxTaskTextRunes    = 240
	maxTaskResults      = 5000
	taskMarkersKey      = "task_markers"
)

var taskMarkerPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_-]*$`)

type TaskMarkerSettings struct {
	Markers []string `json:"markers"`
}

type NoteTask struct {
	NoteID    int64  `json:"note_id"`
	NoteTitle string `json:"note_title"`
	Folder    string `json:"folder"`
	Marker    string `json:"marker"`
	Text      string `json:"text"`
	Line      int    `json:"line"`
	UpdatedAt string `json:"updated_at"`
}

type TaskList struct {
	Items     []NoteTask `json:"items"`
	Total     int        `json:"total"`
	Markers   []string   `json:"markers"`
	Limit     int        `json:"limit,omitempty"`
	Offset    int        `json:"offset,omitempty"`
	Truncated bool       `json:"truncated,omitempty"`
}

type taskMatch struct {
	Marker string
	Text   string
	Line   int
}

// ParseTaskMarkers normalizes a comma/space separated marker list. An empty
// list falls back to DefaultTaskMarkers so the UI can always request tasks.
func ParseTaskMarkers(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return append([]string(nil), DefaultTaskMarkers...), nil
	}
	markers := make([]string, 0, 4)
	seen := make(map[string]struct{})
	for _, value := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || unicode.IsSpace(r)
	}) {
		marker := strings.TrimRight(strings.TrimSpace(value), ":")
		if marker == "" {
			continue
		}
		if len([]rune(marker)) > maxTaskMarkerLength || !taskMarkerPattern.MatchString(marker) {
			return nil, fmt.Errorf("invalid task marker %q", value)
		}
		if _, duplicate := seen[marker]; duplicate {
			continue
		}
		seen[marker] = struct{}{}
		markers = append(markers, marker)
	}
	if len(markers) == 0 {
		return append([]string(nil), DefaultTaskMarkers...), nil
	}
	if len(markers) > maxTaskMarkers {
		return nil, fmt.Errorf("use at most %d task markers", maxTaskMarkers)
	}
	return markers, nil
}

// TaskMarkers returns the application-wide marker list. The defaults are used
// until someone saves a custom list in the settings panel.
func (a *App) TaskMarkers() ([]string, error) {
	var raw string
	err := a.readDB.QueryRow("SELECT value FROM app_settings WHERE key = ?", taskMarkersKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return append([]string(nil), DefaultTaskMarkers...), nil
	}
	if err != nil {
		return nil, err
	}
	return ParseTaskMarkers(raw)
}

// SaveTaskMarkers validates and stores the marker list in SQLite so the same
// configuration is shared by every browser connected to the server. The task
// index is rebuilt in the same transaction because its rows are derived from
// the active marker list.
func (a *App) SaveTaskMarkers(markers []string) ([]string, error) {
	normalized, err := ParseTaskMarkers(strings.Join(markers, ","))
	if err != nil {
		return nil, err
	}
	tx, err := a.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO app_settings(key, value, updated_at)
		VALUES (?, ?, datetime('now'))
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
		taskMarkersKey, strings.Join(normalized, ",")); err != nil {
		return nil, err
	}
	if err := rebuildNoteTasks(tx, normalized); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	// The in-memory task pages were built with the previous marker list.
	a.markDataChanged()
	return normalized, nil
}

func (a *App) handleTaskMarkers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		markers, err := a.TaskMarkers()
		if err != nil {
			log.Printf("load task markers: %v", err)
			http.Error(w, "failed to load task markers", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, TaskMarkerSettings{Markers: markers})
	case http.MethodPut:
		var request TaskMarkerSettings
		if err := decodeJSON(w, r, &request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		markers, err := a.SaveTaskMarkers(request.Markers)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, TaskMarkerSettings{Markers: markers})
	default:
		methodNotAllowed(w)
	}
}

// ListTasks scans every note and returns the lines that contain one of the
// requested markers. Notes keep the most recently updated order so the panel
// shows fresh material first.
func (a *App) ListTasks(markers []string) (TaskList, error) {
	return a.listTasks(markers, maxTaskResults, 0)
}

func (a *App) listTasks(markers []string, limit, offset int) (TaskList, error) {
	if limit < 1 {
		limit = maxTaskResults
	}
	if limit > maxTaskResults {
		limit = maxTaskResults
	}
	if offset < 0 {
		offset = 0
	}
	revision := a.currentDataRevision()
	cacheKey := strings.Join(markers, "\x00") + fmt.Sprintf("|%d|%d", limit, offset)
	a.cacheMu.Lock()
	for _, entry := range a.taskCache {
		if entry.revision == revision && entry.key == cacheKey {
			list := entry.list
			a.cacheMu.Unlock()
			return list, nil
		}
	}
	a.cacheMu.Unlock()

	items := make([]NoteTask, 0, min(limit, 32))
	patterns := compileTaskPatterns(markers)
	if len(patterns) == 0 {
		return TaskList{Items: items, Total: 0, Markers: markers, Limit: limit, Offset: offset}, nil
	}

	// The incremental index stores exactly the tasks of the configured marker
	// list, so any subset can be answered without touching note contents. A
	// request for markers that were never indexed still falls back to the full
	// scan below to preserve correctness for ad-hoc marker lists.
	indexed, err := a.TaskMarkers()
	if err != nil {
		return TaskList{}, err
	}
	var list TaskList
	if taskMarkersCover(indexed, markers) {
		list, err = a.listTasksFromIndex(markers, limit, offset)
	} else {
		list, err = a.listTasksByScan(patterns, markers, limit, offset)
	}
	if err != nil {
		return TaskList{}, err
	}
	a.cacheMu.Lock()
	a.taskCache = append(a.taskCache, taskPageCache{revision: revision, key: cacheKey, list: list})
	if len(a.taskCache) > 12 {
		a.taskCache = a.taskCache[len(a.taskCache)-12:]
	}
	a.cacheMu.Unlock()
	return list, nil
}

// taskMarkersCover reports whether every requested marker is present in the
// marker list used to build note_tasks.
func taskMarkersCover(indexed, requested []string) bool {
	if len(requested) == 0 {
		return false
	}
	available := make(map[string]struct{}, len(indexed))
	for _, marker := range indexed {
		available[marker] = struct{}{}
	}
	for _, marker := range requested {
		if _, found := available[marker]; !found {
			return false
		}
	}
	return true
}

func (a *App) listTasksFromIndex(markers []string, limit, offset int) (TaskList, error) {
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(markers)), ",")
	arguments := make([]any, len(markers))
	for index, marker := range markers {
		arguments[index] = marker
	}
	var total int
	if err := a.readDB.QueryRow(`SELECT COUNT(*) FROM note_tasks WHERE marker IN (`+placeholders+`)`,
		arguments...).Scan(&total); err != nil {
		return TaskList{}, err
	}
	queryArguments := append(append([]any{}, arguments...), limit, offset)
	rows, err := a.readDB.Query(`SELECT n.rowid, n.title, COALESCE(n.folder, ''),
		t.marker, t.text, t.line, n.updated_at
		FROM note_tasks t JOIN notes n ON n.rowid = t.note_id
		WHERE t.marker IN (`+placeholders+`)
		ORDER BY n.updated_at DESC, n.rowid DESC, t.line ASC, t.marker ASC
		LIMIT ? OFFSET ?`, queryArguments...)
	if err != nil {
		return TaskList{}, err
	}
	defer rows.Close()
	items := make([]NoteTask, 0, min(limit, 32))
	for rows.Next() {
		var item NoteTask
		if err := rows.Scan(&item.NoteID, &item.NoteTitle, &item.Folder,
			&item.Marker, &item.Text, &item.Line, &item.UpdatedAt); err != nil {
			return TaskList{}, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return TaskList{}, err
	}
	return TaskList{
		Items:     items,
		Total:     total,
		Markers:   markers,
		Limit:     limit,
		Offset:    offset,
		Truncated: total > offset+len(items),
	}, nil
}

func (a *App) listTasksByScan(patterns []taskPattern, markers []string, limit, offset int) (TaskList, error) {
	items := make([]NoteTask, 0, min(limit, 32))
	// A cheap substring pre-filter avoids copying the full content of notes
	// that cannot contain any marker. extractTasks still applies the word
	// boundary rules, so the result is identical.
	conditions := make([]string, 0, len(patterns))
	arguments := make([]any, 0, len(patterns))
	for _, pattern := range patterns {
		conditions = append(conditions, "instr(COALESCE(content, ''), ?) > 0")
		arguments = append(arguments, pattern.marker)
	}
	query := `SELECT rowid, title, COALESCE(folder, ''), COALESCE(content, ''), updated_at
		FROM notes
		WHERE ` + strings.Join(conditions, " OR ") + `
		ORDER BY updated_at DESC, rowid DESC`
	rows, err := a.readDB.Query(query, arguments...)
	if err != nil {
		return TaskList{}, err
	}
	defer rows.Close()

	total := 0
	for rows.Next() {
		var (
			id      int64
			title   string
			folder  string
			content string
			updated string
		)
		if err := rows.Scan(&id, &title, &folder, &content, &updated); err != nil {
			return TaskList{}, err
		}
		for _, match := range extractTasksWithPatterns(content, patterns) {
			if total >= offset && len(items) < limit {
				items = append(items, NoteTask{
					NoteID:    id,
					NoteTitle: title,
					Folder:    folder,
					Marker:    match.Marker,
					Text:      match.Text,
					Line:      match.Line,
					UpdatedAt: updated,
				})
			}
			total++
		}
	}
	if err := rows.Err(); err != nil {
		return TaskList{}, err
	}
	return TaskList{
		Items:     items,
		Total:     total,
		Markers:   markers,
		Limit:     limit,
		Offset:    offset,
		Truncated: total > offset+len(items),
	}, nil
}

// replaceNoteTasks refreshes the indexed task lines of one note. It runs in
// the same transaction as the content write, so the panel never observes a
// note whose tasks were indexed from an older version.
func replaceNoteTasks(tx *sql.Tx, noteID int64, content string) error {
	markers := append([]string(nil), DefaultTaskMarkers...)
	var raw string
	err := tx.QueryRow("SELECT value FROM app_settings WHERE key = ?", taskMarkersKey).Scan(&raw)
	if err == nil {
		if parsed, parseErr := ParseTaskMarkers(raw); parseErr == nil {
			markers = parsed
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return replaceNoteTasksWithMarkers(tx, noteID, content, markers)
}

func replaceNoteTasksWithMarkers(tx *sql.Tx, noteID int64, content string, markers []string) error {
	if _, err := tx.Exec("DELETE FROM note_tasks WHERE note_id = ?", noteID); err != nil {
		return err
	}
	matches := extractTasksWithPatterns(content, compileTaskPatterns(markers))
	for _, match := range matches {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO note_tasks(note_id, line, marker, text)
			VALUES (?, ?, ?, ?)`, noteID, match.Line, match.Marker, match.Text); err != nil {
			return err
		}
	}
	return nil
}

func rebuildNoteTasks(tx *sql.Tx, markers []string) error {
	if _, err := tx.Exec("DELETE FROM note_tasks"); err != nil {
		return err
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
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, id := range ids {
		var content string
		if err := tx.QueryRow("SELECT COALESCE(content, '') FROM notes WHERE rowid = ?", id).
			Scan(&content); err != nil {
			return err
		}
		if err := replaceNoteTasksWithMarkers(tx, id, content, markers); err != nil {
			return err
		}
	}
	return nil
}

func migrateNoteTasks(tx *sql.Tx) error {
	markers := append([]string(nil), DefaultTaskMarkers...)
	var raw string
	err := tx.QueryRow("SELECT value FROM app_settings WHERE key = ?", taskMarkersKey).Scan(&raw)
	if err == nil {
		if parsed, parseErr := ParseTaskMarkers(raw); parseErr == nil {
			markers = parsed
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return rebuildNoteTasks(tx, markers)
}

type taskPageCache struct {
	revision uint64
	key      string
	list     TaskList
}

type taskPattern struct {
	marker string
}

func compileTaskPatterns(markers []string) []taskPattern {
	patterns := make([]taskPattern, 0, len(markers))
	for _, marker := range markers {
		if marker == "" {
			continue
		}
		patterns = append(patterns, taskPattern{marker: marker})
	}
	return patterns
}

func extractTasks(content string, markers []string) []taskMatch {
	return extractTasksWithPatterns(content, compileTaskPatterns(markers))
}

func extractTasksWithPatterns(content string, patterns []taskPattern) []taskMatch {
	if len(patterns) == 0 {
		return nil
	}

	lines := strings.Split(content, "\n")
	start := bodyStartLine(lines)
	matches := make([]taskMatch, 0)
	for index := start; index < len(lines); index++ {
		matches = append(matches, extractTasksFromLine(lines[index], index+1, patterns)...)
	}
	return matches
}

func extractTasksFromLine(line string, lineNumber int, patterns []taskPattern) []taskMatch {
	type hit struct {
		start  int
		end    int
		marker string
	}
	var hitBuffer [4]hit
	hits := hitBuffer[:0]
	for _, pattern := range patterns {
		// Scan with strings.Index instead of a regular expression. The
		// marker is a literal word, and this path runs for every candidate
		// line whenever the task panel is refreshed.
		for offset := 0; offset < len(line); {
			relative := strings.Index(line[offset:], pattern.marker)
			if relative < 0 {
				break
			}
			begin := offset + relative
			end := begin + len(pattern.marker)
			if taskBoundaryBefore(line, begin) && taskBoundaryAfter(line, end) {
				hits = append(hits, hit{start: begin, end: end, marker: pattern.marker})
			}
			offset = end
		}
	}
	if len(hits) == 0 {
		return nil
	}
	// Prefer the longest marker when two configured words start at the same
	// byte, and never report overlapping hits from one line.
	if len(hits) > 1 {
		sort.SliceStable(hits, func(i, j int) bool {
			if hits[i].start != hits[j].start {
				return hits[i].start < hits[j].start
			}
			return hits[i].end > hits[j].end
		})
	}
	matches := make([]taskMatch, 0, len(hits))
	lastEnd := -1
	for _, match := range hits {
		if match.start < lastEnd {
			continue
		}
		lastEnd = match.end
		matches = append(matches, taskMatch{
			Marker: match.marker,
			Text:   taskText(line[match.end:]),
			Line:   lineNumber,
		})
	}
	return matches
}

func bodyStartLine(lines []string) int {
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return 0
	}
	for index := 1; index < len(lines); index++ {
		trimmed := strings.TrimSpace(lines[index])
		if trimmed == "---" || trimmed == "..." {
			return index + 1
		}
	}
	return 0
}

func taskBoundaryBefore(line string, index int) bool {
	if index <= 0 {
		return true
	}
	r, _ := utf8.DecodeLastRuneInString(line[:index])
	return !isTaskWordRune(r)
}

func taskBoundaryAfter(line string, index int) bool {
	if index >= len(line) {
		return true
	}
	r, _ := utf8.DecodeRuneInString(line[index:])
	return !isTaskWordRune(r)
}

func isTaskWordRune(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r)
}

func taskText(remainder string) string {
	text := strings.TrimLeftFunc(remainder, func(r rune) bool {
		return unicode.IsSpace(r) || strings.ContainsRune(":：-–—>»])", r)
	})
	text = strings.TrimSpace(text)
	runes := []rune(text)
	if len(runes) > maxTaskTextRunes {
		text = string(runes[:maxTaskTextRunes]) + "…"
	}
	return text
}
