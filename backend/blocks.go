package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/yuin/goldmark/ast"
)

// Blocos dinâmicos: comentários `<!-- ton618:nome args -->` (sozinhos na linha)
// são substituídos por Markdown gerado antes da renderização do preview.
// A saída é sempre Markdown porque o preview usa goldmark sem `WithUnsafe`.
const (
	noteBlockPrefix   = "ton618"
	maxNoteBlocks     = 20
	maxBlockItems     = 50
	maxBlockArgLength = 400
)

var (
	noteBlockPattern   = regexp.MustCompile(`^[\t ]*<!--[\t ]*` + noteBlockPrefix + `:([a-z][a-z-]*)([^>\n]*)-->[\t ]*$`)
	headingLinePattern = regexp.MustCompile(`^\s{0,3}(?:>\s*)*(#{1,6})\s+(.+?)\s*#*\s*$`)
	headingLinkPattern = regexp.MustCompile(`\[([^\]\n]*)\]\([^)\n]*\)`)
	headingWikiPattern = regexp.MustCompile(`\[\[([^\]\n|]*)(?:\|([^\]\n]*))?\]\]`)
)

var headingDecorations = strings.NewReplacer(
	"**", "", "__", "", "~~", "", "*", "", "_", "", "`", "",
)

// noteBlockContext brings the note being previewed to the blocks. Source is the
// original Markdown, so `toc` keeps listing the note headings even after the
// dynamic blocks are expanded.
type noteBlockContext struct {
	NoteID int64
	Title  string
	Folder string
	Source string
}

// blockLineShift maps the expanded line range of one block back to the line of
// the comment it replaced, keeping `data-source-line` in editor coordinates.
type blockLineShift struct {
	start    int
	end      int
	original int
	delta    int
}

type expandedNote struct {
	markdown string
	shifts   []blockLineShift
}

type noteHeading struct {
	Level int
	Text  string
	Slug  string
}

// originalLine converts a line of the expanded Markdown back to the editor line.
func adjustSourceLine(shifts []blockLineShift, line int) int {
	adjusted := line
	for _, shift := range shifts {
		switch {
		case line < shift.start:
			return adjusted
		case line < shift.end:
			return shift.original
		default:
			adjusted -= shift.delta
		}
	}
	return adjusted
}

// parseBlockArgs reads `chave="valor"` pairs. Valores com aspas internas são
// aceitos (`colunas="tags="amigo",pasta="sei lá""`): a aspa só fecha o valor
// quando o que vem depois é o fim do bloco ou outra chave.
func parseBlockArgs(raw string) map[string]string {
	args := make(map[string]string)
	runes := []rune(raw)
	index := 0
	for index < len(runes) {
		for index < len(runes) && unicode.IsSpace(runes[index]) {
			index++
		}
		start := index
		for index < len(runes) && isArgKeyRune(runes[index]) {
			index++
		}
		if start == index || index >= len(runes) || runes[index] != '=' {
			index++
			continue
		}
		key := strings.ToLower(string(runes[start:index]))
		index++
		var value string
		if index < len(runes) && (runes[index] == '"' || runes[index] == '\'') {
			quote := runes[index]
			index++
			start = index
			for index < len(runes) {
				if runes[index] == quote && isArgValueEnd(runes[index+1:]) {
					break
				}
				index++
			}
			value = string(runes[start:index])
			if index < len(runes) {
				index++
			}
		} else {
			start = index
			for index < len(runes) && !unicode.IsSpace(runes[index]) {
				index++
			}
			value = string(runes[start:index])
		}
		value = strings.TrimSpace(value)
		if value == "" || len(value) > maxBlockArgLength {
			continue
		}
		args[key] = value
	}
	return args
}

func isArgKeyRune(char rune) bool {
	return unicode.IsLetter(char) || unicode.IsDigit(char) || char == '-'
}

// isArgValueEnd reports whether the text after a closing quote starts a new
// argument (or ends the block), which is what makes nested quotes possible.
func isArgValueEnd(rest []rune) bool {
	index := 0
	for index < len(rest) && unicode.IsSpace(rest[index]) {
		index++
	}
	if index >= len(rest) {
		return true
	}
	start := index
	for index < len(rest) && isArgKeyRune(rest[index]) {
		index++
	}
	return start < index && index < len(rest) && rest[index] == '='
}

