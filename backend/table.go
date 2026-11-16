package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
)

// TableNote is the row shape consumed by the Tabulator view. Properties holds
// every top-level key found in the note frontmatter, and Attachments is
// embedded so the frontend can build the tree without extra requests.
type TableNote struct {
	ID          int64          `json:"id"`
	Title       string         `json:"title"`
	Folder      string         `json:"folder"`
	Tags        []string       `json:"tags,omitempty"`
	CreatedAt   string         `json:"created_at"`
	UpdatedAt   string         `json:"updated_at"`
	Properties  map[string]any `json:"properties"`
	Attachments []Attachment   `json:"attachments"`
}

// The table view is local and interactive, but an unbounded response would
// copy the whole library over the wire. The cap keeps the payload bounded;
// the handler reports the real total so the UI can warn about truncation.
const maxTableNotes = 5000

// ListTableNotes returns the notes matching the filters with parsed
// frontmatter and attachments, up to the default page size. Callers that page
// through the table use listTableNotes directly.
func (a *App) ListTableNotes(folder, tag string) ([]TableNote, int, error) {
	return a.listTableNotes(folder, tag, maxTableNotes, 0)
}

func (a *App) listTableNotes(folder, tag string, limit, offset int) ([]TableNote, int, error) {
	if limit < 1 {
		limit = maxTableNotes
	}
	if limit > maxTableNotes {
		limit = maxTableNotes
	}
	if offset < 0 {
		offset = 0
	}
	revision := a.currentDataRevision()
	cacheable := limit <= 1000
	cacheKey := fmt.Sprintf("%s\x00%s|%d|%d", folder, tag, limit, offset)
	if cacheable {
		a.cacheMu.Lock()
		for _, entry := range a.tableCache {
			if entry.revision == revision && entry.key == cacheKey {
				items, total := entry.items, entry.total
				a.cacheMu.Unlock()
				return items, total, nil
			}
		}
		a.cacheMu.Unlock()
	}
	var total int
	if err := a.readDB.QueryRow(`SELECT COUNT(*) FROM notes
		WHERE (folder = ? OR ? = '')
		AND (? = '' OR EXISTS (
			SELECT 1 FROM note_tags nt WHERE nt.note_id = notes.rowid AND nt.tag = ?
		))`, folder, folder, tag, tag).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := a.readDB.Query(`SELECT rowid, title, folder, COALESCE(tags, ''),
		COALESCE(frontmatter, '{}'), created_at, updated_at
		FROM notes
		WHERE (folder = ? OR ? = '')
		AND (? = '' OR EXISTS (
			SELECT 1 FROM note_tags nt WHERE nt.note_id = notes.rowid AND nt.tag = ?
		))
		ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`,
		folder, folder, tag, tag, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := make([]TableNote, 0, min(limit, 64))
	noteIDs := make(map[int64]int)
	for rows.Next() {
		var item TableNote
		var tags string
		var frontmatter string
		if err := rows.Scan(&item.ID, &item.Title, &item.Folder, &tags, &frontmatter,
			&item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, 0, err
		}
		item.Tags = splitTags(tags)
		properties := make(map[string]any)
		if frontmatter != "" {
			if err := json.Unmarshal([]byte(frontmatter), &properties); err != nil {
				properties = make(map[string]any)
			}
		}
		item.Properties = properties
		if len(item.Tags) > 0 {
			item.Properties["tags"] = item.Tags
		}
		item.Attachments = make([]Attachment, 0)
		noteIDs[item.ID] = len(items)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if len(items) == 0 {
		if cacheable {
			a.cacheTablePage(revision, cacheKey, items, total)
		}
		return items, total, nil
	}

	// Fetch attachments only for the notes on this page. The 500-note chunk
	// stays below SQLite's default bound-parameter limit.
	ids := make([]int64, 0, len(noteIDs))
	for id := range noteIDs {
		ids = append(ids, id)
	}
	const attachmentChunk = 500
	for start := 0; start < len(ids); start += attachmentChunk {
		end := min(start+attachmentChunk, len(ids))
		placeholders := strings.TrimSuffix(strings.Repeat("?,", end-start), ",")
		arguments := make([]any, 0, end-start)
		for _, id := range ids[start:end] {
			arguments = append(arguments, id)
		}
		attachmentRows, err := a.readDB.Query(`SELECT id, note_id, filename, media_type, size, created_at
			FROM attachments WHERE note_id IN (`+placeholders+`) ORDER BY note_id, created_at, id`,
			arguments...)
		if err != nil {
			return nil, 0, err
		}
		for attachmentRows.Next() {
			var item Attachment
			if err := attachmentRows.Scan(&item.ID, &item.NoteID, &item.Filename,
				&item.MediaType, &item.Size, &item.CreatedAt); err != nil {
				attachmentRows.Close()
				return nil, 0, err
			}
			position, ok := noteIDs[item.NoteID]
			if !ok {
				continue
			}
			item.URL = attachmentURL(item.NoteID, item.ID)
			items[position].Attachments = append(items[position].Attachments, item)
		}
		if err := attachmentRows.Err(); err != nil {
			attachmentRows.Close()
			return nil, 0, err
		}
		if err := attachmentRows.Close(); err != nil {
			return nil, 0, err
		}
	}
	if cacheable {
		a.cacheTablePage(revision, cacheKey, items, total)
	}
	return items, total, nil
}

func (a *App) cacheTablePage(revision uint64, key string, items []TableNote, total int) {
	a.cacheMu.Lock()
	a.tableCache = append(a.tableCache, tablePageCache{revision: revision, key: key, items: items, total: total})
	if len(a.tableCache) > 8 {
		a.tableCache = a.tableCache[len(a.tableCache)-8:]
	}
	a.cacheMu.Unlock()
}

type tablePageCache struct {
	revision uint64
	key      string
	items    []TableNote
	total    int
}

// frontmatterProperties parses the top-level YAML keys between the leading
// "---" markers. It supports scalars, quoted strings, inline and block lists,
// nested mappings and block scalars, which covers the metadata used by notes.
func frontmatterProperties(content string) map[string]any {
	properties := make(map[string]any)
	if !hasFrontmatter(content) {
		return properties
	}
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	if len(lines) < 3 || strings.TrimSpace(lines[0]) != "---" {
		return properties
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		marker := strings.TrimSpace(lines[i])
		if marker == "---" || marker == "..." {
			end = i
			break
		}
	}
	if end < 0 {
		return properties
	}
	index := 1
	for index < end {
		line := lines[index]
		if isBlankOrComment(line) || lineIndent(line) > 0 || strings.HasPrefix(strings.TrimSpace(line), "-") {
			index++
			continue
		}
		key, value, found := strings.Cut(strings.TrimSpace(line), ":")
		if !found {
			index++
			continue
		}
		key = strings.Trim(strings.TrimSpace(key), `"'`)
		if key == "" {
			index++
			continue
		}
		value = strings.TrimSpace(value)
		index++
		if isBlockScalarHeader(value) {
			properties[key] = parseBlockScalar(lines, &index, end, 0, strings.HasPrefix(value, ">"))
			continue
		}
		if value == "" {
			next := nextContentLine(lines, index, end)
			if next >= 0 && lineIndent(lines[next]) > 0 {
				childIndent := lineIndent(lines[next])
				if strings.HasPrefix(strings.TrimSpace(lines[next]), "-") {
					properties[key] = parseYAMLSequence(lines, &index, end, childIndent)
				} else {
					properties[key] = parseYAMLMapping(lines, &index, end, childIndent)
				}
				continue
			}
			properties[key] = nil
			continue
		}
		properties[key] = parseYAMLScalar(value)
	}
	return properties
}

func parseYAMLMapping(lines []string, index *int, end, indent int) map[string]any {
	result := make(map[string]any)
	for *index < end {
		line := lines[*index]
		if isBlankOrComment(line) {
			*index++
			continue
		}
		current := lineIndent(line)
		if current < indent {
			break
		}
		if current > indent || strings.HasPrefix(strings.TrimSpace(line), "-") {
			*index++
			continue
		}
		key, value, found := strings.Cut(strings.TrimSpace(line), ":")
		if !found {
			*index++
			continue
		}
		key = strings.Trim(strings.TrimSpace(key), `"'`)
		if key == "" {
			*index++
			continue
		}
		value = strings.TrimSpace(value)
		*index++
		if isBlockScalarHeader(value) {
			result[key] = parseBlockScalar(lines, index, end, indent, strings.HasPrefix(value, ">"))
			continue
		}
		if value == "" {
			next := nextContentLine(lines, *index, end)
			if next >= 0 && lineIndent(lines[next]) > indent {
				childIndent := lineIndent(lines[next])
				if strings.HasPrefix(strings.TrimSpace(lines[next]), "-") {
					result[key] = parseYAMLSequence(lines, index, end, childIndent)
				} else {
					result[key] = parseYAMLMapping(lines, index, end, childIndent)
				}
				continue
			}
			result[key] = nil
			continue
		}
		result[key] = parseYAMLScalar(value)
	}
	return result
}

func parseYAMLSequence(lines []string, index *int, end, indent int) []any {
	items := make([]any, 0)
	for *index < end {
		line := lines[*index]
		if isBlankOrComment(line) {
			*index++
			continue
		}
		if lineIndent(line) != indent || !strings.HasPrefix(strings.TrimSpace(line), "-") {
			break
		}
		value := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "-"))
		*index++
		if value == "" {
			next := nextContentLine(lines, *index, end)
			if next >= 0 && lineIndent(lines[next]) > indent {
				childIndent := lineIndent(lines[next])
				if strings.HasPrefix(strings.TrimSpace(lines[next]), "-") {
					items = append(items, parseYAMLSequence(lines, index, end, childIndent))
				} else {
					items = append(items, parseYAMLMapping(lines, index, end, childIndent))
				}
				continue
			}
			items = append(items, nil)
			continue
		}
		items = append(items, parseYAMLScalar(value))
	}
	return items
}

