package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

// migrateDerivedNoteMetadata materializes data that used to be recomputed from
// the note body on every request: normalized tags (for filtering and counts)
// and the parsed frontmatter (for the table view and the explorer filter).
func migrateDerivedNoteMetadata(tx *sql.Tx) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS note_tags (
			note_id INTEGER NOT NULL REFERENCES notes(rowid) ON DELETE CASCADE,
			tag TEXT NOT NULL COLLATE NOCASE,
			PRIMARY KEY (note_id, tag)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag)`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	if err := ensureNoteColumn(tx, "frontmatter", "TEXT NOT NULL DEFAULT '{}'"); err != nil {
		return err
	}
	if err := ensureNoteColumn(tx, "hide_from_explorer", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}

	// Backfill in small batches so a large library is never loaded at once.
	const batchSize = 50
	lastID := int64(0)
	for {
		type noteRow struct {
			id      int64
			content string
			tags    string
		}
		batch := make([]noteRow, 0, batchSize)
		rows, err := tx.Query(`SELECT rowid, COALESCE(content, ''), COALESCE(tags, '')
			FROM notes WHERE rowid > ? ORDER BY rowid LIMIT ?`, lastID, batchSize)
		if err != nil {
			return err
		}
		for rows.Next() {
			var item noteRow
			if err := rows.Scan(&item.id, &item.content, &item.tags); err != nil {
				rows.Close()
				return err
			}
			batch = append(batch, item)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if len(batch) == 0 {
			return nil
		}
		for _, item := range batch {
			if err := syncNoteMetadata(tx, item.id, item.content, splitTags(item.tags)); err != nil {
				return fmt.Errorf("backfill note %d: %w", item.id, err)
			}
		}
		lastID = batch[len(batch)-1].id
	}
}

func ensureNoteColumn(tx *sql.Tx, name, definition string) error {
	rows, err := tx.Query("PRAGMA table_info(notes)")
	if err != nil {
		return err
	}
	exists := false
	for rows.Next() {
		var cid, notNull, primaryKey int
		var columnName, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &columnName, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			rows.Close()
			return err
		}
		if columnName == name {
			exists = true
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if exists {
		return nil
	}
	_, err = tx.Exec(fmt.Sprintf("ALTER TABLE notes ADD COLUMN %s %s", name, definition))
	return err
}

// syncNoteMetadata keeps the derived columns and the normalized tag table in
// step with the note body. It runs inside the same transaction as the write.
func syncNoteMetadata(tx *sql.Tx, noteID int64, content string, tags []string) error {
	properties := frontmatterProperties(content)
	encoded, err := json.Marshal(properties)
	if err != nil {
		return err
	}
	hidden := 0
	if value, ok := properties["hide_from_explorer"].(bool); ok && value {
		hidden = 1
	}
	if _, err := tx.Exec(`UPDATE notes SET frontmatter = ?, hide_from_explorer = ? WHERE rowid = ?`,
		string(encoded), hidden, noteID); err != nil {
		return err
	}
	return replaceNoteTags(tx, noteID, tags)
}

func replaceNoteTags(tx *sql.Tx, noteID int64, tags []string) error {
	if _, err := tx.Exec("DELETE FROM note_tags WHERE note_id = ?", noteID); err != nil {
		return err
	}
	seen := make(map[string]struct{}, len(tags))
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		key := strings.ToLower(tag)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO note_tags(note_id, tag) VALUES (?, ?)`,
			noteID, tag); err != nil {
			return err
		}
	}
	return nil
}
