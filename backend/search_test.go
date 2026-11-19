package main

import (
	"strconv"
	"strings"
	"testing"
)

func TestFTSQuerySupportsExactPhrases(t *testing.T) {
	expressions, err := ftsMatchExpressions(`"subjuguem a terra"`, "content")
	if err != nil {
		t.Fatal(err)
	}
	if len(expressions) != 1 || expressions[0] != `content : ("subjuguem a terra")` {
		t.Fatalf("phrase query = %#v", expressions)
	}
	mixed, err := ftsMatchExpressions(`terra "a queda"`, "content")
	if err != nil {
		t.Fatal(err)
	}
	if mixed[0] != `content : ("terra"* AND "a queda")` {
		t.Fatalf("mixed query = %#v", mixed)
	}
	if len(mixed) != 2 || mixed[1] != `content : ("terra"* OR "a queda")` {
		t.Fatalf("relaxed query = %#v", mixed)
	}
}

func TestContentSearchRequiresEveryTermWhenAllMatch(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.CreateNote(Note{Title: "Completa", Content: "Eles subjuguem a terra com fogo"}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.CreateNote(Note{Title: "Parcial", Content: "A terra queimou"}); err != nil {
		t.Fatal(err)
	}
	page, err := app.SearchNotes("subjuguem a terra", "content", "", "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || page.Items[0].Title != "Completa" {
		t.Fatalf("strict search = %#v", page)
	}
}

func TestContentSearchFallsBackWhenATermDoesNotMatch(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.CreateNote(Note{Title: "Flexão", Content: "Eles subjugam a terra com fogo"}); err != nil {
		t.Fatal(err)
	}
	page, err := app.SearchNotes("subjuguem a terra", "content", "", "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || page.Items[0].Title != "Flexão" {
		t.Fatalf("relaxed search = %#v", page)
	}
	if len(page.Items[0].Snippets) == 0 || !strings.Contains(page.Items[0].Preview, "<mark>") {
		t.Fatalf("relaxed search should still highlight: %#v", page.Items[0])
	}
}

func TestPhraseSearchMatchesOnlyTheExactSequence(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.CreateNote(Note{Title: "Ordem certa", Content: "eles subjuguem a terra"}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.CreateNote(Note{Title: "Ordem trocada", Content: "a terra subjuguem eles"}); err != nil {
		t.Fatal(err)
	}
	page, err := app.SearchNotes(`"subjuguem a terra"`, "content", "", "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || page.Items[0].Title != "Ordem certa" {
		t.Fatalf("phrase search = %#v", page)
	}
}

func TestNoteOccurrencesFollowsTheSameFallback(t *testing.T) {
	app := newTestApp(t)
	id, err := app.CreateNote(Note{Title: "Flexão", Content: "Eles subjugam a terra. Depois a terra queimou."})
	if err != nil {
		t.Fatal(err)
	}
	snippets, occurrences, err := app.NoteOccurrences(id, "subjuguem a terra")
	if err != nil {
		t.Fatal(err)
	}
	if len(snippets) == 0 || occurrences == 0 {
		t.Fatalf("occurrences did not use the relaxed match: snippets=%#v occurrences=%d", snippets, occurrences)
	}
}

func TestSearchTotalCapsAtLimit(t *testing.T) {
	app := newTestApp(t)
	tx, err := app.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < maxSearchCount+5; index++ {
		if _, err := tx.Exec("INSERT INTO notes(title, content) VALUES (?, ?)",
			"Cap "+strconv.Itoa(index), "cappedtoken body"); err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	page, err := app.SearchNotes("cappedtoken", "content", "", "", 5, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != maxSearchCount || !page.TotalCapped || len(page.Items) != 5 {
		t.Fatalf("capped search = total %d capped %v items %d", page.Total, page.TotalCapped, len(page.Items))
	}
}