func parseBlockScalar(lines []string, index *int, end, parentIndent int, folded bool) string {
	collected := make([]string, 0)
	minIndent := -1
	for *index < end {
		line := lines[*index]
		if strings.TrimSpace(line) == "" {
			collected = append(collected, "")
			*index++
			continue
		}
		if lineIndent(line) <= parentIndent {
			break
		}
		if indent := lineIndent(line); minIndent < 0 || indent < minIndent {
			minIndent = indent
		}
		collected = append(collected, line)
		*index++
	}
	for len(collected) > 0 && strings.TrimSpace(collected[len(collected)-1]) == "" {
		collected = collected[:len(collected)-1]
	}
	dedented := make([]string, 0, len(collected))
	for _, line := range collected {
		if strings.TrimSpace(line) == "" {
			dedented = append(dedented, "")
			continue
		}
		cut := minIndent
		if cut < 0 {
			cut = 0
		}
		if cut > len(line) {
			cut = len(line)
		}
		dedented = append(dedented, line[cut:])
	}
	if folded {
		return strings.Join(dedented, " ")
	}
	return strings.Join(dedented, "\n")
}

func parseYAMLScalar(raw string) any {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil
	}
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		inner := strings.TrimSpace(value[1 : len(value)-1])
		if inner == "" {
			return []any{}
		}
		parts := splitYAMLInline(inner)
		items := make([]any, 0, len(parts))
		for _, part := range parts {
			items = append(items, parseYAMLScalar(part))
		}
		return items
	}
	if strings.HasPrefix(value, "{") && strings.HasSuffix(value, "}") {
		result := make(map[string]any)
		for _, part := range splitYAMLInline(strings.TrimSpace(value[1 : len(value)-1])) {
			key, item, found := strings.Cut(part, ":")
			if !found {
				continue
			}
			result[strings.Trim(strings.TrimSpace(key), `"'`)] = parseYAMLScalar(item)
		}
		return result
	}
	if len(value) >= 2 {
		switch {
		case value[0] == '"' && value[len(value)-1] == '"':
			if unquoted, err := strconv.Unquote(value); err == nil {
				return unquoted
			}
			return value[1 : len(value)-1]
		case value[0] == '\'' && value[len(value)-1] == '\'':
			return strings.ReplaceAll(value[1:len(value)-1], "''", "'")
		}
	}
	if comment := strings.Index(value, " #"); comment > 0 {
		value = strings.TrimSpace(value[:comment])
	}
	switch strings.ToLower(value) {
	case "true":
		return true
	case "false":
		return false
	case "null", "~":
		return nil
	}
	if integer, err := strconv.ParseInt(value, 10, 64); err == nil {
		return integer
	}
	if number, err := strconv.ParseFloat(value, 64); err == nil {
		return number
	}
	return value
}

