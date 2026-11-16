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
