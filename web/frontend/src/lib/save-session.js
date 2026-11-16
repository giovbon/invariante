import { ensureFrontmatterTags, extractMarkdownOutline } from './markdown-editor.js';
import { draftsEqual, hidesFromExplorer, tagListsEqual } from './draft-state.js';

// Autosave, conflict handling and the draft lifecycle. Navigation (showEditor,
// openNote) is injected so this module stays focused on persistence.
export function createSaveSession({
    state,
    elements,
    requestJSON,
    showMessage,
    updatePreview,
    showEditor,
    loadAttachments,
    loadFolders,
    loadNotes,
    loadTags,
    loadFolderNotes,
    tasksPanel,
    tableView,
    sidePanels,
    updateEditorBreadcrumb,
    syncMarkdownHighlight,
    getMarkdownEditor,
    resetEditorViewState
}) {
async function refreshOpenNoteAfterMove() {
    if (state.view !== 'editor' || state.noteID === null || isDraftDirty()) return;
    const id = state.noteID;
    try {
        const note = await requestJSON(`/api/notes/${id}`);
        if (state.view !== 'editor' || state.noteID !== id || isDraftDirty()) return;
        state.noteFolder = note.folder;
        state.noteVersion = note.version ?? state.noteVersion;
        state.savedTags = [...(note.tags || [])];
        const content = ensureFrontmatterTags(note.content, note.tags || []);
        if (content !== elements.noteContent.value) {
            elements.noteContent.value = content;
            state.savedDraft = getDraft();
            getMarkdownEditor().setValue(content, { silent: true });
            syncMarkdownHighlight();
            resetEditorViewState();
            state.outline = extractMarkdownOutline(content);
            sidePanels.updateOutlineCount();
            updatePreview();
        }
        state.savedDraft = getDraft();
        updateEditorBreadcrumb();
        void sidePanels.loadBacklinks(id);
    } catch (error) {
        // The move itself succeeded; keep the local editor state on failure.
    }
}

function getDraft() {
    return {
        title: elements.noteTitle.value,
        folder: state.noteFolder,
        content: elements.noteContent.value
    };
}

function isDraftDirty(draft = getDraft()) {
    return !draftsEqual(draft, state.savedDraft);
}

function scheduleSave() {
    if (state.view !== 'editor') return;
    if (!isDraftDirty()) {
        setSaveStatus(state.noteID ? 'Salvo' : 'Rascunho', '');
        return;
    }
    setSaveStatus(state.savePromise ? 'Salvando…' : 'Alterações pendentes', 'pending');
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => void persistDraft(), 650);
}

async function persistDraft() {
    if (state.savePromise) {
        await state.savePromise;
        return isDraftDirty() ? persistDraft() : true;
    }
    const draft = getDraft();
    if (!isDraftDirty(draft)) return true;
    const note = {
        title: draft.title.trim(),
        folder: draft.folder,
        content: draft.content
    };
    if (!note.title) {
        setSaveStatus('Informe um título para salvar', 'error');
        return false;
    }
    const id = state.noteID;
    if (id !== null) note.version = state.noteVersion;
    const endpoint = id === null ? '/api/notes' : `/api/notes/${id}`;
    const method = id === null ? 'POST' : 'PUT';
    const previousDraft = state.savedDraft;
    const previousTags = state.savedTags;
    setSaveStatus('Salvando…', 'pending');
    const job = (async () => {
        try {
            let saved;
            try {
                saved = await requestJSON(endpoint, { method, body: JSON.stringify(note) });
            } catch (error) {
                if (error.status !== 409 || !error.body?.note || id === null) throw error;
                const reload = window.confirm(
                    'Esta nota foi alterada em outra aba.\n\n' +
                    'OK: recarregar a versão mais recente e descartar suas mudanças.\n' +
                    'Cancelar: manter suas mudanças e sobrescrever a versão mais recente.'
                );
                if (reload) {
                    showEditor(error.body.note);
                    setSaveStatus('Versão mais recente carregada', 'saved');
                    return false;
                }
                state.noteVersion = error.body.note.version;
                note.version = state.noteVersion;
                saved = await requestJSON(endpoint, { method, body: JSON.stringify(note) });
            }
            const metadataChanged = id === null || !previousDraft ||
                previousDraft.title !== draft.title || previousDraft.folder !== draft.folder;
            const contentChanged = id === null || !previousDraft ||
                previousDraft.content !== draft.content;
            const tagsChanged = !tagListsEqual(saved.tags, previousTags);
            const explorerVisibilityChanged = contentChanged &&
                hidesFromExplorer(draft.content) !== hidesFromExplorer(previousDraft?.content || '');
            state.noteVersion = saved.version ?? state.noteVersion;
            if (metadataChanged || contentChanged) {
                state.graphData = null;
                tableView.invalidate();
            }
            if (id === null) {
                state.noteID = saved.id;
                updatePreview();
                elements.deleteCurrentNote.hidden = false;
                void loadAttachments(saved.id);
                const current = history.state || {};
                history.replaceState({ ...current, view: 'editor', noteId: saved.id, list: state.listState }, '', `?note=${saved.id}`);
            }
            state.savedTags = Array.isArray(saved.tags) ? [...saved.tags] : [];
            if (draftsEqual(getDraft(), draft)) {
                elements.noteTitle.value = saved.title;
                state.noteFolder = saved.folder;
                state.savedDraft = getDraft();
                updateEditorBreadcrumb();
            } else {
                state.savedDraft = draft;
            }
            updateEditorBreadcrumb();
            setSaveStatus('Salvo automaticamente', 'saved');
            if (metadataChanged) {
                state.folderNotesGeneration++;
                state.folderNotes.clear();
                void loadFolders();
                if (state.view !== 'editor') void loadNotes();
                void loadFolderNotes('', false);
            } else if (explorerVisibilityChanged) {
                state.folderNotesGeneration++;
                state.folderNotes.clear();
                void loadFolderNotes('', false);
            }
            if (contentChanged) {
                if (state.noteID !== null) void sidePanels.loadBacklinks(state.noteID);
                tasksPanel.scheduleRefresh();
            }
            if (tagsChanged) void loadTags();
            return true;
        } catch (error) {
            setSaveStatus(`Falha ao salvar: ${error.message}`, 'error');
            return false;
        }
    })();
    state.savePromise = job;
    const result = await job;
    state.savePromise = null;
    if (result && isDraftDirty()) {
        window.clearTimeout(state.saveTimer);
        state.saveTimer = window.setTimeout(() => void persistDraft(), 0);
    }
    return result;
}

async function flushSave() {
    window.clearTimeout(state.saveTimer);
    while (state.savePromise) {
        await state.savePromise;
        if (state.savePromise) continue;
    }
    if (!isDraftDirty()) return true;
    if (!elements.noteTitle.value.trim()) {
        setSaveStatus('Informe um título antes de sair', 'error');
        elements.noteTitle.focus();
        return false;
    }
    const success = await persistDraft();
    if (!success) return false;
    if (isDraftDirty()) return flushSave();
    return true;
}

function setSaveStatus(message, stateName) {
    elements.saveStatus.textContent = message;
    elements.saveStatus.dataset.state = stateName;
    elements.saveStatus.className = `save-status${stateName ? ` is-${stateName}` : ''}`;
}



    return {
        refreshAfterMove: refreshOpenNoteAfterMove,
        getDraft,
        isDirty: isDraftDirty,
        schedule: scheduleSave,
        persist: persistDraft,
        flush: flushSave,
        setStatus: setSaveStatus
    };
}
