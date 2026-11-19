package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"unicode/utf8"
)

// Hidden frontmatter columns are an application-wide preference: keeping them
// in app_settings makes every browser see the same table instead of asking the
// user to hide the same columns again on each device.
const (
	tableColumnsKey         = "table_hidden_properties"
	maxHiddenTableColumns   = 500
	maxTableColumnKeyLength = 200
)

type TableColumnSettings struct {
	Hidden     []string `json:"hidden"`
	Configured bool     `json:"configured"`
}

// normalizeHiddenTableColumns trims and deduplicates the keys saved by the
// column picker. Empty entries are ignored so a stale or hand-edited request
// cannot create columns that can never match a frontmatter property.
func normalizeHiddenTableColumns(hidden []string) ([]string, error) {
	result := make([]string, 0, len(hidden))
	seen := make(map[string]struct{}, len(hidden))
	for _, value := range hidden {
		key := strings.TrimSpace(value)
		if key == "" {
			continue
		}
		if utf8.RuneCountInString(key) > maxTableColumnKeyLength {
			return nil, fmt.Errorf("frontmatter column name is too long")
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		if len(result) >= maxHiddenTableColumns {
			return nil, fmt.Errorf("use at most %d hidden columns", maxHiddenTableColumns)
		}
		seen[key] = struct{}{}
		result = append(result, key)
	}
	return result, nil
}

// TableColumnSettings returns the hidden frontmatter properties. Configured is
// false until someone saves a selection, which lets the frontend migrate the
// old browser-local preference on the first visit.
func (a *App) TableColumnSettings() (TableColumnSettings, error) {
	var raw string
	err := a.readDB.QueryRow("SELECT value FROM app_settings WHERE key = ?", tableColumnsKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return TableColumnSettings{Hidden: []string{}}, nil
	}
	if err != nil {
		return TableColumnSettings{}, err
	}
	var stored []string
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		log.Printf("ignore invalid table column settings: %v", err)
		return TableColumnSettings{Hidden: []string{}, Configured: true}, nil
	}
	hidden, err := normalizeHiddenTableColumns(stored)
	if err != nil {
		return TableColumnSettings{}, err
	}
	return TableColumnSettings{Hidden: hidden, Configured: true}, nil
}

// SaveTableColumnSettings validates and stores the hidden columns in SQLite so
// the same configuration is shared by every browser connected to the server.
func (a *App) SaveTableColumnSettings(hidden []string) (TableColumnSettings, error) {
	normalized, err := normalizeHiddenTableColumns(hidden)
	if err != nil {
		return TableColumnSettings{}, err
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return TableColumnSettings{}, err
	}
	_, err = a.db.Exec(`INSERT INTO app_settings(key, value, updated_at)
		VALUES (?, ?, datetime('now'))
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
		tableColumnsKey, string(encoded))
	if err != nil {
		return TableColumnSettings{}, err
	}
	return TableColumnSettings{Hidden: normalized, Configured: true}, nil
}

func (a *App) handleTableColumns(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		settings, err := a.TableColumnSettings()
		if err != nil {
			log.Printf("load table column settings: %v", err)
			http.Error(w, "failed to load table column settings", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, settings)
	case http.MethodPut:
		var request struct {
			Hidden []string `json:"hidden"`
		}
		if err := decodeJSON(w, r, &request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		settings, err := a.SaveTableColumnSettings(request.Hidden)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, settings)
	default:
		methodNotAllowed(w)
	}
}