// expandNoteBlocks replaces each dynamic block comment with generated Markdown.
// Unknown blocks and database errors become a visible warning instead of
// silently disappearing.
func (a *App) expandNoteBlocks(source string, ctx noteBlockContext) expandedNote {
	ctx.Source = source
	lines := strings.Split(source, "\n")
	output := make([]string, 0, len(lines)+8)
	shifts := make([]blockLineShift, 0, 4)
	delta := 0
	blocks := 0
	for index, line := range lines {
		match := noteBlockPattern.FindStringSubmatch(line)
		if match == nil {
			output = append(output, line)
			continue
		}
		blocks++
		if blocks > maxNoteBlocks {
			output = append(output, blockWarning(
				fmt.Sprintf("limite de %d blocos dinâmicos por nota", maxNoteBlocks)))
			continue
		}
		body := a.renderNoteBlock(match[1], parseBlockArgs(match[2]), ctx)
		generated := strings.Split(body, "\n")
		start := index + delta
		output = append(output, generated...)
		if len(generated) != 1 {
			delta += len(generated) - 1
			shifts = append(shifts, blockLineShift{
				start:    start,
				end:      start + len(generated),
				original: index,
				delta:    len(generated) - 1,
			})
		}
	}
	return expandedNote{markdown: strings.Join(output, "\n"), shifts: shifts}
}

func (a *App) renderNoteBlock(name string, args map[string]string, ctx noteBlockContext) string {
	switch name {
	case "tasks":
		return a.renderTasksBlock(args, ctx)
	case "backlinks":
		return a.renderBacklinksBlock(args, ctx)
	case "recentes":
		return a.renderRecentBlock(args)
	case "toc":
		return renderTOCBlock(args, ctx)
	case "links":
		return a.renderLinksBlock(args, ctx)
	case "tabela":
		return a.renderTableBlock(args)
	default:
		return blockWarning(fmt.Sprintf("bloco desconhecido `%s:%s`", noteBlockPrefix, name))
	}
}

func blockWarning(message string) string {
	return "> ⚠️ " + strings.TrimSpace(message)
}

func intArg(args map[string]string, key string, fallback, max int) int {
	raw, ok := args[key]
	if !ok {
		return fallback
	}
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < 1 {
		return fallback
	}
	if value > max {
		return max
	}
	return value
}

func (a *App) renderTasksBlock(args map[string]string, ctx noteBlockContext) string {
	limit := intArg(args, "limite", 20, maxBlockItems)
	folder := strings.TrimSpace(args["pasta"])
	markers, err := a.TaskMarkers()
	if err != nil {
		return blockWarning("não foi possível ler os marcadores de tarefas")
	}
	// Filtra a pasta depois da consulta, então busca uma folga de resultados.
	list, err := a.listTasks(markers, min(maxTaskResults, limit*10), 0)
	if err != nil {
		return blockWarning("não foi possível listar as tarefas")
	}
	lines := make([]string, 0, limit)
	for _, item := range list.Items {
		if folder != "" && !strings.EqualFold(item.Folder, folder) {
			continue
		}
		lines = append(lines, fmt.Sprintf("- `%s` %s — [%s](?note=%d)",
			item.Marker, escapeMarkdownInline(item.Text), escapeMarkdownLinkLabel(item.NoteTitle), item.NoteID))
		if len(lines) >= limit {
			break
		}
	}
	if len(lines) == 0 {
		return "_Nenhuma tarefa encontrada._"
	}
	return strings.Join(lines, "\n")
}

func (a *App) renderBacklinksBlock(args map[string]string, ctx noteBlockContext) string {
	if ctx.NoteID < 1 {
		return blockWarning(fmt.Sprintf("`%s:backlinks` só funciona em uma nota salva", noteBlockPrefix))
	}
	limit := intArg(args, "limite", 20, maxBlockItems)
	items, err := a.Backlinks(ctx.NoteID)
	if err != nil {
		return blockWarning("não foi possível carregar os backlinks")
	}
	lines := make([]string, 0, limit)
	for _, note := range items {
		line := fmt.Sprintf("- [%s](?note=%d)", escapeMarkdownLinkLabel(note.Title), note.ID)
		if note.Folder != "" {
			line += " · " + escapeMarkdownLinkLabel(note.Folder)
		}
		lines = append(lines, line)
		if len(lines) >= limit {
			break
		}
	}
	if len(lines) == 0 {
		return "_Nenhuma nota aponta para esta._"
	}
	return strings.Join(lines, "\n")
}

