package main

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

const (
	// Kept stable across the TON-618 rebrand so existing backup archives
	// remain importable.
	backupFormat        = "pkm-notes-backup"
	backupVersion       = 1
	maxBackupUpload     = 512 << 20
	maxBackupManifest   = 512 << 20
	maxBackupNotes      = 100000
	maxBackupAttachment = maxAttachmentSize
	maxBackupAgenda     = 100000
)

var errInvalidBackup = errors.New("invalid backup archive")

type backupManifest struct {
	Format      string             `json:"format"`
	Version     int                `json:"version"`
	CreatedAt   string             `json:"created_at"`
	Notes       []backupNote       `json:"notes"`
	Folders     []string           `json:"folders,omitempty"`
	Attachments []backupAttachment `json:"attachments"`
	// Agenda is optional so backups written before the agenda existed remain
	// valid.
	Agenda []backupAgendaEvent `json:"agenda,omitempty"`
}

type backupAgendaEvent struct {
	Title     string `json:"title"`
	EventAt   int64  `json:"event_at"`
	Done      bool   `json:"done"`
	CreatedAt string `json:"created_at,omitempty"`
}

type backupNote struct {
	ID        int64    `json:"id"`
	Title     string   `json:"title"`
	Content   string   `json:"content"`
	Folder    string   `json:"folder"`
	Tags      []string `json:"tags,omitempty"`
	Version   int64    `json:"version"`
	CreatedAt string   `json:"created_at"`
	UpdatedAt string   `json:"updated_at"`
}

type backupAttachment struct {
	ID          int64  `json:"id"`
	NoteID      int64  `json:"note_id"`
	Filename    string `json:"filename"`
	StorageName string `json:"storage_name"`
	MediaType   string `json:"media_type"`
	Size        int64  `json:"size"`
	CreatedAt   string `json:"created_at"`
	// ArchivePath records where the attachment file lives inside the zip.
	// Older archives omit it and keep the legacy attachments/<note>/<file>
	// layout, which restore still understands.
	ArchivePath string `json:"archive_path,omitempty"`
}

// backupAttachmentFile carries attachment metadata alongside the on-disk path
// that still has to be copied into the archive.
type backupAttachmentFile struct {
	meta backupAttachment
	path string
}

