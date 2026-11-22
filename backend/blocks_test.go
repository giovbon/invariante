package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestParseBlockArgsAcceptsQuotedAndPlainValues(t *testing.T) {
	args := parseBlockArgs(` pasta="Projetos Antigos" limite=3 colunas="titulo,tags" invalido=`)
	if args["pasta"] != "Projetos Antigos" {
		t.Fatalf("pasta argument not parsed: %#v", args)
	}
	if args["limite"] != "3" || args["colunas"] != "titulo,tags" {
		t.Fatalf("unexpected args: %#v", args)
	}
	if _, exists := args["invalido"]; exists {
		t.Fatalf("empty argument should be ignored: %#v", args)
	}
}

func TestExpandNoteBlocksRendersTasksAndRecentNotes(t *testing.T) {
	app := newTestApp(t)
	noteID, err := app.CreateNote(Note{Title: "Proposta", Folder: "Projetos", Content: "TODO: revisar valores"})
	if err != nil {
		t.Fatal(err)
	}
	source := "# Índice\n\n<!-- ton618:tasks pasta=\"Projetos\" -->\n\n<!-- ton618:recentes limite=5 -->"
	expanded := app.expandNoteBlocks(source, noteBlockContext{})
	if strings.Contains(expanded.markdown, "ton618:") {
		t.Fatalf("blocks were not expanded: %s", expanded.markdown)
	}
	if !strings.Contains(expanded.markdown, "`TODO` revisar valores") {
		t.Fatalf("tasks block is missing the task line: %s", expanded.markdown)
	}
	if !strings.Contains(expanded.markdown, fmt.Sprintf("[Proposta](?note=%d)", noteID)) {
		t.Fatalf("recent block is missing the note link: %s", expanded.markdown)
	}
	if !strings.Contains(expanded.markdown, "# Índice") {
		t.Fatalf("expanded note lost its own content: %s", expanded.markdown)
	}
}