func (a *App) renderRecentBlock(args map[string]string) string {
	limit := intArg(args, "limite", 10, maxBlockItems)
	folder := strings.TrimSpace(args["pasta"])
	rows, err := a.readDB.Query(`SELECT rowid, title, COALESCE(folder, ''), updated_at
		FROM notes
		WHERE (? = '' OR LOWER(COALESCE(folder, '')) = LOWER(?))
		ORDER BY updated_at DESC, rowid DESC LIMIT ?`, folder, folder, limit)
	if err != nil {
		return blockWarning("não foi possível listar as notas recentes")
	}
	defer rows.Close()
	lines := make([]string, 0, limit)
	for rows.Next() {
		var id int64
		var title, noteFolder, updatedAt string
		if err := rows.Scan(&id, &title, &noteFolder, &updatedAt); err != nil {
			return blockWarning("não foi possível ler as notas recentes")
		}
		line := fmt.Sprintf("- [%s](?note=%d)", escapeMarkdownLinkLabel(title), id)
		if noteFolder != "" {
			line += " · " + escapeMarkdownLinkLabel(noteFolder)
		}
		if stamp := shortTimestamp(updatedAt); stamp != "" {
			line += " · " + stamp
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		return blockWarning("não foi possível ler as notas recentes")
	}
	if len(lines) == 0 {
		return "_Nenhuma nota encontrada._"
	}
	return strings.Join(lines, "\n")
}

func renderTOCBlock(args map[string]string, ctx noteBlockContext) string {
	maxLevel := intArg(args, "nivel", 6, 6)
	headings := markdownHeadings(ctx.Source)
	minLevel := 7
	for _, heading := range headings {
		if heading.Level < minLevel {
			minLevel = heading.Level
		}
	}
	lines := make([]string, 0, len(headings))
	for _, heading := range headings {
		if heading.Level > maxLevel {
			continue
		}
		indent := strings.Repeat("  ", heading.Level-minLevel)
		lines = append(lines, fmt.Sprintf("%s- [%s](#%s)", indent, escapeMarkdownLinkLabel(heading.Text), heading.Slug))
	}
	if len(lines) == 0 {
		return "_Nenhum cabeçalho encontrado._"
	}
	return strings.Join(lines, "\n")
}

func (a *App) renderLinksBlock(args map[string]string, ctx noteBlockContext) string {
	if ctx.NoteID < 1 {
		return blockWarning(fmt.Sprintf("`%s:links` só funciona em uma nota salva", noteBlockPrefix))
	}
	limit := intArg(args, "limite", 20, maxBlockItems)
	index, err := a.noteIndex()
	if err != nil {
		return blockWarning("não foi possível carregar o índice de notas")
	}
	notesByID := make(map[int64]indexedNote, len(index.notes))
	for _, note := range index.notes {
		notesByID[note.ID] = note
	}
	source := indexedNote{GraphNode: GraphNode{ID: ctx.NoteID, Title: ctx.Title, Folder: ctx.Folder}}
	rows, err := a.readDB.Query(`SELECT DISTINCT target_key FROM note_links
		WHERE source_id = ? ORDER BY target_key`, ctx.NoteID)
	if err != nil {
		return blockWarning("não foi possível carregar os links de saída")
	}
	defer rows.Close()
	lines := make([]string, 0, limit)
	for rows.Next() {
		var targetKey string
		if err := rows.Scan(&targetKey); err != nil {
			return blockWarning("não foi possível carregar os links de saída")
		}
		targetID := resolveNoteLink(source, targetKey, index.byPath, index.byTitle)
		switch {
		case targetID == 0:
			lines = append(lines, fmt.Sprintf("- %s — _não encontrada_", escapeMarkdownInline(targetKey)))
		case targetID == ctx.NoteID:
			continue
		default:
			title := targetKey
			if note, ok := notesByID[targetID]; ok {
				title = note.Title
			}
			lines = append(lines, fmt.Sprintf("- [%s](?note=%d)", escapeMarkdownLinkLabel(title), targetID))
		}
		if len(lines) >= limit {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return blockWarning("não foi possível carregar os links de saída")
	}
	if len(lines) == 0 {
		return "_Esta nota não aponta para outras._"
	}
	return strings.Join(lines, "\n")
}

// tableBlockColumn is one column of the generated table. When the column
// carries values (`tags=amigo|família`) they also filter the rows, always
// combined with AND across columns.
type tableBlockColumn struct {
	name   string
	values []string
}

// parseTableBlockColumns reads `colunas` as a comma separated list where each
// item is either a column name or `nome=valor`. The value may be quoted, so
// folders and tags with spaces are accepted.
func parseTableBlockColumns(raw string) []tableBlockColumn {
	columns := make([]tableBlockColumn, 0, 5)
	seen := make(map[string]struct{}, 5)
	for _, spec := range splitYAMLInline(raw) {
		name, values, _ := strings.Cut(spec, "=")
		name = strings.TrimSpace(strings.Trim(name, `"'`))
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		column := tableBlockColumn{name: name}
		for _, value := range strings.Split(values, "|") {
			value = strings.TrimSpace(strings.Trim(value, `"'`))
			if value != "" {
				column.values = append(column.values, value)
			}
		}
		columns = append(columns, column)
	}
	return columns
}

func (a *App) renderTableBlock(args map[string]string) string {
	limit := intArg(args, "limite", 20, maxBlockItems)
	columns := parseTableBlockColumns(args["colunas"])
	if len(columns) == 0 {
		columns = []tableBlockColumn{{name: "titulo"}, {name: "atualizado"}}
	}
	conditions := make([]string, 0, 4)
	arguments := make([]any, 0, 8)
	if folder := strings.TrimSpace(args["pasta"]); folder != "" {
		conditions = append(conditions, folderFilter())
		arguments = append(arguments, folder)
	}
	if tag := strings.TrimSpace(args["tag"]); tag != "" {
		conditions = append(conditions, tagFilter())
		arguments = append(arguments, tag)
	}
	for _, column := range columns {
		condition, values := columnFilter(column)
		if condition == "" {
			continue
		}
		conditions = append(conditions, condition)
		arguments = append(arguments, values...)
	}
	order := "updated_at DESC, rowid DESC"
	if raw := strings.TrimSpace(args["ordenar"]); raw != "" {
		name, direction := parseOrderArgument(raw)
		var orderArguments []any
		order, orderArguments = tableOrderClause(name, direction, arguments)
		arguments = orderArguments
	}
	query := `SELECT rowid, title, COALESCE(folder, ''), COALESCE(tags, ''),
		COALESCE(frontmatter, '{}'), updated_at, created_at
		FROM notes`
	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}
	query += " ORDER BY " + order + " LIMIT ?"
	arguments = append(arguments, limit)
	rows, err := a.readDB.Query(query, arguments...)
	if err != nil {
		return blockWarning("não foi possível montar a tabela")
	}
	defer rows.Close()
	headers := make([]string, len(columns))
	for index, column := range columns {
		headers[index] = tableColumnLabel(column.name)
	}
	lines := make([]string, 0, limit+2)
	lines = append(lines, "| "+strings.Join(headers, " | ")+" |")
	lines = append(lines, "|"+strings.Repeat(" --- |", len(columns)))
	count := 0
	for rows.Next() {
		var id int64
		var title, folder, tags, frontmatter, updatedAt, createdAt string
		if err := rows.Scan(&id, &title, &folder, &tags, &frontmatter, &updatedAt, &createdAt); err != nil {
			return blockWarning("não foi possível montar a tabela")
		}
		properties := make(map[string]any)
		if frontmatter != "" {
			if err := json.Unmarshal([]byte(frontmatter), &properties); err != nil {
				properties = make(map[string]any)
			}
		}
		note := tableBlockRow{
			id:         id,
			title:      title,
			folder:     folder,
			tags:       tags,
			updatedAt:  updatedAt,
			createdAt:  createdAt,
			properties: properties,
		}
		cells := make([]string, len(columns))
		for index, column := range columns {
			cells[index] = tableBlockCell(column, note)
		}
		lines = append(lines, "| "+strings.Join(cells, " | ")+" |")
		count++
	}
	if err := rows.Err(); err != nil {
		return blockWarning("não foi possível montar a tabela")
	}
	if count == 0 {
		return "_Nenhuma nota encontrada._"
	}
	return strings.Join(lines, "\n")
}

type tableBlockRow struct {
	id         int64
	title      string
	folder     string
	tags       string
	updatedAt  string
	createdAt  string
	properties map[string]any
}

func tableBlockCell(column tableBlockColumn, note tableBlockRow) string {
	switch strings.ToLower(column.name) {
	case "titulo":
		return fmt.Sprintf("[%s](?note=%d)", escapeMarkdownLinkLabel(note.title), note.id)
	case "pasta":
		return escapeTableCell(note.folder)
	case "tags":
		return escapeTableCell(strings.Join(splitTags(note.tags), ", "))
	case "atualizado":
		return shortTimestamp(note.updatedAt)
	case "criado":
		return shortTimestamp(note.createdAt)
	default:
		return escapeTableCell(propertyText(propertyValue(note.properties, column.name)))
	}
}

func folderFilter() string {
	return "LOWER(COALESCE(folder, '')) = LOWER(?)"
}

func tagFilter() string {
	return "EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = notes.rowid AND LOWER(nt.tag) = LOWER(?))"
}

// columnFilter builds the row filter of one column. Values are ORed inside the
// column and ANDed with the other columns by the caller.
func columnFilter(column tableBlockColumn) (string, []any) {
	if len(column.values) == 0 {
		return "", nil
	}
	parts := make([]string, 0, len(column.values))
	arguments := make([]any, 0, len(column.values)*2)
	for _, value := range column.values {
		switch strings.ToLower(column.name) {
		case "titulo":
			parts = append(parts, "LOWER(title) LIKE '%' || LOWER(?) || '%'")
			arguments = append(arguments, value)
		case "pasta":
			parts = append(parts, folderFilter())
			arguments = append(arguments, value)
		case "tags":
			parts = append(parts, tagFilter())
			arguments = append(arguments, value)
		case "atualizado":
			parts = append(parts, "COALESCE(updated_at, '') LIKE ? || '%'")
			arguments = append(arguments, value)
		case "criado":
			parts = append(parts, "COALESCE(created_at, '') LIKE ? || '%'")
			arguments = append(arguments, value)
		default:
			parts = append(parts,
				"LOWER(CAST(json_extract(COALESCE(frontmatter, '{}'), ?) AS TEXT)) = LOWER(?)")
			arguments = append(arguments, jsonPropertyPath(column.name), value)
		}
	}
	return "(" + strings.Join(parts, " OR ") + ")", arguments
}

func parseOrderArgument(raw string) (string, string) {
	direction := "ASC"
	fields := strings.Fields(raw)
	if len(fields) > 1 && strings.EqualFold(fields[len(fields)-1], "desc") {
		direction = "DESC"
		fields = fields[:len(fields)-1]
	}
	return strings.Join(fields, " "), direction
}

func tableOrderClause(name, direction string, arguments []any) (string, []any) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "", "atualizado":
		return "updated_at " + direction + ", rowid " + direction, arguments
	case "criado":
		return "created_at " + direction + ", rowid " + direction, arguments
	case "titulo":
		return "title COLLATE NOCASE " + direction, arguments
	case "pasta":
		return "folder COLLATE NOCASE " + direction + ", title COLLATE NOCASE", arguments
	case "tags":
		return "COALESCE(tags, '') COLLATE NOCASE " + direction, arguments
	default:
		return "json_extract(COALESCE(frontmatter, '{}'), ?) COLLATE NOCASE " + direction,
			append(arguments, jsonPropertyPath(name))
	}
}

