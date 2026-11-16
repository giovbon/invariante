package main

import (
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
	maxBlockArgLength = 120
)

var (
	noteBlockPattern    = regexp.MustCompile(`^[\t ]*<!--[\t ]*` + noteBlockPrefix + `:([a-z][a-z-]*)([^>\n]*)-->[\t ]*$`)
	noteBlockArgPattern = regexp.MustCompile(`([A-Za-z][A-Za-z0-9-]*)=("[^"]*"|'[^']*'|[^\s]+)`)
	headingLinePattern  = regexp.MustCompile(`^\s{0,3}(?:>\s*)*(#{1,6})\s+(.+?)\s*#*\s*$`)
	headingLinkPattern  = regexp.MustCompile(`\[([^\]\n]*)\]\([^)\n]*\)`)
	headingWikiPattern  = regexp.MustCompile(`\[\[([^\]\n|]*)(?:\|([^\]\n]*))?\]\]`)
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

func parseBlockArgs(raw string) map[string]string {
	args := make(map[string]string)
	for _, match := range noteBlockArgPattern.FindAllStringSubmatch(raw, -1) {
		value := strings.Trim(match[2], `"'`)
		if len(value) > maxBlockArgLength {
			continue
		}
		args[strings.ToLower(match[1])] = value
	}
	return args
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

func (a *App) renderTableBlock(args map[string]string) string {
	limit := intArg(args, "limite", 20, maxBlockItems)
	folder := strings.TrimSpace(args["pasta"])
	tag := strings.ToLower(strings.TrimSpace(args["tag"]))
	columns := parseTableColumns(args["colunas"])
	// A tag é comparada em Go porque a lista é gravada como "a, b, c" e o
	// filtro precisa aceitar variações de espaço.
	rows, err := a.readDB.Query(`SELECT rowid, title, COALESCE(folder, ''), COALESCE(tags, ''), updated_at, created_at
		FROM notes
		WHERE (? = '' OR LOWER(COALESCE(folder, '')) = LOWER(?))
		ORDER BY updated_at DESC, rowid DESC LIMIT ?`, folder, folder, min(maxTaskResults, limit*10))
	if err != nil {
		return blockWarning("não foi possível montar a tabela")
	}
	defer rows.Close()
	lines := make([]string, 0, limit+2)
	headers := make([]string, len(columns))
	for index, column := range columns {
		headers[index] = tableColumnLabel(column)
	}
	lines = append(lines, "| "+strings.Join(headers, " | ")+" |")
	lines = append(lines, "|"+strings.Repeat(" --- |", len(columns)))
	count := 0
	for rows.Next() && count < limit {
		var id int64
		var title, noteFolder, tags, updatedAt, createdAt string
		if err := rows.Scan(&id, &title, &noteFolder, &tags, &updatedAt, &createdAt); err != nil {
			return blockWarning("não foi possível montar a tabela")
		}
		if tag != "" && !containsTag(splitTags(tags), tag) {
			continue
		}
		cells := make([]string, len(columns))
		for index, column := range columns {
			switch column {
			case "titulo":
				cells[index] = fmt.Sprintf("[%s](?note=%d)", escapeMarkdownLinkLabel(title), id)
			case "pasta":
				cells[index] = escapeTableCell(noteFolder)
			case "tags":
				cells[index] = escapeTableCell(strings.Join(splitTags(tags), ", "))
			case "criado":
				cells[index] = shortTimestamp(createdAt)
			default:
				cells[index] = shortTimestamp(updatedAt)
			}
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

func parseTableColumns(raw string) []string {
	columns := make([]string, 0, 4)
	seen := make(map[string]struct{})
	for _, field := range strings.Split(raw, ",") {
		column := strings.ToLower(strings.TrimSpace(field))
		switch column {
		case "titulo", "pasta", "tags", "atualizado", "criado":
		default:
			continue
		}
		if _, duplicate := seen[column]; duplicate {
			continue
		}
		seen[column] = struct{}{}
		columns = append(columns, column)
	}
	if len(columns) == 0 {
		return []string{"titulo", "atualizado"}
	}
	return columns
}

func tableColumnLabel(column string) string {
	switch column {
	case "titulo":
		return "Título"
	case "pasta":
		return "Pasta"
	case "tags":
		return "Tags"
	case "criado":
		return "Criado"
	default:
		return "Atualizado"
	}
}

func containsTag(tags []string, wanted string) bool {
	for _, tag := range tags {
		if strings.EqualFold(tag, wanted) {
			return true
		}
	}
	return false
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
