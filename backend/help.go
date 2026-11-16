package main

import (
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

// helpFilePath locates HELP.md at the project root. The handler only receives
// the frontend directory, which lives at <root>/web/frontend, so the root is
// two levels above it.
func helpFilePath(frontendDir string) string {
	return filepath.Join(filepath.Dir(filepath.Dir(frontendDir)), "HELP.md")
}

func (a *App) handleHelp(frontendDir string) http.HandlerFunc {
	path := helpFilePath(frontendDir)
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			methodNotAllowed(w)
			return
		}
		info, err := os.Stat(path)
		if errors.Is(err, fs.ErrNotExist) {
			http.Error(w, "HELP.md não encontrado na raiz do projeto", http.StatusNotFound)
			return
		}
		if err != nil {
			log.Printf("read help file: %v", err)
			http.Error(w, "não foi possível ler o HELP.md", http.StatusInternalServerError)
			return
		}
		if info.IsDir() {
			http.Error(w, "HELP.md não é um arquivo", http.StatusInternalServerError)
			return
		}
		if info.Size() > maxContentSize {
			http.Error(w, "HELP.md excede o limite de 5 MiB", http.StatusRequestEntityTooLarge)
			return
		}
		source, err := os.ReadFile(path)
		if err != nil {
			log.Printf("read help file: %v", err)
			http.Error(w, "não foi possível ler o HELP.md", http.StatusInternalServerError)
			return
		}
		// Help should reflect edits to HELP.md without a server restart.
		w.Header().Set("Cache-Control", "no-cache")
		renderMarkdownPreview(w, source)
	}
}