func jsonPropertyPath(name string) string {
	escaped := strings.ReplaceAll(name, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	return `$."` + escaped + `"`
}

func propertyValue(properties map[string]any, name string) any {
	if value, exists := properties[name]; exists {
		return value
	}
	lowered := strings.ToLower(name)
	for key, value := range properties {
		if strings.ToLower(key) == lowered {
			return value
		}
	}
	return nil
}

func propertyText(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := propertyText(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, ", ")
	default:
		return fmt.Sprint(typed)
	}
}

func tableColumnLabel(column string) string {
	switch strings.ToLower(column) {
	case "titulo":
		return "Título"
	case "pasta":
		return "Pasta"
	case "tags":
		return "Tags"
	case "atualizado":
		return "Atualizado"
	case "criado":
		return "Criado"
	default:
		return column
	}
}

func shortTimestamp(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 16 {
		return value[:16]
	}
	return value
}

func escapeTableCell(value string) string {
	value = strings.ReplaceAll(value, "|", `\|`)
	value = strings.ReplaceAll(value, "\r", " ")
	return strings.ReplaceAll(value, "\n", " ")
}

func escapeMarkdownInline(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	return strings.NewReplacer(`\`, `\\`, "*", `\*`, "_", `\_`, "`", "\\`", "[", `\[`, "]", `\]`).Replace(value)
}

// markdownHeadings lists the note headings outside fenced code and frontmatter.
// The same slug rules are applied when the preview assigns heading ids, so the
// `toc` links always match.
func markdownHeadings(source string) []noteHeading {
	lines := strings.Split(source, "\n")
	headings := make([]noteHeading, 0, 8)
	seen := make(map[string]int)
	var fenceChar byte
	fenceLength := 0
	inFrontmatter := false
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if index == 0 && trimmed == "---" {
			inFrontmatter = true
			continue
		}
		if inFrontmatter {
			if trimmed == "---" || trimmed == "..." {
				inFrontmatter = false
			}
			continue
		}
		if marker := markdownFence(trimmed); marker != "" {
			if fenceChar == 0 {
				fenceChar = marker[0]
				fenceLength = len(marker)
			} else if marker[0] == fenceChar && len(marker) >= fenceLength {
				fenceChar = 0
				fenceLength = 0
			}
			continue
		}
		if fenceChar != 0 {
			continue
		}
		match := headingLinePattern.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		text := cleanHeadingText(match[2])
		if text == "" {
			continue
		}
		headings = append(headings, noteHeading{
			Level: len(match[1]),
			Text:  text,
			Slug:  nextHeadingSlug(text, seen),
		})
	}
	return headings
}

func cleanHeadingText(value string) string {
	value = headingWikiPattern.ReplaceAllStringFunc(value, func(match string) string {
		parts := headingWikiPattern.FindStringSubmatch(match)
		if parts[2] != "" {
			return parts[2]
		}
		return parts[1]
	})
	value = headingLinkPattern.ReplaceAllString(value, "$1")
	value = headingDecorations.Replace(value)
	return strings.Join(strings.Fields(value), " ")
}

func headingSlug(text string) string {
	var builder strings.Builder
	dash := false
	for _, char := range strings.ToLower(text) {
		switch {
		case unicode.IsLetter(char) || unicode.IsDigit(char):
			builder.WriteRune(char)
			dash = false
		case builder.Len() > 0 && !dash:
			builder.WriteByte('-')
			dash = true
		}
	}
	return strings.Trim(builder.String(), "-")
}

func nextHeadingSlug(text string, seen map[string]int) string {
	base := headingSlug(text)
	if base == "" {
		base = "secao"
	}
	seen[base]++
	if count := seen[base]; count > 1 {
		return fmt.Sprintf("%s-%d", base, count)
	}
	return base
}

// nodePlainText collects the visible text of a heading so the preview can build
// the same slug used by the `toc` block.
func nodePlainText(node ast.Node, source []byte) string {
	var builder strings.Builder
	_ = ast.Walk(node, func(child ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if textNode, ok := child.(*ast.Text); ok {
			builder.Write(textNode.Segment.Value(source))
			if textNode.SoftLineBreak() {
				builder.WriteByte(' ')
			}
		}
		return ast.WalkContinue, nil
	})
	return builder.String()
}