func splitYAMLInline(value string) []string {
	parts := make([]string, 0)
	var current strings.Builder
	var quote rune
	depth := 0
	for _, char := range value {
		switch {
		case quote != 0:
			current.WriteRune(char)
			if char == quote {
				quote = 0
			}
		case char == '"' || char == '\'':
			quote = char
			current.WriteRune(char)
		case char == '[' || char == '{':
			depth++
			current.WriteRune(char)
		case char == ']' || char == '}':
			depth--
			current.WriteRune(char)
		case char == ',' && depth == 0:
			parts = append(parts, strings.TrimSpace(current.String()))
			current.Reset()
		default:
			current.WriteRune(char)
		}
	}
	if strings.TrimSpace(current.String()) != "" {
		parts = append(parts, strings.TrimSpace(current.String()))
	}
	return parts
}

func isBlockScalarHeader(value string) bool {
	switch strings.TrimSpace(value) {
	case "|", ">", "|-", ">-", "|+", ">+":
		return true
	default:
		return false
	}
}

func nextContentLine(lines []string, start, end int) int {
	for i := start; i < end; i++ {
		if !isBlankOrComment(lines[i]) {
			return i
		}
	}
	return -1
}

func isBlankOrComment(line string) bool {
	trimmed := strings.TrimSpace(line)
	return trimmed == "" || strings.HasPrefix(trimmed, "#")
}

func lineIndent(line string) int {
	indent := 0
	for _, char := range line {
		switch char {
		case ' ':
			indent++
		case '\t':
			indent += 2
		default:
			return indent
		}
	}
	return indent
}

func (a *App) handleTable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	limit := maxTableNotes
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= maxTableNotes {
			limit = parsed
		}
	}
	offset := 0
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 0 {
			offset = parsed
		}
	}
	items, total, err := a.listTableNotes(r.URL.Query().Get("folder"), r.URL.Query().Get("tag"), limit, offset)
	if err != nil {
		log.Printf("list table notes: %v", err)
		http.Error(w, "failed to list table notes", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":     items,
		"total":     total,
		"limit":     limit,
		"offset":    offset,
		"truncated": offset+len(items) < total,
	})
}