func TestBacklinksBlockLinksTheSourceNotes(t *testing.T) {
	app := newTestApp(t)
	targetID, err := app.CreateNote(Note{Title: "Alvo", Folder: "Notas"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := app.CreateNote(Note{Title: "Fonte", Folder: "Notas", Content: "[[Alvo]]"})
	if err != nil {
		t.Fatal(err)
	}
	expanded := app.expandNoteBlocks("<!-- ton618:backlinks -->",
		noteBlockContext{NoteID: targetID, Title: "Alvo", Folder: "Notas"})
	want := fmt.Sprintf("[Fonte](?note=%d)", sourceID)
	if !strings.Contains(expanded.markdown, want) {
		t.Fatalf("backlinks block is missing %q: %s", want, expanded.markdown)
	}
}

func TestLinksBlockListsOutgoingAndMissingTargets(t *testing.T) {
	app := newTestApp(t)
	targetID, err := app.CreateNote(Note{Title: "Destino", Folder: "Notas"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := app.CreateNote(Note{Title: "Origem", Folder: "Notas", Content: "[[Destino]] e [[Sumiu]]"})
	if err != nil {
		t.Fatal(err)
	}
	expanded := app.expandNoteBlocks("<!-- ton618:links -->",
		noteBlockContext{NoteID: sourceID, Title: "Origem", Folder: "Notas"})
	if !strings.Contains(expanded.markdown, fmt.Sprintf("[Destino](?note=%d)", targetID)) {
		t.Fatalf("links block is missing the resolved target: %s", expanded.markdown)
	}
	if !strings.Contains(expanded.markdown, "não encontrada") {
		t.Fatalf("links block should flag unresolved targets: %s", expanded.markdown)
	}
}

func TestTableBlockRendersColumnsAndFiltersByTag(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.CreateNote(Note{Title: "Projeto A", Folder: "Projetos", Tags: []string{"projeto"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.CreateNote(Note{Title: "Projeto B", Folder: "Projetos", Tags: []string{"outro"}}); err != nil {
		t.Fatal(err)
	}
	expanded := app.expandNoteBlocks(
		`<!-- ton618:tabela pasta="Projetos" tag="projeto" colunas="titulo,tags" -->`,
		noteBlockContext{})
	if !strings.Contains(expanded.markdown, "| Título | Tags |") {
		t.Fatalf("table header is wrong: %s", expanded.markdown)
	}
	if !strings.Contains(expanded.markdown, "Projeto A") || strings.Contains(expanded.markdown, "Projeto B") {
		t.Fatalf("table tag filter did not apply: %s", expanded.markdown)
	}
}

func TestParseBlockArgsAcceptsNestedQuotes(t *testing.T) {
	args := parseBlockArgs(` colunas="tags="amigo",pasta="sei lá"" limite=5`)
	if args["colunas"] != `tags="amigo",pasta="sei lá"` {
		t.Fatalf("nested quotes were not preserved: %#v", args)
	}
	if args["limite"] != "5" {
		t.Fatalf("argument after the nested value was lost: %#v", args)
	}
}

func TestTableBlockFiltersByColumnValues(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.CreateNote(Note{Title: "Amigo na praia", Folder: "Projetos", Tags: []string{"amigo"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.CreateNote(Note{Title: "Projeto sem tag", Folder: "Projetos", Tags: []string{"outro"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.CreateNote(Note{Title: "Amigo em outra pasta", Folder: "Pessoal", Tags: []string{"amigo"}}); err != nil {
		t.Fatal(err)
	}
	expanded := app.expandNoteBlocks(
		`<!-- ton618:tabela colunas="titulo,pasta=Projetos,tags=amigo" -->`,
		noteBlockContext{})
	if !strings.Contains(expanded.markdown, "| Título | Pasta | Tags |") {
		t.Fatalf("table header is wrong: %s", expanded.markdown)
	}
	if !strings.Contains(expanded.markdown, "Amigo na praia") {
		t.Fatalf("matching row is missing: %s", expanded.markdown)
	}
	if strings.Contains(expanded.markdown, "Projeto sem tag") ||
		strings.Contains(expanded.markdown, "Amigo em outra pasta") {
		t.Fatalf("column filters did not restrict the rows: %s", expanded.markdown)
	}
}

func TestTableBlockAcceptsNestedQuotesInColumns(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.CreateNote(Note{Title: "Nota do amigo", Folder: "sei lá", Tags: []string{"amigo"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.CreateNote(Note{Title: "Outra nota", Folder: "sei lá", Tags: []string{"outro"}}); err != nil {
		t.Fatal(err)
	}
	expanded := app.expandNoteBlocks(
		`<!-- ton618:tabela colunas="titulo,tags="amigo",pasta="sei lá"" -->`,
		noteBlockContext{})
	if !strings.Contains(expanded.markdown, "Nota do amigo") {
		t.Fatalf("nested quoted filters did not match: %s", expanded.markdown)
	}
	if strings.Contains(expanded.markdown, "Outra nota") {
		t.Fatalf("tag filter was ignored: %s", expanded.markdown)
	}
}

func TestTableBlockShowsAndFiltersFrontmatterProperties(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.CreateNote(Note{
		Title:   "Entrega aberta",
		Content: "---\nstatus: aberto\nprioridade: 2\n---\n\nTexto",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.CreateNote(Note{
		Title:   "Entrega fechada",
		Content: "---\nstatus: fechado\nprioridade: 1\n---\n\nTexto",
	}); err != nil {
		t.Fatal(err)
	}
	expanded := app.expandNoteBlocks(
		`<!-- ton618:tabela colunas="titulo,status=aberto" -->`, noteBlockContext{})
	if !strings.Contains(expanded.markdown, "| Título | status |") {
		t.Fatalf("property column header is wrong: %s", expanded.markdown)
	}
	if !strings.Contains(expanded.markdown, "Entrega aberta") || !strings.Contains(expanded.markdown, "aberto") {
		t.Fatalf("property cell is missing: %s", expanded.markdown)
	}
	if strings.Contains(expanded.markdown, "Entrega fechada") {
		t.Fatalf("property filter did not apply: %s", expanded.markdown)
	}
}

func TestTableBlockOrdersByProperty(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.CreateNote(Note{Title: "Depois", Content: "---\nprioridade: 2\n---"}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.CreateNote(Note{Title: "Antes", Content: "---\nprioridade: 1\n---"}); err != nil {
		t.Fatal(err)
	}
	expanded := app.expandNoteBlocks(
		`<!-- ton618:tabela colunas="titulo,prioridade" ordenar="prioridade" -->`, noteBlockContext{})
	if !strings.Contains(expanded.markdown, "| Título | prioridade |") {
		t.Fatalf("unexpected header: %s", expanded.markdown)
	}
	rows := strings.Split(expanded.markdown, "\n")
	if len(rows) != 4 {
		t.Fatalf("unexpected table rows: %s", expanded.markdown)
	}
	if !strings.Contains(rows[2], "Antes") {
		t.Fatalf("rows are not ordered by the property: %s", expanded.markdown)
	}
}

func TestUnknownBlockAndInvalidContextBecomeWarnings(t *testing.T) {
	app := newTestApp(t)
	unknown := app.expandNoteBlocks("<!-- ton618:inexistente -->", noteBlockContext{})
	if !strings.Contains(unknown.markdown, "⚠️") || !strings.Contains(unknown.markdown, "desconhecido") {
		t.Fatalf("unknown block should warn: %s", unknown.markdown)
	}
	backlinks := app.expandNoteBlocks("<!-- ton618:backlinks -->", noteBlockContext{})
	if !strings.Contains(backlinks.markdown, "nota salva") {
		t.Fatalf("backlinks outside a saved note should warn: %s", backlinks.markdown)
	}
}

func TestExpandNoteBlocksCapsTheAmountOfBlocks(t *testing.T) {
	app := newTestApp(t)
	lines := make([]string, 0, maxNoteBlocks+2)
	for index := 0; index < maxNoteBlocks+2; index++ {
		lines = append(lines, "<!-- ton618:recentes -->")
	}
	expanded := app.expandNoteBlocks(strings.Join(lines, "\n"), noteBlockContext{})
	if !strings.Contains(expanded.markdown, fmt.Sprintf("limite de %d blocos", maxNoteBlocks)) {
		t.Fatalf("block limit warning is missing: %s", expanded.markdown)
	}
}

func TestAdjustSourceLineMapsGeneratedLinesBackToTheComment(t *testing.T) {
	app := newTestApp(t)
	source := "# Um\n## Dois\n<!-- ton618:toc -->\n\ndepois"
	expanded := app.expandNoteBlocks(source, noteBlockContext{})
	if len(expanded.shifts) != 1 {
		t.Fatalf("expected one line shift: %#v", expanded.shifts)
	}
	lines := strings.Split(expanded.markdown, "\n")
	if len(lines) != 6 {
		t.Fatalf("toc should add one line: %#v", lines)
	}
	if got := adjustSourceLine(expanded.shifts, 5); got != 4 {
		t.Fatalf("line after the block maps to %d, want 4", got)
	}
	if got := adjustSourceLine(expanded.shifts, 3); got != 2 {
		t.Fatalf("line inside the block maps to %d, want 2", got)
	}
	if got := adjustSourceLine(expanded.shifts, 1); got != 1 {
		t.Fatalf("line before the block maps to %d, want 1", got)
	}
}

func TestTOCAnchorsMatchTheRenderedHeadingIDs(t *testing.T) {
	app := newTestApp(t)
	source := "## Primeira Seção\n\ntexto\n\n<!-- ton618:toc -->\n\n## Primeira Seção"
	expanded := app.expandNoteBlocks(source, noteBlockContext{})
	response := httptest.NewRecorder()
	renderMarkdownPreviewWithShifts(response, []byte(expanded.markdown), expanded.shifts)
	body := response.Body.String()
	for _, expected := range []string{
		`id="primeira-seção"`,
		`id="primeira-seção-2"`,
		`>Primeira Seção</a>`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("preview is missing %q: %s", expected, body)
		}
	}
	if strings.Count(body, "href=\"#primeira-se") != 2 {
		t.Fatalf("toc should link both headings: %s", body)
	}
}

func TestPreviewEndpointExpandsBlocksForSavedNotes(t *testing.T) {
	app := newTestApp(t)
	handler := app.Handler(filepath.Join("..", "web", "frontend"))
	targetID, err := app.CreateNote(Note{Title: "Alvo", Folder: "Notas"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := app.CreateNote(Note{Title: "Fonte", Folder: "Notas", Content: "[[Alvo]]"})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/preview",
		strings.NewReader("## Contexto\n\n<!-- ton618:backlinks -->"))
	request.Header.Set("Content-Type", "text/plain; charset=utf-8")
	request.Header.Set("X-Note-ID", strconv.FormatInt(targetID, 10))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("preview failed: %d %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, fmt.Sprintf(`href="?note=%d"`, sourceID)) {
		t.Fatalf("backlinks block did not render: %s", body)
	}
	if !strings.Contains(body, `id="contexto"`) {
		t.Fatalf("headings should receive ids: %s", body)
	}
}

func TestMarkdownHeadingsSkipFrontmatterAndCode(t *testing.T) {
	source := "---\ntitle: Nota\n---\n\n# Primeiro\n\n```md\n# não é cabeçalho\n```\n\n### Terceiro *ênfase*"
	headings := markdownHeadings(source)
	if len(headings) != 2 {
		t.Fatalf("unexpected headings: %#v", headings)
	}
	if headings[0].Level != 1 || headings[0].Text != "Primeiro" || headings[0].Slug != "primeiro" {
		t.Fatalf("unexpected first heading: %#v", headings[0])
	}
	if headings[1].Level != 3 || headings[1].Text != "Terceiro ênfase" {
		t.Fatalf("inline formatting should be stripped: %#v", headings[1])
	}
}

func TestTableBlockTagFilterIgnoresCaseAndUsesIndex(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.CreateNote(Note{Title: "Projeto A", Tags: []string{"Projeto"}}); err != nil {
		t.Fatal(err)
	}
	expanded := app.expandNoteBlocks(
		`<!-- ton618:tabela tag="projeto" colunas="titulo" -->`, noteBlockContext{})
	if !strings.Contains(expanded.markdown, "Projeto A") {
		t.Fatalf("tag filter should ignore case: %s", expanded.markdown)
	}

	rows, err := app.readDB.Query(
		`EXPLAIN QUERY PLAN SELECT rowid FROM notes WHERE `+tagFilter(), "projeto")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	details := make([]string, 0, 4)
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatal(err)
		}
		details = append(details, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	plan := strings.Join(details, "\n")
	// note_tags.tag is COLLATE NOCASE, so `tag = ?` is indexable. Wrapping the
	// column in LOWER() used to turn this into a full scan of note_tags.
	if strings.Contains(plan, "SCAN nt") || strings.Contains(plan, "SCAN note_tags") {
		t.Fatalf("tag filter is not using an index: %s", plan)
	}
}

func TestDynamicBlockCacheIsScopedToDataRevision(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.CreateNote(Note{Title: "Primeira"}); err != nil {
		t.Fatal(err)
	}
	first := app.expandNoteBlocks("<!-- ton618:recentes limite=10 -->", noteBlockContext{})
	if !strings.Contains(first.markdown, "Primeira") {
		t.Fatalf("recent block is missing the first note: %s", first.markdown)
	}
	if len(app.blockCache) == 0 {
		t.Fatal("dynamic block should be cached")
	}

	// Insert behind the App's back so the data revision does not change.
	if _, err := app.db.Exec(`INSERT INTO notes(title, content) VALUES ('Segunda', '')`); err != nil {
		t.Fatal(err)
	}
	second := app.expandNoteBlocks("<!-- ton618:recentes limite=10 -->", noteBlockContext{})
	if strings.Contains(second.markdown, "Segunda") {
		t.Fatalf("cached block should be reused within the same revision: %s", second.markdown)
	}

	app.markDataChanged()
	third := app.expandNoteBlocks("<!-- ton618:recentes limite=10 -->", noteBlockContext{})
	if !strings.Contains(third.markdown, "Segunda") {
		t.Fatalf("cache should be invalidated by a new revision: %s", third.markdown)
	}
}
