import { extractMarkdownOutline } from './markdown-editor.js';

// Backlinks and outline share the side panel but not the application state.
// Keeping them together gives the main module a small, explicit API while the
// callbacks for navigation/openNote stay in main.js.
export function createSidePanels({ state, elements, requestJSON, showMessage, skeletonLines }) {
async function loadBacklinks(noteID) {
    const requestID = ++state.backlinksRequestID;
    state.backlinks = null;
    state.backlinksError = '';
    updateBacklinksCount();
    if (elements.panel.dataset.panel === 'backlinks') renderBacklinksPanel();
    try {
        const backlinks = await requestJSON(`/api/notes/${noteID}/backlinks`);
        if (requestID !== state.backlinksRequestID || state.noteID !== noteID) return;
        if (!Array.isArray(backlinks)) throw new Error('resposta de backlinks inválida');
        state.backlinks = backlinks;
        state.backlinksError = '';
        updateBacklinksCount();
        if (elements.panel.dataset.panel === 'backlinks') renderBacklinksPanel();
    } catch (error) {
        if (requestID !== state.backlinksRequestID || state.noteID !== noteID) return;
        state.backlinks = null;
        state.backlinksError = error.message;
        updateBacklinksCount();
        if (elements.panel.dataset.panel === 'backlinks') renderBacklinksPanel('Não foi possível carregar os backlinks.');
        showMessage(`Não foi possível carregar os backlinks: ${error.message}`, 'error');
    }
}

function updateBacklinksCount() {
    const count = state.view === 'editor' && state.noteID !== null ? state.backlinks?.length || 0 : 0;
    elements.backlinksCount.textContent = count > 9 ? '9+' : String(count);
    elements.backlinksCount.hidden = count === 0;
    const label = count ? `Backlinks (${count})` : 'Abrir backlinks';
    document.querySelector('#backlinksButton').title = label;
    document.querySelector('#backlinksButton').setAttribute('aria-label', label);
}

function resetBacklinks() {
    state.backlinks = null;
    state.backlinksError = '';
    state.backlinksRequestID++;
    updateBacklinksCount();
    if (elements.panel.dataset.panel === 'backlinks') renderBacklinksPanel();
}

function renderBacklinksPanel(errorMessage = '') {
    elements.panelContent.replaceChildren();
    if (state.view !== 'editor' || state.noteID === null) {
        const empty = document.createElement('div');
        empty.className = 'backlinks-panel-empty';
        const message = document.createElement('p');
        message.textContent = 'Abra uma nota para ver os backlinks.';
        empty.append(message);
        elements.panelContent.append(empty);
        return;
    }
    if (state.backlinksError || errorMessage) {
        const error = document.createElement('div');
        error.className = 'backlinks-panel-empty';
        const message = document.createElement('p');
        message.textContent = errorMessage || state.backlinksError;
        error.append(message);
        elements.panelContent.append(error);
        return;
    }
    if (state.backlinks === null) {
        const loading = document.createElement('div');
        loading.className = 'backlinks-panel-empty';
        loading.setAttribute('aria-label', 'Carregando backlinks');
        loading.append(...skeletonLines(3));
        elements.panelContent.append(loading);
        return;
    }
    if (state.backlinks.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'backlinks-panel-empty';
        const message = document.createElement('p');
        message.textContent = 'Nenhuma nota aponta para esta nota.';
        empty.append(message);
        const hint = document.createElement('small');
        hint.textContent = 'Links [[wikilink]] e links Markdown são encontrados automaticamente.';
        empty.append(hint);
        elements.panelContent.append(empty);
        return;
    }
    for (const note of state.backlinks) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'backlink-item';
        item.dataset.backlinkNote = String(note.id);
        item.title = note.folder ? `${note.folder}/${note.title}` : note.title;
        const title = document.createElement('span');
        title.className = 'backlink-item-title';
        title.textContent = note.title;
        item.append(title);
        if (note.folder) {
            const folder = document.createElement('span');
            folder.className = 'backlink-item-folder';
            folder.textContent = note.folder;
            item.append(folder);
        }
        if (note.preview) {
            const preview = document.createElement('span');
            preview.className = 'backlink-item-preview';
            preview.textContent = note.preview;
            item.append(preview);
        }
        elements.panelContent.append(item);
    }
}

function refreshOutline() {
    state.outline = extractMarkdownOutline(elements.noteContent.value);
    updateOutlineCount();
    if (elements.panel.dataset.panel === 'outline') renderOutlinePanel();
}

function updateOutlineCount() {
    const count = state.view === 'editor' ? state.outline.length : 0;
    elements.outlineCount.textContent = count > 9 ? '9+' : String(count);
    elements.outlineCount.hidden = count === 0;
    const label = count ? `Sumário (${count})` : 'Abrir sumário da nota';
    document.querySelector('#outlineButton').title = label;
    document.querySelector('#outlineButton').setAttribute('aria-label', label);
}

function resetOutline() {
    state.outline = [];
    updateOutlineCount();
    if (elements.panel.dataset.panel === 'outline') renderOutlinePanel();
}

function renderOutlinePanel() {
    elements.panelContent.replaceChildren();
    if (state.view !== 'editor') {
        const empty = document.createElement('div');
        empty.className = 'outline-panel-empty';
        const message = document.createElement('p');
        message.textContent = 'Abra uma nota para ver o sumário.';
        empty.append(message);
        elements.panelContent.append(empty);
        return;
    }
    if (state.outline.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'outline-panel-empty';
        const message = document.createElement('p');
        message.textContent = 'Esta nota não tem títulos.';
        empty.append(message);
        elements.panelContent.append(empty);
        return;
    }
    for (const heading of state.outline) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'outline-item';
        item.dataset.outlineLine = String(heading.line);
        item.dataset.level = String(heading.level);
        item.style.paddingLeft = `${10 + (heading.level - 1) * 12}px`;
        item.textContent = heading.text;
        item.title = heading.text;
        elements.panelContent.append(item);
    }
}



    return {
        loadBacklinks,
        resetBacklinks,
        renderBacklinks: renderBacklinksPanel,
        updateBacklinksCount,
        refreshOutline,
        resetOutline,
        renderOutline: renderOutlinePanel,
        updateOutlineCount
    };
}
