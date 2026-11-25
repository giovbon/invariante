import { iconElement } from './icons.js';
import { skeletonLines } from './note-list.js';

// Folder explorer: rendering, selection, drag and drop, inline rename/delete
// and the SSE-driven refresh. Navigation and note persistence stay in main.js
// and are injected as callbacks.
export function createFolderTree(context) {
    const {
        state,
        elements,
        requestJSON,
        showMessage,
        loadFolders,
        loadFolderNotes,
        loadTree,
        loadNotes,
        flushSave,
        persistDraft,
        updateEditorBreadcrumb,
        closePanel,
        closeGraphView,
        captureListState,
        updateListHistory,
        isTypingTarget,
        deleteSelectedTreeNotes,
        getDraft,
        refreshOpenNoteAfterMove,
        tableView,
        sidePanels
    } = context;

    let changeEvents = null;
    let folderTreeRefreshTimer = null;
    let folderTreeRefreshRunning = false;
    let folderTreeRefreshQueued = false;
    let folderTreeRevision = 0;
    let pendingTreeRevision = 0;

    // Icons and row actions repeat for every folder and note. Cloning them from
    // cached <template> nodes avoids re-parsing the same SVG markup hundreds
    // of times when the explorer renders a large tree.
    const templateCache = new Map();

    function cloneTemplate(key, build) {
        let template = templateCache.get(key);
        if (!template) {
            template = document.createElement('template');
            template.content.append(build());
            templateCache.set(key, template);
        }
        return template.content.firstElementChild.cloneNode(true);
    }

    const actionIcons = {
        plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
        notePlus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.75h8l4 4v12.5H6z"/><path d="M14 3.75v4h4M12 11v6m-3-3h6"/></svg>',
        folderPlus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M16 11v6m-3-3h6"/></svg>',
        rename: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="m13.5 6.5 3 3"/></svg>',
        remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>'
    };

    function actionButton({ className, icon, dataset, label, title }) {
        const button = cloneTemplate(`action:${className}:${icon}`, () => {
            const element = document.createElement('button');
            element.type = 'button';
            element.className = className;
            element.innerHTML = actionIcons[icon];
            return element;
        });
        Object.assign(button.dataset, dataset);
        button.setAttribute('aria-label', label);
        button.title = title;
        return button;
    }

function visibleTreeNoteIDs() {
    return [...elements.panelContent.querySelectorAll('[data-tree-note]')]
        .map(button => Number(button.dataset.treeNote));
}

function selectedTreeNoteIDs() {
    return visibleTreeNoteIDs().filter(id => state.treeSelection.has(id));
}

function updateTreeSelection() {
    elements.panelContent.querySelectorAll('[data-tree-note]').forEach(button => {
        const selected = state.treeSelection.has(Number(button.dataset.treeNote));
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-pressed', String(selected));
    });
    // Folder rows (including the “Todas as notas” root) are selected through
    // state.folder. Toggling the class avoids rebuilding the tree just to move
    // the highlight after a click.
    elements.panelContent.querySelectorAll('[data-folder]').forEach(button => {
        button.classList.toggle('is-selected', button.dataset.folder === state.folder);
    });
}

function selectTreeNote(noteID, mode = 'single') {
    if (mode === 'range' && state.treeSelectionAnchor !== null) {
        const ids = visibleTreeNoteIDs();
        const anchorIndex = ids.indexOf(state.treeSelectionAnchor);
        const targetIndex = ids.indexOf(noteID);
        if (anchorIndex >= 0 && targetIndex >= 0) {
            const start = Math.min(anchorIndex, targetIndex);
            const end = Math.max(anchorIndex, targetIndex);
            state.treeSelection = new Set(ids.slice(start, end + 1));
            updateTreeSelection();
            return;
        }
    }
    if (mode === 'toggle') {
        if (state.treeSelection.has(noteID)) state.treeSelection.delete(noteID);
        else state.treeSelection.add(noteID);
        state.treeSelectionAnchor = noteID;
        updateTreeSelection();
        return;
    }
    state.treeSelection = new Set([noteID]);
    state.treeSelectionAnchor = noteID;
    updateTreeSelection();
}

function clearTreeSelection() {
    state.treeSelection.clear();
    state.treeSelectionAnchor = null;
    updateTreeSelection();
}

function renderFolderPanel() {
    const scrollTop = elements.panel.scrollTop;
    const rootRow = document.createElement('div');
    rootRow.className = 'tree-root-row';
    const all = document.createElement('button');
    all.type = 'button';
    all.className = `tree-root${state.folder === '' ? ' is-selected' : ''}`;
    all.dataset.folder = '';
    all.textContent = 'Todas as notas';
    const actions = document.createElement('div');
    actions.className = 'tree-root-actions';
    actions.append(
        actionButton({
            className: 'icon-button tree-root-action',
            icon: 'plus',
            dataset: { createNote: '' },
            label: 'Criar nota',
            title: 'Criar nota'
        }),
        actionButton({
            className: 'icon-button tree-root-action',
            icon: 'folderPlus',
            dataset: { createFolder: '' },
            label: 'Criar pasta',
            title: 'Criar pasta'
        })
    );
    rootRow.append(all, actions);
    const root = document.createElement('section');
    root.className = 'tree-root-group';
    root.dataset.dropFolder = '';
    root.dataset.treeRoot = 'true';
    const rootHeader = document.createElement('div');
    rootHeader.className = 'tree-row';
    const rootExpand = makeExpandButton('', 'Notas sem pasta');
    const rootLabel = document.createElement('span');
    rootLabel.className = 'tree-group-label';
    rootLabel.textContent = 'Sem pasta';
    rootHeader.append(rootExpand, rootLabel);
    root.append(rootHeader);
    if (state.expandedFolders.has('')) root.append(renderDirectNotes('', true));
    const tree = document.createElement('ul');
    tree.className = 'folder-tree root-folder-tree';
    for (const folder of state.folders) tree.append(buildFolderNode(folder));
    elements.panelContent.replaceChildren(rootRow, root, tree);
    elements.panel.scrollTop = scrollTop;
}

function makeExpandButton(folderPath, label) {
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'tree-expand';
    expand.dataset.toggleFolder = folderPath;
    const expanded = state.expandedFolders.has(folderPath);
    expand.setAttribute('aria-label', `${expanded ? 'Recolher' : 'Expandir'} ${label}`);
    expand.setAttribute('aria-expanded', String(expanded));
    expand.textContent = '›';
    return expand;
}

function createTreeDocumentIcon(className) {
    return cloneTemplate(`icon:note:${className}`, () => iconElement('note', className, 'tree-document'));
}

function createTreeFolderIcon(className) {
    return cloneTemplate(`icon:folder:${className}`, () => iconElement('folder', className, 'tree-folder'));
}

function buildFolderNode(folder) {
    const item = document.createElement('li');
    item.className = 'tree-node';
    item.dataset.treeFolderPath = folder.path;
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.append(makeExpandButton(folder.path, folder.name));
    const select = document.createElement('button');
    select.type = 'button';
    select.className = `tree-folder${state.folder === folder.path ? ' is-selected' : ''}`;
    select.dataset.folder = folder.path;
    select.dataset.dragFolder = folder.path;
    select.draggable = true;
    const label = document.createElement('span');
    label.className = 'tree-folder-label';
    label.textContent = folder.name;
    select.append(createTreeFolderIcon('tree-folder-icon'), label);
    row.dataset.dropFolder = folder.path;
    row.append(select);
    const actions = document.createElement('div');
    actions.className = 'tree-folder-actions';
    actions.append(
        actionButton({
            className: 'icon-button tree-folder-action',
            icon: 'rename',
            dataset: { renameFolder: folder.path },
            label: `Editar título de ${folder.name}`,
            title: 'Editar título'
        }),
        actionButton({
            className: 'icon-button tree-folder-action',
            icon: 'notePlus',
            dataset: { createNoteFolder: folder.path },
            label: `Criar nota em ${folder.path}`,
            title: `Criar nota em ${folder.path}`
        }),
        actionButton({
            className: 'icon-button tree-folder-action',
            icon: 'folderPlus',
            dataset: { createSubfolder: folder.path },
            label: `Criar subpasta em ${folder.path}`,
            title: `Criar subpasta em ${folder.path}`
        }),
        actionButton({
            className: 'icon-button tree-folder-action tree-folder-delete',
            icon: 'remove',
            dataset: { deleteFolder: folder.path },
            label: `Excluir pasta ${folder.name}`,
            title: 'Excluir pasta'
        })
    );
    row.append(actions);
    item.append(row);
    if (state.expandedFolders.has(folder.path)) item.append(buildFolderContents(folder));
    return item;
}

function buildFolderContents(folder) {
    const contents = document.createElement('ul');
    contents.className = 'folder-tree';
    contents.dataset.folderContents = folder.path;
    const directNotes = renderDirectNotes(folder.path, false);
    while (directNotes.firstChild) contents.append(directNotes.firstChild);
    for (const child of folder.children || []) contents.append(buildFolderNode(child));
    return contents;
}

function findFolder(path) {
    function search(folders) {
        for (const folder of folders) {
            if (folder.path === path) return folder;
            const match = search(folder.children || []);
            if (match) return match;
        }
        return null;
    }
    return search(state.folders);
}

function findFolderItem(path) {
    return [...elements.panelContent.querySelectorAll('[data-tree-folder-path]')]
        .find(item => item.dataset.treeFolderPath === path) || null;
}

function directChild(element, selector) {
    return [...element.children].find(child => child.matches(selector)) || null;
}

function applyToggleState(toggle, expanded, label) {
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', `${expanded ? 'Recolher' : 'Expandir'} ${label}`);
}

// Expand or collapse one node in place. Rebuilding only that subtree keeps the
// rest of a large explorer intact instead of recreating every folder and note
// on each click.
function setExpanded(path, expanded) {
    if (path === '') {
        const root = elements.panelContent.querySelector('[data-tree-root]');
        if (!root) return false;
        const toggle = root.querySelector('.tree-row [data-toggle-folder]');
        if (!toggle) return false;
        const current = root.querySelector('[data-root-notes]');
        if (expanded && !current) root.append(renderDirectNotes('', true));
        else if (!expanded && current) current.remove();
        applyToggleState(toggle, expanded, 'Notas sem pasta');
        return true;
    }
    const item = findFolderItem(path);
    const folder = item && findFolder(path);
    if (!item || !folder) return false;
    const row = directChild(item, '.tree-row');
    const toggle = row && row.querySelector('[data-toggle-folder]');
    if (!toggle) return false;
    const current = directChild(item, 'ul[data-folder-contents]');
    if (expanded && !current) item.append(buildFolderContents(folder));
    else if (!expanded && current) current.remove();
    applyToggleState(toggle, expanded, folder.name);
    return true;
}

// Replace the notes of one expanded folder after a page loads or grows.
function refreshFolder(path) {
    if (!state.expandedFolders.has(path)) return false;
    if (path === '') {
        const root = elements.panelContent.querySelector('[data-tree-root]');
        if (!root) return false;
        const notes = renderDirectNotes('', true);
        const current = root.querySelector('[data-root-notes]');
        if (current) current.replaceWith(notes);
        else root.append(notes);
        return true;
    }
    const folder = findFolder(path);
    const item = findFolderItem(path);
    if (!folder || !item) return false;
    const contents = buildFolderContents(folder);
    const current = directChild(item, 'ul[data-folder-contents]');
    if (current) current.replaceWith(contents);
    else item.append(contents);
    return true;
}

function renderDirectNotes(folder, root) {
    const list = document.createElement(root ? 'div' : 'ul');
    list.className = root ? 'tree-note-list root-note-list' : 'folder-tree-note-list';
    if (root) list.dataset.rootNotes = 'true';
    const page = state.folderNotes.get(folder);
    if (!page) {
        void loadFolderNotes(folder);
        const loading = document.createElement(root ? 'p' : 'li');
        loading.className = 'tree-loading';
        loading.setAttribute('aria-label', 'Carregando notas');
        loading.append(...skeletonLines(2));
        list.append(loading);
        return list;
    }
    for (const note of page.items) {
        const item = document.createElement(root ? 'div' : 'li');
        item.className = 'tree-note-item';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tree-note';
        button.dataset.treeNote = String(note.id);
        button.dataset.dragNote = String(note.id);
        button.draggable = true;
        button.title = note.title;
        if (state.treeSelection.has(note.id)) button.classList.add('is-selected');
        button.setAttribute('aria-pressed', String(state.treeSelection.has(note.id)));
        const label = document.createElement('span');
        label.className = 'tree-note-label';
        label.textContent = note.title;
        button.append(createTreeDocumentIcon('tree-note-icon'), label);
        const actions = document.createElement('div');
        actions.className = 'tree-note-actions';
        actions.append(
            actionButton({
                className: 'icon-button tree-note-action',
                icon: 'rename',
                dataset: { renameNote: String(note.id) },
                label: `Editar título de ${note.title}`,
                title: 'Editar título'
            }),
            actionButton({
                className: 'icon-button tree-note-action tree-note-delete',
                icon: 'remove',
                dataset: { deleteTreeNote: String(note.id) },
                label: `Excluir ${note.title}`,
                title: 'Excluir nota'
            })
        );
        item.append(button, actions);
        list.append(item);
    }
    if (page.items.length < page.total) {
        const item = document.createElement(root ? 'div' : 'li');
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'tree-more';
        more.dataset.moreFolder = folder;
        more.textContent = 'Carregar mais notas';
        item.append(more);
        list.append(item);
    }
    return list;
}

function handlePanelKeydown(event) {
    if (isTypingTarget(event.target)) return;
    if (event.key === 'Escape' && state.treeSelection.size) {
        event.preventDefault();
        clearTreeSelection();
        return;
    }
    if ((event.key !== 'Delete' && event.key !== 'Backspace') || !state.treeSelection.size) return;
    event.preventDefault();
    void deleteSelectedTreeNotes();
}

function handleSidebarDragStart(event) {
    const note = event.target.closest('[data-drag-note]');
    const folder = event.target.closest('[data-drag-folder]');
    const source = note || folder;
    if (!source || !event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    if (note) {
        const noteID = Number(note.dataset.dragNote);
        // Dragging a note that is not part of the current selection starts a
        // fresh single-note selection, like a file explorer.
        if (!state.treeSelection.has(noteID) || state.treeSelection.size === 1) {
            selectTreeNote(noteID);
        }
        const noteIDs = selectedTreeNoteIDs();
        if (noteIDs.length > 1) {
            event.dataTransfer.setData('application/x-pkm-notes', JSON.stringify(noteIDs));
            event.dataTransfer.setData('text/plain', `${noteIDs.length} notas`);
            for (const button of elements.panelContent.querySelectorAll('[data-drag-note]')) {
                if (state.treeSelection.has(Number(button.dataset.dragNote))) {
                    button.classList.add('is-dragging');
                }
            }
            return;
        }
        event.dataTransfer.setData('application/x-pkm-note', String(noteID));
        source.classList.add('is-dragging');
        return;
    }
    event.dataTransfer.setData('application/x-pkm-folder', folder.dataset.dragFolder);
    source.classList.add('is-dragging');
}

function handleSidebarDragOver(event) {
    const target = event.target.closest('[data-drop-folder]');
    if (!target || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    target.classList.add('is-drop-target');
}

function handleSidebarDragLeave(event) {
    const target = event.target.closest('[data-drop-folder]');
    if (target && !target.contains(event.relatedTarget)) target.classList.remove('is-drop-target');
}

function clearDropTargets() {
    elements.panelContent.querySelectorAll('.is-drop-target, .is-dragging').forEach(element => {
        element.classList.remove('is-drop-target', 'is-dragging');
    });
}

async function handleSidebarDrop(event) {
    const target = event.target.closest('[data-drop-folder]');
    if (!target || !event.dataTransfer) return;
    event.preventDefault();
    const destinationParent = target.dataset.dropFolder;
    const notesPayload = event.dataTransfer.getData('application/x-pkm-notes');
    const noteID = event.dataTransfer.getData('application/x-pkm-note');
    const sourceFolder = event.dataTransfer.getData('application/x-pkm-folder');
    clearDropTargets();
    if (notesPayload) {
        let noteIDs = [];
        try {
            const parsed = JSON.parse(notesPayload);
            if (Array.isArray(parsed)) noteIDs = parsed.filter(id => Number.isInteger(id));
        } catch {
            noteIDs = [];
        }
        if (noteIDs.length) await moveNotesToFolder(noteIDs, destinationParent);
    } else if (noteID) {
        await moveNoteToFolder(Number(noteID), destinationParent);
    } else if (sourceFolder) {
        await moveFolderToParent(sourceFolder, destinationParent);
    }
}

async function moveNoteToFolder(noteID, folder) {
    try {
        if (state.view === 'editor' && !(await flushSave())) return;
        await requestJSON(`/api/notes/${noteID}/folder`, {
            method: 'PATCH',
            body: JSON.stringify({ folder })
        });
        state.graphData = null;
        tableView.invalidate();
        if (state.view === 'editor' && state.noteID === noteID) {
            state.noteFolder = folder;
            state.savedDraft = getDraft();
            updateEditorBreadcrumb();
        }
        await refreshOpenNoteAfterMove();
        showMessage('Nota movida.', 'success');
        clearTreeSelection();
        await refreshFolderTree();
        await loadNotes();
    } catch (error) {
        showMessage(`Não foi possível mover a nota: ${error.message}`, 'error');
    }
}

async function moveNotesToFolder(noteIDs, folder) {
    const ids = [...new Set(noteIDs)].filter(id => Number.isInteger(id));
    if (!ids.length) return;
    if (ids.length === 1) {
        await moveNoteToFolder(ids[0], folder);
        return;
    }
    try {
        if (state.view === 'editor' && !(await flushSave())) return;
        const results = await Promise.allSettled(ids.map(id => requestJSON(`/api/notes/${id}/folder`, {
            method: 'PATCH',
            body: JSON.stringify({ folder })
        })));
        const moved = ids.filter((_, index) => results[index].status === 'fulfilled');
        const failed = ids.length - moved.length;
        state.graphData = null;
        tableView.invalidate();
        if (state.view === 'editor' && moved.includes(state.noteID)) {
            state.noteFolder = folder;
            state.savedDraft = getDraft();
            updateEditorBreadcrumb();
        }
        await refreshOpenNoteAfterMove();
        const message = moved.length === 1 ? 'Nota movida.' : `${moved.length} notas movidas.`;
        showMessage(failed ? `${message} ${failed} falharam.` : message, failed ? 'error' : 'success');
        clearTreeSelection();
        await refreshFolderTree();
        await loadNotes();
    } catch (error) {
        showMessage(`Não foi possível mover as notas: ${error.message}`, 'error');
    }
}

async function moveFolderToParent(source, target) {
    try {
        if (state.view === 'editor' && !(await flushSave())) return;
        const result = await requestJSON('/api/folders/move', {
            method: 'POST',
            body: JSON.stringify({ source, target })
        });
        state.graphData = null;
        tableView.invalidate();
        state.folder = rebaseFolderPath(state.folder, source, result.folder);
        if (state.listState) {
            state.listState.folder = rebaseFolderPath(state.listState.folder || '', source, result.folder);
        }
        if (state.view === 'editor' && (state.noteFolder === source || state.noteFolder.startsWith(`${source}/`))) {
            state.noteFolder = rebaseFolderPath(state.noteFolder, source, result.folder);
            state.savedDraft = getDraft();
            updateEditorBreadcrumb();
            const current = history.state || {};
            history.replaceState({ ...current, list: state.listState }, '', location.href);
        }
        await refreshOpenNoteAfterMove();
        showMessage('Pasta movida.', 'success');
        updateListHistory();
        await refreshFolderTree();
        await loadNotes();
    } catch (error) {
        showMessage(`Não foi possível mover a pasta: ${error.message}`, 'error');
    }
}

function rebaseFolderPath(folder, source, destination) {
    if (folder === source) return destination;
    return folder.startsWith(`${source}/`) ? destination + folder.slice(source.length) : folder;
}

function setupChangeEvents() {
    if (changeEvents || !('EventSource' in window)) return;
    changeEvents = new EventSource('/api/events');
    changeEvents.addEventListener('tree', event => {
        let revision = Number.POSITIVE_INFINITY;
        try {
            const parsed = JSON.parse(event.data);
            if (Number.isFinite(parsed?.revision) && parsed.revision > 0) revision = parsed.revision;
        } catch {
            // Older servers may omit the payload; a refresh is still harmless.
        }
        pendingTreeRevision = Math.max(pendingTreeRevision, revision);
        scheduleFolderTreeRefresh();
    });
}

function scheduleFolderTreeRefresh() {
    window.clearTimeout(folderTreeRefreshTimer);
    folderTreeRefreshTimer = window.setTimeout(() => {
        folderTreeRefreshTimer = null;
        // A local mutation already refreshed the tree after the event was
        // emitted, so its echo would only cause a second render.
        if (pendingTreeRevision <= folderTreeRevision) return;
        void refreshFolderTreeFromEvent();
    }, 150);
}

async function refreshFolderTreeFromEvent() {
    if (folderTreeRefreshRunning) {
        folderTreeRefreshQueued = true;
        return;
    }
    folderTreeRefreshRunning = true;
    try {
        await refreshFolderTree();
    } catch (error) {
        showMessage(`Não foi possível atualizar as pastas: ${error.message}`, 'error');
    } finally {
        folderTreeRefreshRunning = false;
        if (folderTreeRefreshQueued) {
            folderTreeRefreshQueued = false;
            scheduleFolderTreeRefresh();
        }
    }
}

async function refreshFolderTree() {
    state.folderNotesGeneration++;
    // One request returns the folder tree and every expanded folder at once,
    // so the explorer renders a single time instead of once per response.
    if (typeof loadTree === 'function') {
        state.folderNotes.clear();
        await loadTree();
        return;
    }
    state.folderNotes.clear();
    await loadFolders();
    const folders = ['', ...state.expandedFolders].filter((folder, index, list) => list.indexOf(folder) === index);
    await Promise.all(folders.map(folder => loadFolderNotes(folder)));
}

async function renameNoteFromTree(noteID) {
    const isCurrent = state.view === 'editor' && state.noteID === noteID;
    if (isCurrent && !(await flushSave())) return;
    let note;
    try {
        note = isCurrent
            ? { title: elements.noteTitle.value, folder: state.noteFolder, content: elements.noteContent.value, version: state.noteVersion }
            : await requestJSON(`/api/notes/${noteID}`);
    } catch (error) {
        showMessage(`Não foi possível carregar a nota: ${error.message}`, 'error');
        return;
    }
    const value = window.prompt('Novo título da nota:', note.title);
    if (value === null) return;
    const title = value.trim();
    if (!title || title === note.title) return;
    try {
        if (isCurrent) {
            elements.noteTitle.value = title;
            if (!(await persistDraft())) return;
        } else {
            await requestJSON(`/api/notes/${noteID}`, {
                method: 'PUT',
                body: JSON.stringify({ ...note, title })
            });
            await refreshFolderTree();
            await loadNotes();
        }
        showMessage('Título da nota atualizado.', 'success');
    } catch (error) {
        showMessage(`Não foi possível renomear a nota: ${error.message}`, 'error');
    }
}

async function renameFolderFromTree(folder) {
    if (state.view === 'editor' && !(await flushSave())) return;
    const currentName = folder.split('/').pop();
    const value = window.prompt(`Novo nome da pasta “${currentName}”:`, currentName);
    if (value === null) return;
    const name = value.trim();
    if (!name || name === currentName) return;
    try {
        const result = await requestJSON('/api/folders/rename', {
            method: 'POST',
            body: JSON.stringify({ source: folder, name })
        });
        state.graphData = null;
        tableView.invalidate();
        state.folder = rebaseFolderPath(state.folder, folder, result.folder);
        state.expandedFolders = new Set(
            [...state.expandedFolders].map(path => rebaseFolderPath(path, folder, result.folder))
        );
        if (state.listState) {
            state.listState.folder = rebaseFolderPath(state.listState.folder || '', folder, result.folder);
        }
        if (state.view === 'editor' && (state.noteFolder === folder || state.noteFolder.startsWith(`${folder}/`))) {
            state.noteFolder = rebaseFolderPath(state.noteFolder, folder, result.folder);
            state.savedDraft = getDraft();
            updateEditorBreadcrumb();
            const current = history.state || {};
            history.replaceState({ ...current, list: state.listState }, '', location.href);
        }
        updateListHistory();
        await refreshFolderTree();
        await loadNotes();
        showMessage('Pasta renomeada.', 'success');
    } catch (error) {
        showMessage(`Não foi possível renomear a pasta: ${error.message}`, 'error');
    }
}

async function deleteFolderFromTree(folder) {
    const folderName = folder.split('/').pop();
    if (!window.confirm(
        `Excluir a pasta “${folderName}” e suas subpastas? As notas serão movidas para a raiz.`
    )) return;
    if (state.view === 'editor' && !(await flushSave())) return;
    try {
        await requestJSON('/api/folders/delete', {
            method: 'POST',
            body: JSON.stringify({ path: folder })
        });
        state.graphData = null;
        tableView.invalidate();
        if (state.folder === folder || state.folder.startsWith(`${folder}/`)) state.folder = '';
        if (state.listState &&
            (state.listState.folder === folder || state.listState.folder.startsWith(`${folder}/`))) {
            state.listState.folder = '';
        }
        state.expandedFolders = new Set(
            [...state.expandedFolders].filter(path => path !== folder && !path.startsWith(`${folder}/`))
        );
        updateListHistory();
        if (state.view === 'editor' && state.listState) {
            const current = history.state || {};
            history.replaceState({ ...current, list: state.listState }, '', location.href);
        }
        if (state.view === 'editor' &&
            (state.noteFolder === folder || state.noteFolder.startsWith(`${folder}/`))) {
            await refreshOpenNoteAfterMove();
        }
        await refreshFolderTree();
        await loadNotes();
        showMessage('Pasta excluída; as notas foram movidas para a raiz.', 'success');
    } catch (error) {
        showMessage(`Não foi possível excluir a pasta: ${error.message}`, 'error');
    }
}

async function createFolder(parent = '') {
    const name = window.prompt(parent
        ? `Nome da subpasta em “${parent}” (use / para criar níveis):`
        : 'Nome da pasta (use / para criar subpastas):');
    if (name === null) return;
    const folderName = name.trim();
    if (!folderName) {
        showMessage('Informe um nome para a pasta.', 'error');
        return;
    }
    const folder = parent ? `${parent}/${folderName}` : folderName;
    try {
        await requestJSON('/api/folders', {
            method: 'POST',
            body: JSON.stringify({ path: folder })
        });
        const parts = folder.split('/');
        for (let index = 1; index <= parts.length; index++) {
            state.expandedFolders.add(parts.slice(0, index).join('/'));
        }
        void refreshFolderTree();
        showMessage('Pasta criada.', 'success');
    } catch (error) {
        showMessage(`Não foi possível criar a pasta: ${error.message}`, 'error');
    }
}

async function selectFolder(folder) {
    if (state.view === 'editor' && !(await flushSave())) return;
    if (state.graphVisible) closeGraphView();
    if (state.view === 'editor') {
        history.pushState({ view: 'list', list: { ...captureListState(), folder, offset: 0 } }, '', location.pathname);
        state.view = 'list';
        state.noteID = null;
        sidePanels.resetBacklinks();
        sidePanels.resetOutline();
        document.body.classList.remove('is-editor-view');
        elements.editorView.hidden = true;
        elements.searchView.hidden = false;
        elements.newNote.hidden = false;
    }
    state.folder = folder;
    state.offset = 0;
    if (window.matchMedia('(max-width: 700px)').matches) closePanel();
    loadNotes();
    updateListHistory();
    if (elements.panel.dataset.panel === 'files') updateTreeSelection();
}

    return {
        render: renderFolderPanel,
        refresh: refreshFolderTree,
        setExpanded,
        refreshFolder,
        noteRevision(revision) {
            if (Number.isFinite(revision) && revision > folderTreeRevision) {
                folderTreeRevision = revision;
            }
        },
        setupChangeEvents,
        handleKeydown: handlePanelKeydown,
        handleDragStart: handleSidebarDragStart,
        handleDragOver: handleSidebarDragOver,
        handleDragLeave: handleSidebarDragLeave,
        handleDrop: event => void handleSidebarDrop(event),
        dragEnd: clearDropTargets,
        selectNote: selectTreeNote,
        clearSelection: clearTreeSelection,
        selectedNoteIDs: selectedTreeNoteIDs,
        createFolder,
        selectFolder,
        renameNote: renameNoteFromTree,
        renameFolder: renameFolderFromTree,
        deleteFolder: deleteFolderFromTree,
        rebaseFolderPath
    };
}