// ExportBackup writes a logical archive with a manifest and every attachment
// file. Note IDs are preserved so attachment URLs stored in note content keep
// working after a restore. Note bodies are streamed instead of accumulated in
// memory, so the export size is bounded by the archive rather than the library.
func (a *App) ExportBackup(destination io.Writer) error {
	// Keep deletions out while the archive reads attachment files.
	a.dataMu.RLock()
	defer a.dataMu.RUnlock()

	// A read transaction gives the note files and the manifest the same
	// snapshot even if another tab saves a note while the backup runs.
	tx, err := a.readDB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	archive := zip.NewWriter(destination)
	notesByID := make(map[int64]backupNote)

	rows, err := tx.Query(`SELECT rowid, title, COALESCE(content, ''), COALESCE(folder, ''),
		COALESCE(tags, ''), version, created_at, updated_at FROM notes ORDER BY rowid`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var note backupNote
		var tags string
		if err := rows.Scan(&note.ID, &note.Title, &note.Content, &note.Folder,
			&tags, &note.Version, &note.CreatedAt, &note.UpdatedAt); err != nil {
			rows.Close()
			return err
		}
		note.Tags = splitTags(tags)
		// Only metadata is retained; the body is written to the zip and
		// released before the next row is read.
		notesByID[note.ID] = backupNote{ID: note.ID, Title: note.Title, Folder: note.Folder}
		header := &zip.FileHeader{
			Name:     backupNotePath(note),
			Method:   zip.Deflate,
			Modified: time.Now(),
		}
		header.SetMode(0600)
		writer, err := archive.CreateHeader(header)
		if err != nil {
			rows.Close()
			return err
		}
		if _, err := io.WriteString(writer, note.Content); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}

	folders := make([]string, 0)
	rows, err = tx.Query("SELECT path FROM folders ORDER BY path")
	if err != nil {
		return err
	}
	for rows.Next() {
		var folder string
		if err := rows.Scan(&folder); err != nil {
			rows.Close()
			return err
		}
		folders = append(folders, folder)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}

	attachments := make([]backupAttachment, 0)
	files := make([]backupAttachmentFile, 0)
	rows, err = tx.Query(`SELECT id, note_id, filename, storage_name, media_type, size, created_at
		FROM attachments ORDER BY note_id, id`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var item backupAttachment
		if err := rows.Scan(&item.ID, &item.NoteID, &item.Filename, &item.StorageName,
			&item.MediaType, &item.Size, &item.CreatedAt); err != nil {
			rows.Close()
			return err
		}
		filePath := filepath.Join(a.attachmentsDir, fmt.Sprint(item.NoteID), item.StorageName)
		if _, err := os.Stat(filePath); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				log.Printf("backup: skipping missing attachment %d (%s)", item.ID, filePath)
				continue
			}
			rows.Close()
			return err
		}
		item.ArchivePath = backupAttachmentPath(notesByID[item.NoteID], item.StorageName)
		attachments = append(attachments, item)
		files = append(files, backupAttachmentFile{meta: item, path: filePath})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}

	for _, file := range files {
		header := &zip.FileHeader{
			Name:     file.meta.ArchivePath,
			Method:   zip.Deflate,
			Modified: time.Now(),
		}
		header.SetMode(0600)
		writer, err := archive.CreateHeader(header)
		if err != nil {
			return err
		}
		source, err := os.Open(file.path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(writer, source)
		closeErr := source.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}

	// The manifest is written last by streaming each note body again. Zip
	// entries cannot be interleaved, and avoiding a temporary copy keeps the
	// export self-contained in the data directory.
	manifestWriter, err := archive.CreateHeader(&zip.FileHeader{
		Name:     "manifest.json",
		Method:   zip.Deflate,
		Modified: time.Now(),
	})
	if err != nil {
		return err
	}
	if _, err := io.WriteString(manifestWriter, `{"format":`); err != nil {
		return err
	}
	if err := writeJSONValue(manifestWriter, backupFormat); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(manifestWriter, `,"version":%d,"created_at":`, backupVersion); err != nil {
		return err
	}
	if err := writeJSONValue(manifestWriter, time.Now().UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	if _, err := io.WriteString(manifestWriter, `,"notes":[`); err != nil {
		return err
	}
	rows, err = tx.Query(`SELECT rowid, title, COALESCE(content, ''), COALESCE(folder, ''),
		COALESCE(tags, ''), version, created_at, updated_at FROM notes ORDER BY rowid`)
	if err != nil {
		return err
	}
	first := true
	for rows.Next() {
		var note backupNote
		var tags string
		if err := rows.Scan(&note.ID, &note.Title, &note.Content, &note.Folder,
			&tags, &note.Version, &note.CreatedAt, &note.UpdatedAt); err != nil {
			rows.Close()
			return err
		}
		note.Tags = splitTags(tags)
		if !first {
			if _, err := io.WriteString(manifestWriter, ","); err != nil {
				rows.Close()
				return err
			}
		}
		first = false
		if err := writeJSONValue(manifestWriter, note); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if _, err := io.WriteString(manifestWriter, `],"folders":`); err != nil {
		return err
	}
	if err := writeJSONValue(manifestWriter, folders); err != nil {
		return err
	}
	if _, err := io.WriteString(manifestWriter, `,"attachments":`); err != nil {
		return err
	}
	if err := writeJSONValue(manifestWriter, attachments); err != nil {
		return err
	}
	agenda, err := loadBackupAgenda(tx)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(manifestWriter, `,"agenda":`); err != nil {
		return err
	}
	if err := writeJSONValue(manifestWriter, agenda); err != nil {
		return err
	}
	if _, err := io.WriteString(manifestWriter, `}`); err != nil {
		return err
	}
	return archive.Close()
}

func loadBackupAgenda(tx *sql.Tx) ([]backupAgendaEvent, error) {
	rows, err := tx.Query(`SELECT title, event_at, done, created_at
		FROM agenda_events ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]backupAgendaEvent, 0, 16)
	for rows.Next() {
		var event backupAgendaEvent
		var done int
		if err := rows.Scan(&event.Title, &event.EventAt, &done, &event.CreatedAt); err != nil {
			return nil, err
		}
		event.Done = done != 0
		events = append(events, event)
	}
	return events, rows.Err()
}

func writeJSONValue(writer io.Writer, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = writer.Write(data)
	return err
}

// sanitizeBackupSegment turns note titles and folder names into portable zip
// path segments, removing characters that some file systems reject.
func sanitizeBackupSegment(name string) string {
	sanitized := strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return '-'
		}
		if r < 0x20 || r == 0x7f {
			return '-'
		}
		return r
	}, strings.TrimSpace(name))
	sanitized = strings.Trim(sanitized, " .-")
	if runes := []rune(sanitized); len(runes) > 80 {
		sanitized = string(runes[:80])
	}
	return sanitized
}

// backupNotePath keeps notes inside the same folder hierarchy used by the app,
// so extracting the archive reproduces the folder tree.
func backupNotePath(note backupNote) string {
	folder := "notes"
	for _, part := range strings.Split(note.Folder, "/") {
		if part == "" {
			continue
		}
		segment := sanitizeBackupSegment(part)
		if segment == "" {
			segment = "_"
		}
		folder = path.Join(folder, segment)
	}
	name := fmt.Sprintf("%d.md", note.ID)
	if title := sanitizeBackupSegment(note.Title); title != "" {
		name = fmt.Sprintf("%d - %s.md", note.ID, title)
	}
	return path.Join(folder, name)
}

// backupAttachmentPath gives every note its own attachment folder named after
// the note ID and title, so files from different notes never mix.
func backupAttachmentPath(note backupNote, storageName string) string {
	folder := fmt.Sprintf("attachments/%d", note.ID)
	if title := sanitizeBackupSegment(note.Title); title != "" {
		folder = fmt.Sprintf("attachments/%d - %s", note.ID, title)
	}
	return path.Join(folder, storageName)
}

// backupAttachmentArchivePath resolves the zip location for an attachment.
// Archives created before archive_path existed used attachments/<note>/<file>.
func backupAttachmentArchivePath(attachment backupAttachment) string {
	if attachment.ArchivePath != "" {
		return attachment.ArchivePath
	}
	return path.Join("attachments", fmt.Sprint(attachment.NoteID), attachment.StorageName)
}

func validBackupArchivePath(name string) bool {
	if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, `\`) {
		return false
	}
	if path.Clean(name) != name || !strings.HasPrefix(name, "attachments/") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// RestoreBackup replaces the whole library with the archive contents. All
// validation happens before the database and attachment directory are touched,
// so a malformed archive leaves the current data intact.
func (a *App) RestoreBackup(data []byte) (int, int, error) {
	return a.RestoreBackupReader(bytes.NewReader(data), int64(len(data)))
}

// RestoreBackupReader is the streaming entry point used by the HTTP handler.
// It receives a file-backed ReaderAt so a large archive is never held entirely
// in memory.
func (a *App) RestoreBackupReader(reader io.ReaderAt, size int64) (int, int, error) {
	manifest, files, err := readBackupArchive(reader, size)
	if err != nil {
		return 0, 0, err
	}

	staging, err := os.MkdirTemp(filepath.Dir(a.attachmentsDir), ".restore-*")
	if err != nil {
		return 0, 0, fmt.Errorf("create restore staging directory: %w", err)
	}
	defer os.RemoveAll(staging)
	if err := writeRestoreFiles(staging, manifest.Attachments, files); err != nil {
		return 0, 0, err
	}

	// The swap of the live attachments directory and the database commit must
	// be invisible to concurrent uploads, deletions and exports.
	a.dataMu.Lock()
	defer a.dataMu.Unlock()

	restoreAttachments, cleanupAttachments, err := swapAttachmentsDir(a.attachmentsDir, staging)
	if err != nil {
		return 0, 0, err
	}
	committed := false
	defer func() {
		if !committed {
			restoreAttachments()
		}
	}()

	tx, err := a.db.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM notes"); err != nil {
		return 0, 0, err
	}
	if _, err := tx.Exec("DELETE FROM folders"); err != nil {
		return 0, 0, err
	}
	if _, err := tx.Exec("DELETE FROM agenda_events"); err != nil {
		return 0, 0, err
	}
	// Restored events receive new IDs, so old reminder keys would point at the
	// wrong row and could suppress notifications.
	if _, err := tx.Exec("DELETE FROM agenda_notifications"); err != nil {
		return 0, 0, err
	}
	if err := insertRestoredNotes(tx, manifest.Notes); err != nil {
		return 0, 0, err
	}
	if err := insertRestoredFolders(tx, manifest.Folders); err != nil {
		return 0, 0, err
	}
	if err := insertRestoredAttachments(tx, manifest.Attachments); err != nil {
		return 0, 0, err
	}
	if err := insertRestoredAgenda(tx, manifest.Agenda); err != nil {
		return 0, 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	committed = true
	cleanupAttachments()
	a.markDataChanged()
	a.notifyChange()
	return len(manifest.Notes), len(manifest.Attachments), nil
}

func readBackupArchive(reader io.ReaderAt, size int64) (backupManifest, map[string]*zip.File, error) {
	if size > maxBackupUpload {
		return backupManifest{}, nil, fmt.Errorf("%w: archive exceeds the %d MiB limit",
			errInvalidBackup, maxBackupUpload>>20)
	}
	archive, err := zip.NewReader(reader, size)
	if err != nil {
		return backupManifest{}, nil, fmt.Errorf("%w: %v", errInvalidBackup, err)
	}
	files := make(map[string]*zip.File, len(archive.File))
	for _, file := range archive.File {
		if _, exists := files[file.Name]; exists {
			return backupManifest{}, nil, fmt.Errorf("%w: duplicate entry %q", errInvalidBackup, file.Name)
		}
		files[file.Name] = file
	}
	manifestFile, exists := files["manifest.json"]
	if !exists {
		return backupManifest{}, nil, fmt.Errorf("%w: missing manifest.json", errInvalidBackup)
	}
	if manifestFile.UncompressedSize64 > maxBackupManifest {
		return backupManifest{}, nil, fmt.Errorf("%w: manifest is too large", errInvalidBackup)
	}
	manifestReader, err := manifestFile.Open()
	if err != nil {
		return backupManifest{}, nil, err
	}
	var manifest backupManifest
	decodeErr := json.NewDecoder(io.LimitReader(manifestReader, maxBackupManifest)).Decode(&manifest)
	closeErr := manifestReader.Close()
	if decodeErr != nil {
		return backupManifest{}, nil, fmt.Errorf("%w: %v", errInvalidBackup, decodeErr)
	}
	if closeErr != nil {
		return backupManifest{}, nil, closeErr
	}
	if manifest.Format != backupFormat || manifest.Version != backupVersion {
		return backupManifest{}, nil, fmt.Errorf("%w: unsupported format or version", errInvalidBackup)
	}
	if len(manifest.Notes) > maxBackupNotes {
		return backupManifest{}, nil, fmt.Errorf("%w: too many notes", errInvalidBackup)
	}

	seenFolders := make(map[string]struct{}, len(manifest.Folders))
	for index, folder := range manifest.Folders {
		normalized, err := normalizeFolder(folder)
		if err != nil || normalized != folder || folder == "" {
			return backupManifest{}, nil, fmt.Errorf("%w: folder %d has an invalid path", errInvalidBackup, index)
		}
		if _, exists := seenFolders[folder]; exists {
			return backupManifest{}, nil, fmt.Errorf("%w: duplicate folder %q", errInvalidBackup, folder)
		}
		seenFolders[folder] = struct{}{}
	}

	noteIDs := make(map[int64]struct{}, len(manifest.Notes))
	for index := range manifest.Notes {
		note := &manifest.Notes[index]
		if note.ID < 1 {
			return backupManifest{}, nil, fmt.Errorf("%w: note %d has an invalid ID", errInvalidBackup, index)
		}
		if _, exists := noteIDs[note.ID]; exists {
			return backupManifest{}, nil, fmt.Errorf("%w: duplicate note ID %d", errInvalidBackup, note.ID)
		}
		noteIDs[note.ID] = struct{}{}
		candidate := Note{
			Title: note.Title, Content: note.Content, Folder: note.Folder, Tags: note.Tags,
		}
		if err := validateNote(&candidate); err != nil {
			return backupManifest{}, nil, fmt.Errorf("%w: note %d: %v", errInvalidBackup, note.ID, err)
		}
		note.Title = candidate.Title
		note.Folder = candidate.Folder
		note.Tags = candidate.Tags
		if note.Version < 1 {
			note.Version = 1
		}
	}

	attachmentIDs := make(map[int64]struct{}, len(manifest.Attachments))
	storageNames := make(map[string]struct{}, len(manifest.Attachments))
	archivePaths := make(map[string]struct{}, len(manifest.Attachments))
	for index := range manifest.Attachments {
		attachment := &manifest.Attachments[index]
		if attachment.ID < 1 {
			return backupManifest{}, nil, fmt.Errorf("%w: attachment has an invalid ID", errInvalidBackup)
		}
		if _, exists := attachmentIDs[attachment.ID]; exists {
			return backupManifest{}, nil, fmt.Errorf("%w: duplicate attachment ID %d", errInvalidBackup, attachment.ID)
		}
		attachmentIDs[attachment.ID] = struct{}{}
		if _, exists := noteIDs[attachment.NoteID]; !exists {
			return backupManifest{}, nil, fmt.Errorf("%w: attachment %d references an unknown note",
				errInvalidBackup, attachment.ID)
		}
		filename, err := cleanAttachmentFilename(attachment.Filename)
		if err != nil || filename != attachment.Filename {
			return backupManifest{}, nil, fmt.Errorf("%w: attachment %d has an invalid filename",
				errInvalidBackup, attachment.ID)
		}
		if !validStorageName(attachment.StorageName) {
			return backupManifest{}, nil, fmt.Errorf("%w: attachment %d has an invalid storage name",
				errInvalidBackup, attachment.ID)
		}
		key := fmt.Sprintf("%d/%s", attachment.NoteID, attachment.StorageName)
		if _, exists := storageNames[key]; exists {
			return backupManifest{}, nil, fmt.Errorf("%w: duplicate attachment storage %q", errInvalidBackup, key)
		}
		storageNames[key] = struct{}{}
		if attachment.Size < 0 || attachment.Size > maxBackupAttachment {
			return backupManifest{}, nil, fmt.Errorf("%w: attachment %d has an invalid size",
				errInvalidBackup, attachment.ID)
		}
		if strings.TrimSpace(attachment.MediaType) == "" ||
			strings.ContainsAny(attachment.MediaType, "\r\n\x00") {
			return backupManifest{}, nil, fmt.Errorf("%w: attachment %d has an invalid media type",
				errInvalidBackup, attachment.ID)
		}
		archivePath := backupAttachmentArchivePath(*attachment)
		if !validBackupArchivePath(archivePath) {
			return backupManifest{}, nil, fmt.Errorf("%w: attachment %d has an invalid archive path",
				errInvalidBackup, attachment.ID)
		}
		if _, exists := archivePaths[archivePath]; exists {
			return backupManifest{}, nil, fmt.Errorf("%w: duplicate attachment archive path %q",
				errInvalidBackup, archivePath)
		}
		archivePaths[archivePath] = struct{}{}
		attachment.ArchivePath = archivePath
		entry, exists := files[archivePath]
		if !exists {
			return backupManifest{}, nil, fmt.Errorf("%w: missing file for attachment %d",
				errInvalidBackup, attachment.ID)
		}
		if entry.UncompressedSize64 > maxBackupAttachment {
			return backupManifest{}, nil, fmt.Errorf("%w: attachment %d is too large",
				errInvalidBackup, attachment.ID)
		}
	}
	if len(manifest.Agenda) > maxBackupAgenda {
		return backupManifest{}, nil, fmt.Errorf("%w: too many agenda events", errInvalidBackup)
	}
	for index := range manifest.Agenda {
		event := &manifest.Agenda[index]
		title, err := normalizeAgendaTitle(event.Title)
		if err != nil {
			return backupManifest{}, nil, fmt.Errorf("%w: agenda event %d: %v", errInvalidBackup, index, err)
		}
		event.Title = title
		when := time.Unix(event.EventAt, 0).UTC()
		if when.Year() < 1900 || when.Year() > 2200 {
			return backupManifest{}, nil, fmt.Errorf("%w: agenda event %d has an invalid date", errInvalidBackup, index)
		}
	}
	return manifest, files, nil
}

func insertRestoredAgenda(tx *sql.Tx, events []backupAgendaEvent) error {
	for _, event := range events {
		createdAt := strings.TrimSpace(event.CreatedAt)
		if createdAt == "" {
			createdAt = time.Now().UTC().Format(time.RFC3339)
		}
		done := 0
		if event.Done {
			done = 1
		}
		if _, err := tx.Exec(`INSERT INTO agenda_events(title, event_at, done, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?)`, event.Title, event.EventAt, done, createdAt, createdAt); err != nil {
			return fmt.Errorf("restore agenda event %q: %w", event.Title, err)
		}
	}
	return nil
}

func insertRestoredFolders(tx *sql.Tx, folders []string) error {
	for _, folder := range folders {
		if err := insertFolderPath(tx, folder); err != nil {
			return fmt.Errorf("restore folder %q: %w", folder, err)
		}
	}
	return nil
}

func validStorageName(name string) bool {
	if name == "" || name == "." || name == ".." {
		return false
	}
	if strings.ContainsAny(name, `/\`) || path.Base(name) != name {
		return false
	}
	return true
}

func writeRestoreFiles(staging string, attachments []backupAttachment, files map[string]*zip.File) error {
	for _, attachment := range attachments {
		entry := files[backupAttachmentArchivePath(attachment)]
		source, err := entry.Open()
		if err != nil {
			return fmt.Errorf("open attachment %d: %w", attachment.ID, err)
		}
		noteDir := filepath.Join(staging, fmt.Sprint(attachment.NoteID))
		if err := os.MkdirAll(noteDir, 0700); err != nil {
			source.Close()
			return fmt.Errorf("create attachment directory: %w", err)
		}
		destination := filepath.Join(noteDir, attachment.StorageName)
		file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			source.Close()
			return fmt.Errorf("create restored attachment: %w", err)
		}
		size, copyErr := io.Copy(file, io.LimitReader(source, maxBackupAttachment+1))
		closeErr := file.Close()
		sourceErr := source.Close()
		if copyErr != nil {
			return fmt.Errorf("restore attachment %d: %w", attachment.ID, copyErr)
		}
		if closeErr != nil {
			return closeErr
		}
		if sourceErr != nil {
			return sourceErr
		}
		if size != attachment.Size {
			return fmt.Errorf("%w: attachment %d has size %d, expected %d",
				errInvalidBackup, attachment.ID, size, attachment.Size)
		}
	}
	return nil
}

// swapAttachmentsDir replaces the live directory with the staged one. It
// returns a rollback function for a failed database commit and a cleanup
// function that removes the previous directory after a successful restore.
func swapAttachmentsDir(current, staged string) (func(), func(), error) {
	previous := current + ".previous"
	if err := os.RemoveAll(previous); err != nil {
		return nil, nil, err
	}
	hasPrevious := false
	if _, err := os.Stat(current); err == nil {
		if err := os.Rename(current, previous); err != nil {
			return nil, nil, err
		}
		hasPrevious = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, nil, err
	}
	if err := os.Rename(staged, current); err != nil {
		if hasPrevious {
			_ = os.Rename(previous, current)
		}
		return nil, nil, err
	}
	rollback := func() {
		_ = os.RemoveAll(current)
		if hasPrevious {
			_ = os.Rename(previous, current)
		}
	}
	cleanup := func() {
		if hasPrevious {
			_ = os.RemoveAll(previous)
		}
	}
	return rollback, cleanup, nil
}

func insertRestoredNotes(tx *sql.Tx, notes []backupNote) error {
	for index, note := range notes {
		if index > 0 && index%1000 == 0 {
			log.Printf("restore: inserted %d of %d notes", index, len(notes))
		}
		createdAt := strings.TrimSpace(note.CreatedAt)
		updatedAt := strings.TrimSpace(note.UpdatedAt)
		if _, err := tx.Exec(`INSERT INTO notes(rowid, title, content, folder, tags, version, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, COALESCE(NULLIF(?, ''), datetime('now')),
				COALESCE(NULLIF(?, ''), datetime('now')))`,
			note.ID, note.Title, note.Content, note.Folder, strings.Join(note.Tags, ","),
			note.Version, createdAt, updatedAt); err != nil {
			return fmt.Errorf("restore note %d: %w", note.ID, err)
		}
		if err := replaceNoteLinks(tx, note.ID, note.Content); err != nil {
			return err
		}
		if err := syncNoteMetadata(tx, note.ID, note.Content, note.Tags); err != nil {
			return err
		}
	}
	return nil
}

func insertRestoredAttachments(tx *sql.Tx, attachments []backupAttachment) error {
	for index, attachment := range attachments {
		if index > 0 && index%1000 == 0 {
			log.Printf("restore: inserted %d of %d attachments", index, len(attachments))
		}
		createdAt := strings.TrimSpace(attachment.CreatedAt)
		if _, err := tx.Exec(`INSERT INTO attachments(id, note_id, filename, storage_name, media_type, size, created_at)
			VALUES (?, ?, ?, ?, ?, ?, COALESCE(NULLIF(?, ''), datetime('now')))`,
			attachment.ID, attachment.NoteID, attachment.Filename, attachment.StorageName,
			attachment.MediaType, attachment.Size, createdAt); err != nil {
			return fmt.Errorf("restore attachment %d: %w", attachment.ID, err)
		}
	}
	return nil
}

func (a *App) handleBackup(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.backupMu.Lock()
		defer a.backupMu.Unlock()
		temp, err := os.CreateTemp("", "invariante-backup-*.zip")
		if err != nil {
			log.Printf("create backup: %v", err)
			http.Error(w, "failed to create backup", http.StatusInternalServerError)
			return
		}
		tempName := temp.Name()
		defer os.Remove(tempName)
		if err := a.ExportBackup(temp); err != nil {
			temp.Close()
			log.Printf("export backup: %v", err)
			http.Error(w, "failed to create backup", http.StatusInternalServerError)
			return
		}
		if _, err := temp.Seek(0, io.SeekStart); err != nil {
			temp.Close()
			log.Printf("rewind backup: %v", err)
			http.Error(w, "failed to create backup", http.StatusInternalServerError)
			return
		}
		defer temp.Close()
		info, err := temp.Stat()
		if err != nil {
			log.Printf("stat backup: %v", err)
			http.Error(w, "failed to create backup", http.StatusInternalServerError)
			return
		}
		filename := "ton618-" + time.Now().UTC().Format("20060102-150405") + ".zip"
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
		http.ServeContent(w, r, filename, info.ModTime(), temp)
	case http.MethodPost:
		a.backupMu.Lock()
		defer a.backupMu.Unlock()
		// Spool the upload to a file next to the data so the archive is not
		// kept in memory (it can reach 512 MiB). zip.NewReader only needs an
		// io.ReaderAt, so the restore can read it back with normal seeks.
		temp, err := os.CreateTemp(filepath.Dir(a.attachmentsDir), ".restore-upload-*")
		if err != nil {
			log.Printf("create restore upload: %v", err)
			http.Error(w, "failed to read backup archive", http.StatusInternalServerError)
			return
		}
		tempName := temp.Name()
		defer os.Remove(tempName)
		defer temp.Close()
		size, err := io.Copy(temp, http.MaxBytesReader(w, r.Body, maxBackupUpload))
		if err != nil {
			var maxBytesError *http.MaxBytesError
			if errors.As(err, &maxBytesError) {
				http.Error(w, "backup archive is too large", http.StatusRequestEntityTooLarge)
			} else {
				http.Error(w, "failed to read backup archive", http.StatusBadRequest)
			}
			return
		}
		notes, attachments, err := a.RestoreBackupReader(temp, size)
		if errors.Is(err, errInvalidBackup) {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err != nil {
			log.Printf("restore backup: %v", err)
			http.Error(w, "failed to restore backup", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]int{"notes": notes, "attachments": attachments})
	default:
		methodNotAllowed(w)
	}
}
