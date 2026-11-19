import { requestJSON, requestJSONResponse } from './lib/api-client.js';
import { CommandPalette } from './lib/command-palette.js';
import { ensureFrontmatterTags, extractMarkdownOutline, MarkdownEditor, planHighlightUpdate, renderMarkdownLines, setFrontmatterProperty, shouldRenderEditorHighlight, DEFAULT_TASK_MARKERS } from './lib/markdown-editor.js';
import { GraphView } from './lib/graph-view.js';
import { formatFileSize } from './lib/format.js';
import { normalizeLinkPath } from './lib/note-links.js';
import { tablePropertyKeys } from './lib/table-data.js';
import { createTableView } from './lib/table-view.js';
import { createSidePanels } from './lib/side-panels.js';
import { createTasksPanel } from './lib/tasks-panel.js';
import { createAgendaPanel } from './lib/agenda-panel.js';
import { createSettingsPanel } from './lib/settings-panel.js';
import { createNoteListView, skeletonLines } from './lib/note-list.js';
import { createFolderTree } from './lib/folder-tree.js';
import { createSaveSession } from './lib/save-session.js';
import { createEditorPreview } from './lib/editor-preview.js';

const pageSize = 30;
const treePageSize = 100;
const state = {
    mode: 'title',
    folder: '',
    tag: '',
    tags: [],
    offset: 0,
    total: 0,
    notes: [],
    folders: [],
    folderNotes: new Map(),
    folderNotesLoading: new Set(),
    folderNotesGeneration: 0,
    expandedFolders: new Set(['']),
    view: 'list',
    graphVisible: false,
    graphData: null,
    graphRequestID: 0,
    graphScopeCurrent: false,
    graphCacheKey: '',
    backlinks: null,
    backlinksError: '',
    backlinksRequestID: 0,
    outline: [],
    pendingOutlineLine: null,
    pendingBacklink: null,
    pendingTaskLine: null,
    tasks: null,
    tasksError: '',
    tasksLoading: false,
    tasksRequestID: 0,
    taskMarkers: [...DEFAULT_TASK_MARKERS],
    noteID: null,
    noteFolder: '',
    noteVersion: null,
    frontmatterExpanded: false,
    savedDraft: null,
    savedTags: [],
    listState: null,
    directEntry: false,
    requestID: 0,
    notesAbortController: null,
    navigationID: 0,
    searchTimer: null,
    saveTimer: null,
    savePromise: null,
    notesLoaded: false,
    tableData: [],
    table: null,
    tableRequestID: 0,
    tableKey: '',
    tableLoaded: false,
    tableTotal: 0,
    tableTruncated: false,
    tableLoading: false,
    tableHiddenProperties: new Set(),
    treeSelection: new Set(),
    treeSelectionAnchor: null,
    wikilinkRequestID: 0,
    wikilinkTimer: null,
    wikilinkHeadingCache: new Map(),
    wikilinkAutocomplete: {
        open: false,
        items: [],
        activeIndex: 0,
        mode: 'note'
    }
};
let editorSplitPercent = 50;
let workspacePanelWidth = 280;

const elements = {
    searchView: document.querySelector('#searchView'),
    graphView: document.querySelector('#graphView'),
    graphScopeCurrent: document.querySelector('#graphScopeCurrent'),
    editorView: document.querySelector('#editorView'),
    searchInput: document.querySelector('#searchInput'),
    resultsSection: document.querySelector('#resultsSection'),
    tableView: document.querySelector('#tableView'),
    notesTable: document.querySelector('#notesTable'),
    tableFooter: document.querySelector('#tableFooter'),
    tableLoadedStatus: document.querySelector('#tableLoadedStatus'),
    loadMoreTable: document.querySelector('#loadMoreTable'),
    tableColumnsPicker: document.querySelector('#tableColumnPicker'),
    tableColumnsToggle: document.querySelector('.table-columns-toggle'),
    tableColumnsList: document.querySelector('#tableColumnsList'),
    tableColumnsEmpty: document.querySelector('#tableColumnsEmpty'),
    tableColumnsAll: document.querySelector('#tableColumnsAll'),
    tableColumnsNone: document.querySelector('#tableColumnsNone'),
    notesList: document.querySelector('#notesList'),
    resultCount: document.querySelector('#resultCount'),
    resultsTitle: document.querySelector('#resultsTitle'),
    tagFilterBar: document.querySelector('#tagFilterBar'),
    clearTag: document.querySelector('#clearTag'),
    clearFolder: document.querySelector('#clearFolder'),
    pagination: document.querySelector('#pagination'),
    pageStatus: document.querySelector('#pageStatus'),
    previousPage: document.querySelector('#previousPage'),
    nextPage: document.querySelector('#nextPage'),
    panel: document.querySelector('#workspacePanel'),
    panelResizer: document.querySelector('#workspacePanelResizer'),
    panelTitle: document.querySelector('#panelTitle'),
    panelContent: document.querySelector('#panelContent'),
    backlinksCount: document.querySelector('#backlinksCount'),
    outlineCount: document.querySelector('#outlineCount'),
    tasksCount: document.querySelector('#tasksCount'),
    agendaCount: document.querySelector('#agendaCount'),
    currentFolder: document.querySelector('#currentFolder'),
    noteTitle: document.querySelector('#noteTitle'),
    noteContent: document.querySelector('#noteContent'),
    noteContentHighlight: document.querySelector('#noteContentHighlight'),
    sourceEditor: document.querySelector('.source-editor'),
    markdownPreview: document.querySelector('#markdownPreview'),
    wikilinkAutocomplete: document.querySelector('#wikilinkAutocomplete'),
    helpDialog: document.querySelector('#helpDialog'),
    helpButton: document.querySelector('#helpButton'),
    helpContent: document.querySelector('#helpContent'),
    attachmentsDialog: document.querySelector('#attachmentsDialog'),
    attachmentsButton: document.querySelector('#attachmentsButton'),
    attachmentInput: document.querySelector('#attachmentInput'),
    attachmentPhotoInput: document.querySelector('#attachmentPhotoInput'),
    addAttachment: document.querySelector('#addAttachment'),
    addAttachmentPhoto: document.querySelector('#addPhoto'),
    attachmentList: document.querySelector('#attachmentList'),
    attachmentsEmpty: document.querySelector('#attachmentsEmpty'),
    editorWorkspace: document.querySelector('.editor-workspace'),
    saveStatus: document.querySelector('#saveStatus'),
    appMessage: document.querySelector('#appMessage'),
    newNote: document.querySelector('#newNote'),
    deleteCurrentNote: document.querySelector('#deleteCurrentNote')
};

const editorPreview = createEditorPreview({
    state,
    elements,
    closePanel
});

const noteList = createNoteListView({
    state,
    elements,
    requestJSON,
    showMessage,
    renderTagFilter
});

const tasksPanel = createTasksPanel({
    state,
    elements,
    requestJSON,
    showMessage,
    syncMarkdownHighlight,
    skeletonLines
});

const settingsPanel = createSettingsPanel({
    state,
    elements,
    requestJSON,
    showMessage,
    saveMarkers: tasksPanel.saveMarkers,
    exportBackup,
    importMarkdownNotes,
    defaultTaskMarkers: DEFAULT_TASK_MARKERS
});

const agendaPanel = createAgendaPanel({
    elements,
    requestJSON,
    showMessage,
    skeletonLines
});

const sidePanels = createSidePanels({
    state,
    elements,
    requestJSON,
    showMessage,
    skeletonLines
});

const tableView = createTableView({
    state,
    elements,
    requestJSON,
    showMessage,
    openNote,
    setFrontmatterProperty,
    loadTags
});

const saveSession = createSaveSession({
    state,
    elements,
    requestJSON,
    showMessage,
    updatePreview: editorPreview.update,
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
    getMarkdownEditor: () => markdownEditor,
    resetEditorViewState: () => editorPreview.resetViewState()
});

const folderTree = createFolderTree({
    state,
    elements,
    requestJSON,
    showMessage,
    loadFolders,
    loadFolderNotes,
    loadTree: loadTreeNotes,
    loadNotes,
    openNote,
    openNewNote,
    flushSave: saveSession.flush,
    persistDraft: saveSession.persist,
    updateEditorBreadcrumb,
    closePanel,
    closeGraphView,
    captureListState,
    updateListHistory,
    isTypingTarget,
    deleteSelectedTreeNotes,
    getDraft: saveSession.getDraft,
    refreshOpenNoteAfterMove: saveSession.refreshAfterMove,
    tableView,
    sidePanels
});

function setEditorPlainText(plain) {
    elements.sourceEditor.classList.toggle('is-plain-text', plain);
}

// O overlay usa uma div por linha lógica. Assim é possível atualizar apenas as
// linhas alteradas: dentro de um bloco inline único, qualquer mudança força o
// Chromium a refazer o layout de toda a nota — com notas grandes, o texto
// visível ficava para trás da seleção e do cursor.
let renderedHighlight = null;

function refreshEditorGutter() {
    // Em navegadores com barra de rolagem clássica ela ocupa largura dentro do
    // textarea, mas não dentro do <pre> (overflow: hidden). Compensar no
    // padding mantém as quebras de linha idênticas.
    const gutter = Math.max(0, elements.noteContent.offsetWidth - elements.noteContent.clientWidth);
    elements.sourceEditor.style.setProperty('--editor-gutter', `${gutter}px`);
}

function syncHighlightScroll() {
    elements.noteContentHighlight.scrollTop = elements.noteContent.scrollTop;
    elements.noteContentHighlight.scrollLeft = elements.noteContent.scrollLeft;
}

function refreshEditorHighlightLayout() {
    refreshEditorGutter();
    syncHighlightScroll();
}

function createHighlightLine(html) {
    const line = document.createElement('div');
    line.className = 'source-line';
    line.innerHTML = html ?? '';
    return line;
}

function renderHighlightFull(value) {
    const lines = value.split('\n');
    const html = renderMarkdownLines(lines, state.taskMarkers);
    const fragment = document.createDocumentFragment();
    const lineElements = new Array(lines.length);
    for (let index = 0; index < lines.length; index++) {
        const line = createHighlightLine(html[index]);
        lineElements[index] = line;
        fragment.append(line);
    }
    elements.noteContentHighlight.replaceChildren(fragment);
    renderedHighlight = { value, lines, elements: lineElements };
    syncHighlightScroll();
}

function syncMarkdownHighlight() {
    const value = elements.noteContent.value;
    refreshEditorGutter();
    if (!shouldRenderEditorHighlight(value.length)) {
        // Sem overlay: o textarea mostra o próprio texto (CSS) e continua
        // rápido mesmo em notas enormes.
        setEditorPlainText(true);
        renderedHighlight = null;
        return;
    }
    setEditorPlainText(false);
    renderHighlightFull(value);
}

function updateMarkdownHighlight() {
    const value = elements.noteContent.value;
    if (!shouldRenderEditorHighlight(value.length)) {
        setEditorPlainText(true);
        renderedHighlight = null;
        return;
    }
    if (!renderedHighlight || elements.sourceEditor.classList.contains('is-plain-text')) {
        setEditorPlainText(false);
        renderHighlightFull(value);
        return;
    }
    if (value === renderedHighlight.value) {
        syncHighlightScroll();
        return;
    }
    const nextLines = value.split('\n');
    const plan = planHighlightUpdate(renderedHighlight.lines, nextLines);
    if (!plan) {
        renderedHighlight.value = value;
        syncHighlightScroll();
        return;
    }
    const html = renderMarkdownLines(nextLines, state.taskMarkers, { start: plan.start, end: plan.newEnd });
    const anchor = renderedHighlight.elements[plan.oldEnd] || null;
    const fragment = document.createDocumentFragment();
    const newElements = [];
    for (let index = plan.start; index < plan.newEnd; index++) {
        const line = createHighlightLine(html[index]);
        newElements.push(line);
        fragment.append(line);
    }
    for (let index = plan.start; index < plan.oldEnd; index++) {
        renderedHighlight.elements[index]?.remove();
    }
    if (anchor) elements.noteContentHighlight.insertBefore(fragment, anchor);
    else elements.noteContentHighlight.append(fragment);
    renderedHighlight.elements.splice(plan.start, plan.oldEnd - plan.start, ...newElements);
    renderedHighlight.lines = nextLines;
    renderedHighlight.value = value;
    syncHighlightScroll();
}

let markdownHighlightFrame = 0;
let outlineRefreshTimer = null;
let previewHeightFrame = 0;

function scheduleMarkdownHighlight() {
    // Uma atualização por frame, sempre com o valor mais recente. Ela mexe
    // apenas nas linhas que mudaram, então o realce acompanha a digitação.
    if (markdownHighlightFrame) return;
    markdownHighlightFrame = requestAnimationFrame(() => {
        markdownHighlightFrame = 0;
        updateMarkdownHighlight();
    });
}

function scheduleOutlineRefresh() {
    window.clearTimeout(outlineRefreshTimer);
    outlineRefreshTimer = window.setTimeout(() => {
        outlineRefreshTimer = null;
        sidePanels.refreshOutline();
    }, 260);
}

function schedulePreviewMinimumHeight() {
    if (previewHeightFrame) return;
    previewHeightFrame = requestAnimationFrame(() => {
        previewHeightFrame = 0;
        editorPreview.syncMinimumHeight();
    });
}

const markdownEditor = new MarkdownEditor(elements.noteContent, () => {
    scheduleMarkdownHighlight();
    schedulePreviewMinimumHeight();
    editorPreview.update();
    saveSession.schedule();
    scheduleOutlineRefresh();
}, editorPreview.updateHistoryButtons);
syncMarkdownHighlight();
const graphView = new GraphView(document.querySelector('#noteGraph'), id => void openNote(id));
const commandPalette = new CommandPalette({
    dialog: document.querySelector('#commandPalette'),
    input: document.querySelector('#commandInput'),
    list: document.querySelector('#commandList'),
    loadNotes: loadCommandNotes,
    getCommands: buildCommandItems,
    onNote: note => void openNote(note.id),
    onError: error => showMessage(`Não foi possível executar o comando: ${error.message}`, 'error')
});
document.querySelector('#graphButton').addEventListener('click', () => {
    void openGraphView().catch(error => {
        showMessage(`Não foi possível abrir o grafo: ${error.message}`, 'error');
    });
});

document.addEventListener('DOMContentLoaded', () => void initialize());

function startSplitResize(event) {
    if (event.button !== 0 || !window.matchMedia('(min-width: 701px)').matches) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing-editor');
    resizeSplit(event);
}

function resizeSplit(event) {
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    const bounds = elements.editorWorkspace.getBoundingClientRect();
    if (!bounds.width) return;
    editorSplitPercent = Math.min(80, Math.max(20, ((event.clientX - bounds.left) / bounds.width) * 100));
    updateSplitRatio();
    editorPreview.syncMinimumHeight();
    editorPreview.syncScroll();
}

function stopSplitResize(event) {
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove('is-resizing-editor');
    localStorage.setItem('editorSplitPercent', String(Math.round(editorSplitPercent)));
}

function handleSplitResizeKey(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') editorSplitPercent = 20;
    else if (event.key === 'End') editorSplitPercent = 80;
    else editorSplitPercent = Math.min(80, Math.max(20, editorSplitPercent + (event.key === 'ArrowRight' ? 5 : -5)));
    updateSplitRatio();
    localStorage.setItem('editorSplitPercent', String(Math.round(editorSplitPercent)));
}

function updateSplitRatio() {
    const splitter = document.querySelector('.editor-splitter');
    if (!splitter) return;
    elements.editorWorkspace.style.setProperty('--editor-left', `${editorSplitPercent}fr`);
    elements.editorWorkspace.style.setProperty('--editor-right', `${100 - editorSplitPercent}fr`);
    splitter.setAttribute('aria-valuenow', String(Math.round(editorSplitPercent)));
}

async function initialize() {
    try {
        const response = await fetch('/api/auth/status');
        if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
        const auth = await response.json();
        document.querySelector('#logoutButton').hidden = !auth.enabled;
        if (!auth.authenticated) {
            location.replace('/login.html');
            return;
        }
    } catch (error) {
        showMessage(`Não foi possível verificar o acesso: ${error.message}`, 'error');
        return;
    }
    setupEventListeners();
    folderTree.setupChangeEvents();
    setupTheme();
    await tableView.loadColumnPreferences();
    const savedPanelWidth = Number(localStorage.getItem('workspacePanelWidth'));
    if (Number.isFinite(savedPanelWidth) && savedPanelWidth > 0) workspacePanelWidth = savedPanelWidth;
    setWorkspacePanelWidth(workspacePanelWidth);
    const savedSplit = localStorage.getItem('editorSplitPercent');
    if (savedSplit !== null) {
        const splitPercent = Number(savedSplit);
        if (Number.isFinite(splitPercent)) editorSplitPercent = Math.min(80, Math.max(20, splitPercent));
    }
    updateSplitRatio();
    if (window.matchMedia('(max-width: 700px)').matches) closePanel();
    syncActiveRailButton();
    const initialListState = captureListState();
    const noteParam = new URLSearchParams(location.search).get('note');
    if (/^\d+$/.test(noteParam || '')) {
        state.directEntry = true;
        state.listState = initialListState;
        history.replaceState({ view: 'editor', noteId: Number(noteParam), list: initialListState, direct: true }, '', location.href);
        void openNote(Number(noteParam), { push: false });
    } else {
        history.replaceState({ view: 'list', list: initialListState }, '', location.href);
        loadNotes();
    }

    void loadTreeNotes().catch(error => {
        showMessage(`Não foi possível carregar as pastas: ${error.message}`, 'error');
    });
    loadTags();
    void tasksPanel.loadMarkers();
    // Counting tasks scans every note. It only feeds the sidebar badge, so let
    // the first screen settle and skip the scan if the panel was opened first.
    scheduleIdleWork(() => {
        if (state.tasks === null && !state.tasksLoading) void tasksPanel.load();
    });
    void agendaPanel.load();
}

function scheduleIdleWork(callback) {
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(callback, { timeout: 2500 });
        return;
    }
    window.setTimeout(callback, 1500);
}

function setupEventListeners() {
    document.querySelectorAll('.rail-button[data-panel]').forEach(button => {
        button.addEventListener('click', () => togglePanel(button.dataset.panel));
    });
    document.querySelectorAll('.rail-button, .brand-mark').forEach(button => {
        button.addEventListener('pointerdown', () => { button.dataset.pointerFocus = ''; });
        button.addEventListener('keydown', () => { delete button.dataset.pointerFocus; });
        button.addEventListener('blur', () => { delete button.dataset.pointerFocus; });
    });
    document.addEventListener('click', event => {
        if (!document.body.classList.contains('panel-open')) return;
        if (elements.panel.contains(event.target) ||
            elements.panelResizer.contains(event.target) ||
            event.target.closest('.rail-button[data-panel]')) return;
        closePanel();
    });
    document.querySelector('#homeButton').addEventListener('click', () => {
        void showAllNotes();
    });
    document.querySelector('#closePanel').addEventListener('click', closePanel);
    elements.panelResizer.addEventListener('pointerdown', startWorkspacePanelResize);
    elements.panelResizer.addEventListener('pointermove', resizeWorkspacePanel);
    elements.panelResizer.addEventListener('pointerup', stopWorkspacePanelResize);
    elements.panelResizer.addEventListener('pointercancel', stopWorkspacePanelResize);
    elements.panelResizer.addEventListener('keydown', handleWorkspacePanelResizeKey);
    window.addEventListener('resize', () => setWorkspacePanelWidth(workspacePanelWidth));
    document.querySelector('#closeGraph').addEventListener('click', closeGraphView);
    document.querySelector('#fitGraph').addEventListener('click', () => graphView.fit());
    document.querySelector('#graphSearch').addEventListener('input', event => graphView.setSearch(event.target.value));
    elements.graphScopeCurrent.addEventListener('change', () => {
        state.graphScopeCurrent = elements.graphScopeCurrent.checked;
        state.graphData = null;
        state.graphCacheKey = '';
        if (state.graphVisible) void openGraphView();
    });
    elements.newNote.addEventListener('click', () => openNewNote());
    document.querySelector('#commandButton').addEventListener('click', () => void commandPalette.open());
    elements.helpButton.addEventListener('click', () => void openHelp());
    document.querySelector('#closeHelp').addEventListener('click', () => elements.helpDialog.close());
    elements.helpDialog.addEventListener('close', () => {
        elements.helpButton.setAttribute('aria-expanded', 'false');
    });
    elements.helpDialog.addEventListener('click', event => {
        if (event.target === elements.helpDialog) elements.helpDialog.close();
    });
    document.querySelector('#markdownImportInput').addEventListener('change', event => {
        const files = [...event.target.files];
        event.target.value = '';
        if (files.length) void importMarkdownNotes(files);
    });
    elements.deleteCurrentNote.addEventListener('click', deleteCurrentNote);
    document.querySelector('#logoutButton').addEventListener('click', async () => {
        try {
            const response = await fetch('/api/auth/logout', { method: 'POST' });
            if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
            location.replace('/login.html');
        } catch (error) {
            showMessage(`Não foi possível encerrar a sessão: ${error.message}`, 'error');
        }
    });
    elements.attachmentsButton.addEventListener('click', event => {
        const dialog = elements.attachmentsDialog;
        if (dialog.open) {
            dialog.close();
            return;
        }
        dialog.style.visibility = 'hidden';
        dialog.show();
        positionAttachmentsDialog();
        dialog.style.visibility = '';
        elements.attachmentsButton.setAttribute('aria-expanded', 'true');
        // Apenas navegação por teclado move o foco para dentro do popover,
        // evitando interromper a seleção de texto ao abrir com o mouse.
        if (event.detail === 0) document.querySelector('#closeAttachments').focus();
        if (state.noteID !== null) void loadAttachments(state.noteID);
    });
    document.querySelector('#closeAttachments').addEventListener('click', () => elements.attachmentsDialog.close());
    elements.attachmentsDialog.addEventListener('close', () => {
        elements.attachmentsButton.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('pointerdown', event => {
        const dialog = elements.attachmentsDialog;
        if (!dialog.open || dialog.contains(event.target) || elements.attachmentsButton.contains(event.target)) return;
        dialog.close();
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !elements.attachmentsDialog.open) return;
        elements.attachmentsDialog.close();
        elements.attachmentsButton.focus();
    });
    const attachmentInputs = [elements.attachmentInput, elements.attachmentPhotoInput];
    for (const input of attachmentInputs) {
        // Alguns navegadores disparam apenas "input"; o WeakSet em
        // handleAttachmentSelection impede upload duplicado.
        input.addEventListener('input', () => handleAttachmentSelection(input));
        input.addEventListener('change', () => handleAttachmentSelection(input));
    }
    elements.addAttachment.addEventListener('click', () => startAttachmentPicker(elements.attachmentInput));
    elements.addAttachmentPhoto.addEventListener('click', () => startAttachmentPicker(elements.attachmentPhotoInput));
    // Alguns Android/Chrome não disparam "change" ao voltar do seletor de
    // arquivos (ou só preenchem input.files depois do foco). Ao recuperar o
    // foco, conferimos o input pendente e processamos o arquivo manualmente.
    window.addEventListener('focus', () => processPendingAttachmentSelection());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') processPendingAttachmentSelection();
    });
    elements.attachmentList.addEventListener('click', event => {
        const button = event.target.closest('[data-delete-attachment]');
        if (button) void deleteAttachment(Number(button.dataset.deleteAttachment));
    });
    document.querySelector('#themeToggle').addEventListener('click', toggleTheme);
    document.querySelector('#clearFolder').addEventListener('click', () => folderTree.selectFolder(''));
    elements.clearTag.addEventListener('click', () => void selectTag(''));
    elements.tagFilterBar.addEventListener('click', event => {
        const button = event.target.closest('[data-tag]');
        if (!button) return;
        const tag = button.dataset.tag || '';
        void selectTag(tag.toLowerCase() === state.tag.toLowerCase() ? '' : tag);
    });
    elements.searchInput.addEventListener('input', () => {
        window.clearTimeout(state.searchTimer);
        state.offset = 0;
        state.searchTimer = window.setTimeout(() => {
            if (state.mode === 'table') tableView.applyFilter();
            else loadNotes();
            updateListHistory();
        }, 160);
    });
    document.querySelectorAll('[data-mode]').forEach(button => {
        button.addEventListener('click', () => {
            state.mode = button.dataset.mode;
            updateSearchModes();
            state.offset = 0;
            loadNotes();
            updateListHistory();
        });
    });
    elements.tableColumnsList.addEventListener('change', event => {
        const input = event.target.closest('[data-table-column]');
        if (!input) return;
        const key = input.dataset.tableColumn;
        if (input.checked) state.tableHiddenProperties.delete(key);
        else state.tableHiddenProperties.add(key);
        tableView.saveColumnPreferences();
        tableView.setColumnVisible(key, input.checked);
    });
    elements.tableColumnsAll.addEventListener('click', () => {
        state.tableHiddenProperties.clear();
        tableView.saveColumnPreferences();
        tableView.render();
    });
    elements.tableColumnsNone.addEventListener('click', () => {
        state.tableHiddenProperties = new Set(tablePropertyKeys(state.tableData));
        tableView.saveColumnPreferences();
        tableView.render();
    });
    elements.loadMoreTable.addEventListener('click', () => void tableView.load(true));
    elements.previousPage.addEventListener('click', () => {
        state.offset = Math.max(0, state.offset - pageSize);
        loadNotes();
        updateListHistory();
    });
    elements.nextPage.addEventListener('click', () => {
        if (state.offset + pageSize < state.total) {
            state.offset += pageSize;
            loadNotes();
            updateListHistory();
        }
    });
    elements.panelContent.addEventListener('click', handlePanelClick);
    elements.panelContent.addEventListener('keydown', folderTree.handleKeydown);
    elements.panelContent.addEventListener('dragstart', folderTree.handleDragStart);
    elements.panelContent.addEventListener('dragend', folderTree.dragEnd);
    elements.panelContent.addEventListener('dragover', folderTree.handleDragOver);
    elements.panelContent.addEventListener('dragleave', folderTree.handleDragLeave);
    elements.panelContent.addEventListener('drop', folderTree.handleDrop);
    elements.notesList.addEventListener('click', handleNoteListClick);
    elements.noteContent.addEventListener('input', event => {
        markdownEditor.handleInput(event);
        editorPreview.syncMinimumHeight();
        scheduleWikilinkSuggestions();
    });
    elements.noteContent.addEventListener('compositionstart', () => markdownEditor.handleCompositionStart());
    elements.noteContent.addEventListener('compositionend', () => markdownEditor.handleCompositionEnd());
    elements.noteContent.addEventListener('keydown', event => {
        if (!handleWikilinkKeydown(event)) markdownEditor.handleKeydown(event);
    });
    elements.noteContent.addEventListener('keyup', event => {
        if (!['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
            scheduleWikilinkSuggestions();
        }
    });
    elements.noteContent.addEventListener('click', scheduleWikilinkSuggestions);
    elements.noteContent.addEventListener('blur', () => {
        window.setTimeout(closeWikilinkAutocomplete, 100);
    });
    elements.wikilinkAutocomplete.addEventListener('mousedown', event => event.preventDefault());
    elements.wikilinkAutocomplete.addEventListener('click', event => {
        const option = event.target.closest('[data-wikilink-index]');
        if (!option) return;
        const item = state.wikilinkAutocomplete.items[Number(option.dataset.wikilinkIndex)];
        if (item) acceptWikilinkSuggestion(item);
    });
    elements.wikilinkAutocomplete.addEventListener('mouseover', event => {
        const option = event.target.closest('[data-wikilink-index]');
        if (!option) return;
        state.wikilinkAutocomplete.activeIndex = Number(option.dataset.wikilinkIndex);
        updateWikilinkActiveOption();
    });
    elements.markdownPreview.addEventListener('click', event => {
        const frontmatterToggle = event.target.closest('[data-frontmatter-toggle]');
        if (frontmatterToggle) {
            state.frontmatterExpanded = !state.frontmatterExpanded;
            editorPreview.renderFrontmatterProperties();
            return;
        }
        const link = event.target.closest('a[href]');
        if (!link) return;
        let url;
        try {
            url = new URL(link.getAttribute('href'), window.location.href);
        } catch {
            return;
        }
        if (url.origin !== window.location.origin) return;
        const noteID = url.searchParams.get('note');
        if (!/^\d+$/.test(noteID || '')) return;
        event.preventDefault();
        void openNote(Number(noteID), { heading: url.searchParams.get('heading') || '' });
    });
    elements.noteContent.addEventListener('scroll', () => {
        editorPreview.handleScroll(elements.noteContent);
        elements.noteContentHighlight.scrollTop = elements.noteContent.scrollTop;
        elements.noteContentHighlight.scrollLeft = elements.noteContent.scrollLeft;
        if (state.wikilinkAutocomplete.open) renderWikilinkAutocomplete();
    });
    elements.markdownPreview.addEventListener('scroll', () => editorPreview.handleScroll(elements.markdownPreview));
    // Images load after the first preview render and change its scroll height;
    // recompute the spacer so the panes keep matching scroll ranges.
    elements.markdownPreview.addEventListener('load', () => {
        editorPreview.syncMinimumHeight();
        editorPreview.syncScroll();
    }, true);
    window.addEventListener('resize', () => {
        editorPreview.invalidateMeasurements();
        positionAttachmentsDialog();
        tableView.resize();
        if (state.view === 'editor' && window.matchMedia('(max-width: 700px)').matches &&
            elements.editorWorkspace.dataset.editorMode === 'split') {
            editorPreview.setMode('edit');
        }
        editorPreview.syncMinimumHeight();
        editorPreview.syncScroll();
        requestAnimationFrame(refreshEditorHighlightLayout);
        if (state.wikilinkAutocomplete.open) renderWikilinkAutocomplete();
    });
    elements.noteTitle.addEventListener('input', () => {
        updateEditorBreadcrumb();
        saveSession.schedule();
    });
    const splitter = document.querySelector('.editor-splitter');
    splitter.addEventListener('pointerdown', startSplitResize);
    splitter.addEventListener('pointermove', resizeSplit);
    splitter.addEventListener('pointerup', stopSplitResize);
    splitter.addEventListener('pointercancel', stopSplitResize);
    splitter.addEventListener('keydown', handleSplitResizeKey);
    document.querySelector('.markdown-tools').addEventListener('click', event => {
        const action = event.target.closest('[data-action]');
        if (action?.dataset.action === 'undo') markdownEditor.undo();
        if (action?.dataset.action === 'redo') markdownEditor.redo();
        const button = event.target.closest('[data-format]');
        if (button) markdownEditor.format(button.dataset.format);
    });
    document.querySelectorAll('.editor-mode[data-editor-mode]').forEach(button => {
        button.addEventListener('click', () => {
            editorPreview.setMode(button.dataset.editorMode);
            requestAnimationFrame(refreshEditorHighlightLayout);
        });
    });
    window.addEventListener('popstate', event => void handlePopState(event));
    window.addEventListener('beforeunload', event => {
        if (state.view === 'editor' && saveSession.isDirty()) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
    document.addEventListener('keydown', event => {
        // The help dialog is modal and handles Escape natively; do not let the
        // global shortcuts run behind it.
        if (elements.helpDialog.open) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
            if (event.defaultPrevented) return;
            event.preventDefault();
            if (commandPalette.dialog.open) commandPalette.close();
            else void commandPalette.open();
            return;
        }
        if (commandPalette.dialog.open) return;
        if (event.key === '/' && state.view === 'list' && !isTypingTarget(event.target)) {
            event.preventDefault();
            (state.graphVisible ? document.querySelector('#graphSearch') : elements.searchInput).focus();
        }
        if ((event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey && state.view === 'editor') {
            const mobile = window.matchMedia('(max-width: 700px)').matches;
            const modes = mobile ? ['edit', 'preview'] : ['edit', 'split', 'preview'];
            let mode = null;
            if (event.code === 'Digit1') mode = 'edit';
            else if (event.code === 'Digit2') mode = mobile ? 'edit' : 'split';
            else if (event.code === 'Digit3') mode = 'preview';
            else if (event.key.toLowerCase() === 'v') {
                mode = modes[(modes.indexOf(elements.editorWorkspace.dataset.editorMode) + 1) % modes.length];
            }
            if (mode) {
                event.preventDefault();
                editorPreview.setMode(mode);
                requestAnimationFrame(refreshEditorHighlightLayout);
            }
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
            event.preventDefault();
            void openNewNote();
        }
        if (state.view === 'editor' && event.key === 'Escape' && !event.defaultPrevented) {
            if (elements.attachmentsDialog.open) elements.attachmentsDialog.close();
            else navigateBack();
        }
        if (state.view === 'list' && state.graphVisible && event.key === 'Escape' && !event.defaultPrevented) {
            closeGraphView();
        }
    });
}

function isTypingTarget(target) {
    return target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

function captureListState() {
    return {
        query: elements.searchInput.value,
        mode: state.mode,
        folder: state.folder,
        tag: state.tag,
        offset: state.offset,
        graphVisible: state.graphVisible
    };
}

function updateListHistory() {
    if (state.view === 'list') {
        history.replaceState({ view: 'list', list: captureListState() }, '', location.href);
    }
}

async function openGraphView() {
    if (state.view === 'editor') {
        if (!(await saveSession.flush())) {
            showMessage('Salve a nota antes de abrir o grafo.', 'error');
            return;
        }
        const listState = state.listState || captureListState();
        history.pushState({ view: 'list', list: { ...listState, graphVisible: true } }, '', location.pathname);
        state.view = 'list';
        state.noteID = null;
        sidePanels.resetBacklinks();
        sidePanels.resetOutline();
        state.directEntry = false;
        document.body.classList.remove('is-editor-view');
        elements.editorView.hidden = true;
        elements.newNote.hidden = false;
        restoreListState({ ...listState, graphVisible: false });
        void loadNotes();
    }
    if (state.view !== 'list') return;
    state.graphVisible = true;
    document.body.classList.add('is-graph-view');
    elements.searchView.hidden = true;
    elements.graphView.hidden = false;
    const graphButton = document.querySelector('#graphButton');
    graphButton.classList.add('is-active');
    graphButton.setAttribute('aria-pressed', 'true');
    updateListHistory();
    requestAnimationFrame(() => graphView.resize());
    elements.graphScopeCurrent.disabled = !state.folder && !state.tag;
    const scopeFolder = state.graphScopeCurrent ? state.folder : '';
    const scopeTag = state.graphScopeCurrent ? state.tag : '';
    const graphCacheKey = `${scopeFolder}\u0000${scopeTag}`;
    if (state.graphData && state.graphCacheKey === graphCacheKey) {
        graphView.setGraph(state.graphData);
        updateGraphSummary(state.graphData);
        return;
    }

    const requestID = ++state.graphRequestID;
    const summary = document.querySelector('#graphSummary');
    summary.innerHTML = '<span class="skeleton skeleton-line" aria-hidden="true"></span>';
    const params = new URLSearchParams();
    if (scopeFolder) params.set('folder', scopeFolder);
    if (scopeTag) params.set('tag', scopeTag);
    const endpoint = params.size ? `/api/graph?${params}` : '/api/graph';
    try {
        const graph = await requestJSON(endpoint);
        if (requestID !== state.graphRequestID || !state.graphVisible) return;
        if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
            throw new Error('Resposta inválida da API do grafo.');
        }
        state.graphData = graph;
        state.graphCacheKey = graphCacheKey;
        graphView.setGraph(graph);
        updateGraphSummary(graph);
        requestAnimationFrame(() => graphView.fit());
    } catch (error) {
        if (requestID !== state.graphRequestID) return;
        summary.textContent = 'Não foi possível carregar as relações.';
        showMessage(`Não foi possível carregar o grafo: ${error.message}`, 'error');
    }
}

function closeGraphView() {
    if (!state.graphVisible) return;
    state.graphVisible = false;
    state.graphRequestID++;
    document.body.classList.remove('is-graph-view');
    elements.graphView.hidden = true;
    elements.searchView.hidden = false;
    const graphButton = document.querySelector('#graphButton');
    graphButton.classList.remove('is-active');
    graphButton.setAttribute('aria-pressed', 'false');
    updateListHistory();
}

function updateGraphSummary(graph) {
    const nodeCount = graph.nodes.length;
    const edgeCount = graph.edges.length;
    document.querySelector('#graphSummary').textContent =
        `${nodeCount} ${nodeCount === 1 ? 'nota' : 'notas'} · ${edgeCount} ${edgeCount === 1 ? 'relação' : 'relações'}`;
}

function updateSearchModes() {
    document.querySelectorAll('[data-mode]').forEach(button => {
        const active = button.dataset.mode === state.mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    const tableMode = state.mode === 'table';
    elements.resultsSection.hidden = tableMode;
    elements.tableView.hidden = !tableMode;
    elements.tableColumnsPicker.hidden = !tableMode;
    elements.searchInput.placeholder = tableMode
        ? 'Pesquisar em qualquer coluna...'
        : 'Pesquisar notas...';
    if (tableMode) elements.pagination.hidden = true;
    tableView.updateFooter();
}

async function loadNotes() {
    if (state.mode === 'table') {
        if (state.view === 'editor') return;
        await tableView.load();
        return;
    }
    // Typing in the search box can start requests faster than the FTS index
    // answers them. Cancel the previous request so the server stops working on
    // a query whose results the UI will discard anyway.
    state.notesAbortController?.abort();
    const controller = new AbortController();
    state.notesAbortController = controller;
    const requestID = ++state.requestID;
    const query = elements.searchInput.value.trim();
    const params = new URLSearchParams({
        folder: state.folder,
        limit: String(pageSize),
        offset: String(state.offset)
    });
    if (state.tag) params.set('tag', state.tag);
    const endpoint = query ? '/api/search' : '/api/notes';
    if (query) {
        params.set('q', query);
        params.set('mode', state.mode);
    }
    if (!state.notesLoaded) noteList.renderSkeletons();
    try {
        const page = await requestJSON(`${endpoint}?${params}`, { signal: controller.signal });
        if (requestID !== state.requestID) return;
        state.notesLoaded = true;
        if (page.total > 0 && state.offset >= page.total) {
            state.offset = Math.floor((page.total - 1) / pageSize) * pageSize;
            return loadNotes();
        }
        state.notes = page.items;
        state.total = page.total;
        noteList.render(page);
    } catch (error) {
        if (error.name === 'AbortError') return;
        if (requestID === state.requestID) {
            if (!state.notesLoaded) {
                state.notesLoaded = true;
                elements.notesList.replaceChildren();
            }
            showMessage(`Não foi possível carregar as notas: ${error.message}`, 'error');
        }
    }
}

function handlePanelClick(event) {
    const createNoteFolder = event.target.closest('[data-create-note-folder]');
    if (createNoteFolder) {
        void openNewNote(createNoteFolder.dataset.createNoteFolder);
        return;
    }
    const createSubfolder = event.target.closest('[data-create-subfolder]');
    if (createSubfolder) {
        void folderTree.createFolder(createSubfolder.dataset.createSubfolder);
        return;
    }
    if (event.target.closest('[data-create-note]')) {
        void openNewNote();
        return;
    }
    if (event.target.closest('[data-create-folder]')) {
        void folderTree.createFolder();
        return;
    }
    const renameNote = event.target.closest('[data-rename-note]');
    if (renameNote) {
        event.preventDefault();
        event.stopPropagation();
        void folderTree.renameNote(Number(renameNote.dataset.renameNote));
        return;
    }
    const renameFolder = event.target.closest('[data-rename-folder]');
    if (renameFolder) {
        event.preventDefault();
        event.stopPropagation();
        void folderTree.renameFolder(renameFolder.dataset.renameFolder);
        return;
    }
    const deleteFolder = event.target.closest('[data-delete-folder]');
    if (deleteFolder) {
        event.preventDefault();
        event.stopPropagation();
        void folderTree.deleteFolder(deleteFolder.dataset.deleteFolder);
        return;
    }
    const outlineItem = event.target.closest('[data-outline-line]');
    if (outlineItem) {
        editorPreview.scrollToOutlineHeading(outlineItem.dataset.outlineLine);
        return;
    }
    const taskItem = event.target.closest('[data-task-note]');
    if (taskItem) {
        openTask(
            Number(taskItem.dataset.taskNote),
            Number(taskItem.dataset.taskLine),
            taskItem.dataset.taskFolder || ''
        );
        return;
    }
    const backlink = event.target.closest('[data-backlink-note]');
    if (backlink) {
        const target = state.noteID === null
            ? null
            : {
                id: state.noteID,
                title: (state.savedDraft?.title || elements.noteTitle.value).trim(),
                folder: state.noteFolder
            };
        if (window.matchMedia('(max-width: 700px)').matches) closePanel();
        void openNote(Number(backlink.dataset.backlinkNote), { backlinkTarget: target });
        return;
    }
    const remove = event.target.closest('[data-delete-tree-note]');
    if (remove) {
        event.preventDefault();
        event.stopPropagation();
        void deleteNote(Number(remove.dataset.deleteTreeNote));
        return;
    }
    const toggle = event.target.closest('[data-toggle-folder]');
    if (toggle) {
        event.preventDefault();
        event.stopPropagation();
        document.body.classList.add('panel-open');
        const folder = toggle.dataset.toggleFolder;
        if (state.expandedFolders.has(folder)) state.expandedFolders.delete(folder);
        else {
            state.expandedFolders.add(folder);
            void loadFolderNotes(folder);
        }
        folderTree.render();
        return;
    }
    const more = event.target.closest('[data-more-folder]');
    if (more) {
        void loadFolderNotes(more.dataset.moreFolder, true);
        return;
    }
    const folderButton = event.target.closest('[data-folder]');
    if (folderButton) {
        folderTree.clearSelection();
        void folderTree.selectFolder(folderButton.dataset.folder);
        return;
    }
    const note = event.target.closest('[data-tree-note]');
    if (note) {
        const noteID = Number(note.dataset.treeNote);
        if (event.shiftKey) {
            event.preventDefault();
            folderTree.selectNote(noteID, 'range');
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            folderTree.selectNote(noteID, 'toggle');
            return;
        }
        folderTree.selectNote(noteID);
        void openNote(noteID);
    }
}


async function loadTreeNotes() {
    const generation = state.folderNotesGeneration;
    const folders = ['', ...state.expandedFolders]
        .filter((folder, index, list) => list.indexOf(folder) === index);
    const params = new URLSearchParams({ limit: String(treePageSize) });
    for (const folder of folders) params.append('folder', folder);
    const { data, response } = await requestJSONResponse(`/api/tree-notes?${params}`);
    if (generation !== state.folderNotesGeneration) return;
    if (!Array.isArray(data?.folders) || !data.notes) throw new Error('resposta de pastas inválida');
    const revision = Number(response.headers.get('X-Notes-Revision'));
    folderTree.noteRevision(revision);
    state.folders = data.folders;
    for (const [folder, page] of Object.entries(data.notes)) {
        state.folderNotes.set(folder, { items: page.items || [], total: page.total || 0 });
    }
    if (elements.panel.dataset.panel === 'files') folderTree.render();
}

async function loadFolders() {
    try {
        const { data, response } = await requestJSONResponse('/api/folders');
        state.folders = data;
        if (!Array.isArray(state.folders)) throw new Error('resposta de pastas inválida');
        const revision = Number(response.headers.get('X-Notes-Revision'));
        folderTree.noteRevision(revision);
        if (elements.panel.dataset.panel === 'files') folderTree.render();
    } catch (error) {
        showMessage(`Não foi possível carregar as pastas: ${error.message}`, 'error');
    }
}

async function loadFolderNotes(folder, more = false) {
    const previous = state.folderNotes.get(folder);
    if (!more && previous) return;
    if (state.folderNotesLoading.has(folder)) return;
    const generation = state.folderNotesGeneration;
    const offset = more && previous ? previous.items.length : 0;
    const params = new URLSearchParams({ folder, limit: String(treePageSize), offset: String(offset) });
    state.folderNotesLoading.add(folder);
    try {
        const page = await requestJSON(`/api/folder-notes?${params}`);
        if (generation !== state.folderNotesGeneration) return;
        const items = more && previous ? [...previous.items, ...page.items] : page.items;
        state.folderNotes.set(folder, { items, total: page.total });
        if (elements.panel.dataset.panel === 'files') folderTree.render();
    } catch (error) {
        showMessage(`Não foi possível carregar as notas da pasta: ${error.message}`, 'error');
    } finally {
        state.folderNotesLoading.delete(folder);
        if (generation !== state.folderNotesGeneration && state.expandedFolders.has(folder)) {
            void loadFolderNotes(folder);
        }
    }
}

function handleNoteListClick(event) {
    const empty = event.target.closest('[data-empty-action]');
    if (empty) {
        void handleEmptyAction(empty.dataset.emptyAction);
        return;
    }
    const action = event.target.closest('[data-action]');
    const card = event.target.closest('[data-note-id]');
    if (!card || !action) return;
    const id = Number(card.dataset.noteId);
    if (action.dataset.action === 'open') void openNote(id);
    else if (action.dataset.action === 'occurrences') void noteList.toggleOccurrences(card, action);
    else if (action.dataset.action === 'tag') void selectTag(action.dataset.tag || '');
    else if (action.dataset.action === 'delete') void deleteNote(id);
}

async function handleEmptyAction(action) {
    if (action === 'new') {
        await openNewNote();
        return;
    }
    if (action === 'graph') {
        await openGraphView();
        return;
    }
    if (action === 'clear') {
        elements.searchInput.value = '';
        state.tag = '';
        state.folder = '';
        state.offset = 0;
        if (state.graphVisible) closeGraphView();
        await loadNotes();
        updateListHistory();
    }
}

async function loadTags() {
    try {
        const tags = await requestJSON('/api/tags');
        if (!Array.isArray(tags)) throw new Error('resposta de tags inválida');
        state.tags = tags;
        renderTagFilter();
    } catch (error) {
        state.tags = [];
        renderTagFilter();
    }
}

function renderTagFilter() {
    elements.tagFilterBar.replaceChildren();
    const tags = state.tags.filter(tag => tag && tag.name);
    elements.tagFilterBar.hidden = tags.length === 0;
    for (const tag of tags) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `chip tag-filter${tag.name.toLowerCase() === state.tag.toLowerCase() ? ' is-active' : ''}`;
        button.dataset.tag = tag.name;
        button.setAttribute('aria-pressed', String(tag.name.toLowerCase() === state.tag.toLowerCase()));
        button.title = `Filtrar por #${tag.name}`;
        const name = document.createElement('span');
        name.textContent = `#${tag.name}`;
        const count = document.createElement('span');
        count.className = 'chip-count tag-filter-count';
        count.textContent = String(tag.count);
        button.append(name, count);
        elements.tagFilterBar.append(button);
    }
}

async function exportBackup(button = document.querySelector('#exportBackup')) {
    if (button) button.disabled = true;
    try {
        const response = await fetch('/api/backup');
        if (response.status === 401) {
            location.replace('/login.html');
            return;
        }
        if (!response.ok) {
            throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
        }
        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition') || '';
        const match = /filename="?([^";]+)"?/i.exec(disposition);
        const filename = match ? match[1] : `ton618-${new Date().toISOString().slice(0, 10)}.zip`;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        showMessage('Backup exportado.', 'success');
    } catch (error) {
        showMessage(`Não foi possível exportar o backup: ${error.message}`, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

async function importMarkdownNotes(files, button = document.querySelector('#importMarkdownNotes')) {
    if (button) button.disabled = true;
    let imported = 0;
    const failures = [];
    try {
        for (const file of files) {
            if (!/\.md$/i.test(file.name)) {
                failures.push(`${file.name}: selecione um arquivo Markdown (.md)`);
                continue;
            }
            const title = file.name.replace(/\.md$/i, '').trim();
            if (!title) {
                failures.push(`${file.name}: o nome do arquivo não pode ser vazio`);
                continue;
            }
            try {
                const content = await file.text();
                await requestJSON('/api/notes', {
                    method: 'POST',
                    body: JSON.stringify({ title, content, folder: '', tags: [] })
                });
                imported++;
            } catch (error) {
                failures.push(`${file.name}: ${error.message}`);
            }
        }
        if (imported > 0) {
            tableView.invalidate();
            state.offset = 0;
            await folderTree.refresh();
            await loadNotes();
        }
        if (failures.length) {
            const details = failures.slice(0, 3).join('; ');
            const remaining = failures.length - 3;
            showMessage(
                `Importadas ${imported} de ${files.length} notas Markdown. ${details}` +
                (remaining > 0 ? `; e mais ${remaining} falha(s).` : ''),
                'error'
            );
        } else {
            showMessage(
                `${imported} ${imported === 1 ? 'nota Markdown importada' : 'notas Markdown importadas'} na raiz.`,
                'success'
            );
        }
    } finally {
        if (button) button.disabled = false;
    }
}

async function selectTag(tag) {
    if (state.view === 'editor' && !(await saveSession.flush())) return;
    if (state.graphVisible) closeGraphView();
    if (state.view === 'editor') {
        history.pushState({ view: 'list', list: { ...captureListState(), tag, offset: 0 } }, '', location.pathname);
        state.view = 'list';
        state.noteID = null;
        sidePanels.resetBacklinks();
        sidePanels.resetOutline();
        document.body.classList.remove('is-editor-view');
        elements.editorView.hidden = true;
        elements.searchView.hidden = false;
        elements.newNote.hidden = false;
    }
    state.tag = tag;
    state.offset = 0;
    updateListHistory();
    await loadNotes();
    if (elements.panel.dataset.panel === 'search') elements.searchInput.focus();
}

function isSameWikilinkToken(current, token) {
    return Boolean(current) && current.query === token.query &&
        current.tokenStart === token.tokenStart && current.hasHeading === token.hasHeading;
}

function normalizeAutocompleteText(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase();
}

function pickWikilinkNote(items, noteQuery) {
    const normalized = normalizeLinkPath(noteQuery);
    if (!normalized) return items[0] || null;
    return items.find(note => normalizeLinkPath(note.title) === normalized ||
        normalizeLinkPath(`${note.folder}/${note.title}`) === normalized) ||
        items.find(note => normalizeLinkPath(note.title).endsWith(`/${normalized}`)) ||
        items[0] || null;
}

function buildHeadingOptions(headings, headingQuery, reference) {
    const needle = normalizeAutocompleteText(headingQuery).trim();
    return headings
        .filter(heading => !needle || normalizeAutocompleteText(heading.text).includes(needle))
        .map(heading => ({
            label: heading.text,
            secondary: `H${heading.level}`,
            insert: `${reference}#${heading.text}`,
            kind: 'heading',
            prefix: Boolean(needle) && normalizeAutocompleteText(heading.text).trim().startsWith(needle)
        }))
        .sort((a, b) => Number(b.prefix) - Number(a.prefix))
        .slice(0, 8);
}

async function showWikilinkNoteSuggestions(token, requestID) {
    const query = token.query.trim();
    const params = new URLSearchParams({ limit: '100', offset: '0' });
    let url = `/api/notes?${params}`;
    if (query) {
        params.set('q', query);
        params.set('mode', 'title');
        url = `/api/search?${params}`;
    }
    const page = await requestJSON(url);
    const currentToken = markdownEditor.getWikilinkToken();
    if (requestID !== state.wikilinkRequestID || !isSameWikilinkToken(currentToken, token)) return;

    const counts = new Map();
    for (const note of page.items) {
        const key = note.title.trim().toLocaleLowerCase();
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    const normalizedQuery = normalizeAutocompleteText(query);
    state.wikilinkAutocomplete.mode = 'note';
    state.wikilinkAutocomplete.items = page.items
        .map(note => ({
            label: note.title,
            secondary: note.folder,
            insert: counts.get(note.title.trim().toLocaleLowerCase()) > 1 && note.folder
                ? `${note.folder}/${note.title}`
                : note.title,
            kind: 'note',
            prefix: normalizeAutocompleteText(note.title).startsWith(normalizedQuery),
            updated: note.updated_at || ''
        }))
        .sort((a, b) => Number(b.prefix) - Number(a.prefix) ||
            b.updated.localeCompare(a.updated) || a.label.localeCompare(b.label))
        .slice(0, 8);
    state.wikilinkAutocomplete.activeIndex = 0;
    state.wikilinkAutocomplete.open = state.wikilinkAutocomplete.items.length > 0;
    renderWikilinkAutocomplete();
}

async function showWikilinkHeadingSuggestions(token, requestID) {
    const noteQuery = token.noteQuery.trim();
    let reference = '';
    let headings = [];
    if (!noteQuery) {
        headings = extractMarkdownOutline(elements.noteContent.value);
    } else {
        const cacheKey = normalizeAutocompleteText(noteQuery);
        const cached = state.wikilinkHeadingCache.get(cacheKey);
        if (cached) {
            reference = cached.reference;
            headings = cached.headings;
        } else {
            const searchQuery = noteQuery.replace(/\.md$/i, '').split('/').filter(Boolean).pop() || noteQuery;
            const params = new URLSearchParams({ limit: '100', offset: '0', q: searchQuery, mode: 'title' });
            const page = await requestJSON(`/api/search?${params}`);
            let currentToken = markdownEditor.getWikilinkToken();
            if (requestID !== state.wikilinkRequestID || !isSameWikilinkToken(currentToken, token)) return;

            const note = pickWikilinkNote(page.items, noteQuery);
            if (note) {
                const noteData = await requestJSON(`/api/notes/${note.id}`);
                currentToken = markdownEditor.getWikilinkToken();
                if (requestID !== state.wikilinkRequestID || !isSameWikilinkToken(currentToken, token)) return;
                headings = extractMarkdownOutline(noteData.content);
                reference = noteQuery.includes('/') && note.folder
                    ? `${note.folder}/${note.title}`
                    : note.title;
                state.wikilinkHeadingCache.set(cacheKey, { reference, headings });
            }
        }
    }

    const currentToken = markdownEditor.getWikilinkToken();
    if (requestID !== state.wikilinkRequestID || !isSameWikilinkToken(currentToken, token)) return;

    state.wikilinkAutocomplete.mode = 'heading';
    state.wikilinkAutocomplete.items = buildHeadingOptions(headings, token.headingQuery, reference);
    state.wikilinkAutocomplete.activeIndex = 0;
    state.wikilinkAutocomplete.open = state.wikilinkAutocomplete.items.length > 0;
    renderWikilinkAutocomplete();
}

function scheduleWikilinkSuggestions() {
    const token = markdownEditor.getWikilinkToken();
    if (state.view !== 'editor' || !token) {
        closeWikilinkAutocomplete();
        return;
    }
    window.clearTimeout(state.wikilinkTimer);
    state.wikilinkAutocomplete.open = false;
    elements.wikilinkAutocomplete.hidden = true;
    elements.noteContent.setAttribute('aria-expanded', 'false');
    elements.noteContent.removeAttribute('aria-activedescendant');
    const requestID = ++state.wikilinkRequestID;
    state.wikilinkTimer = window.setTimeout(async () => {
        try {
            if (token.hasHeading) await showWikilinkHeadingSuggestions(token, requestID);
            else await showWikilinkNoteSuggestions(token, requestID);
        } catch (error) {
            if (requestID === state.wikilinkRequestID) {
                closeWikilinkAutocomplete();
                showMessage(`Não foi possível buscar sugestões para o link: ${error.message}`, 'error');
            }
        }
    }, 100);
}

function renderWikilinkAutocomplete() {
    const popup = elements.wikilinkAutocomplete;
    const headingMode = state.wikilinkAutocomplete.mode === 'heading';
    popup.setAttribute('aria-label', headingMode ? 'Cabeçalhos para link' : 'Notas para link');
    popup.replaceChildren();
    state.wikilinkAutocomplete.items.forEach((item, index) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'wikilink-option';
        option.dataset.wikilinkIndex = String(index);
        option.id = `wikilink-option-${index}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === state.wikilinkAutocomplete.activeIndex));
        if (index === state.wikilinkAutocomplete.activeIndex) option.classList.add('is-active');
        if (headingMode) {
            const marker = document.createElement('span');
            marker.className = 'wikilink-option-marker';
            marker.textContent = '#';
            option.append(marker);
        }
        const label = document.createElement('span');
        label.className = 'wikilink-option-label';
        label.textContent = item.label;
        option.append(label);
        if (item.secondary) {
            const folder = document.createElement('span');
            folder.className = headingMode ? 'wikilink-option-level' : 'wikilink-option-folder';
            folder.textContent = item.secondary;
            option.append(folder);
        }
        popup.append(option);
    });
    popup.hidden = !state.wikilinkAutocomplete.open;
    elements.noteContent.setAttribute('aria-expanded', String(state.wikilinkAutocomplete.open));
    if (state.wikilinkAutocomplete.open) {
        elements.noteContent.setAttribute(
            'aria-activedescendant',
            `wikilink-option-${state.wikilinkAutocomplete.activeIndex}`
        );
        const position = getTextareaCaretPosition(elements.noteContent, elements.noteContent.selectionStart);
        const bounds = popup.getBoundingClientRect();
        const left = Math.min(position.left, window.innerWidth - bounds.width - 8);
        const top = position.top + bounds.height > window.innerHeight
            ? Math.max(8, position.top - position.height - bounds.height)
            : position.top;
        popup.style.left = `${Math.max(8, left)}px`;
        popup.style.top = `${Math.max(8, top)}px`;
    } else {
        elements.noteContent.removeAttribute('aria-activedescendant');
    }
}

function getTextareaCaretPosition(textarea, caret) {
    const computed = window.getComputedStyle(textarea);
    const mirror = document.createElement('div');
    const style = mirror.style;
    for (const property of [
        'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
        'borderLeftWidth', 'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom',
        'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
        'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing',
        'wordSpacing', 'lineHeight', 'tabSize'
    ]) style[property] = computed[property];
    style.position = 'absolute';
    style.visibility = 'hidden';
    style.whiteSpace = 'pre-wrap';
    style.wordWrap = 'break-word';
    style.overflowWrap = 'break-word';
    style.height = 'auto';
    style.left = '-100000px';
    style.top = '0';
    mirror.textContent = textarea.value.slice(0, caret);
    const marker = document.createElement('span');
    marker.textContent = textarea.value.slice(caret) || '.';
    mirror.append(marker);
    document.body.append(mirror);
    const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.2;
    const top = marker.offsetTop + (parseFloat(computed.borderTopWidth) || 0);
    const left = marker.offsetLeft + (parseFloat(computed.borderLeftWidth) || 0);
    mirror.remove();
    const bounds = textarea.getBoundingClientRect();
    return {
        top: bounds.top + top - textarea.scrollTop + lineHeight,
        left: bounds.left + left - textarea.scrollLeft,
        height: lineHeight
    };
}

function handleWikilinkKeydown(event) {
    if (!state.wikilinkAutocomplete.open) return false;
    const { items, activeIndex } = state.wikilinkAutocomplete;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopImmediatePropagation();
        state.wikilinkAutocomplete.activeIndex =
            (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        renderWikilinkAutocomplete();
        return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (items[activeIndex]) acceptWikilinkSuggestion(items[activeIndex]);
        return true;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeWikilinkAutocomplete();
        return true;
    }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) closeWikilinkAutocomplete();
    return false;
}

function acceptWikilinkSuggestion(item) {
    closeWikilinkAutocomplete();
    markdownEditor.acceptWikilink(item.insert);
}

function updateWikilinkActiveOption() {
    for (const [index, option] of [...elements.wikilinkAutocomplete.children].entries()) {
        const active = index === state.wikilinkAutocomplete.activeIndex;
        option.classList.toggle('is-active', active);
        option.setAttribute('aria-selected', String(active));
    }
}

function closeWikilinkAutocomplete() {
    window.clearTimeout(state.wikilinkTimer);
    state.wikilinkRequestID++;
    state.wikilinkAutocomplete.open = false;
    state.wikilinkAutocomplete.items = [];
    elements.wikilinkAutocomplete.hidden = true;
    elements.noteContent.setAttribute('aria-expanded', 'false');
    elements.noteContent.removeAttribute('aria-activedescendant');
}

async function openNewNote(folder = state.folder) {
    if (state.view === 'editor' && !(await saveSession.flush())) return;
    if (state.view === 'list') state.listState = captureListState();
    history.pushState({ view: 'editor', noteId: null, list: state.listState, direct: false }, '', location.pathname);
    state.directEntry = false;
    showEditor(null);
    state.noteFolder = folder;
}

function createAutomaticNoteTitle(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    const day = `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function openNote(id, { push = true, backlinkTarget = null, heading = '', line = null } = {}) {
    if (state.view === 'editor' && !(await saveSession.flush())) return;
    const navigationID = ++state.navigationID;
    let listState = state.view === 'editor' ? state.listState : captureListState();
    try {
        const note = await requestJSON(`/api/notes/${id}`);
        if (navigationID !== state.navigationID) return;
        state.listState = listState;
        if (push) {
            history.pushState({ view: 'editor', noteId: id, list: listState, direct: false }, '', `?note=${id}`);
            state.directEntry = false;
        }
        showEditor(note);
        state.pendingBacklink = backlinkTarget;
        state.pendingTaskLine = Number.isFinite(line) && line > 0 ? line - 1 : null;
        if (backlinkTarget) editorPreview.update();
        if (heading) editorPreview.scrollToLinkedHeading(heading);
        editorPreview.runPendingTaskLine();
    } catch (error) {
        showMessage(`Não foi possível abrir a nota: ${error.message}`, 'error');
    }
}

function showEditor(note) {
    window.clearTimeout(state.saveTimer);
    closeWikilinkAutocomplete();
    state.wikilinkHeadingCache.clear();
    elements.attachmentsDialog.close();
    if (window.matchMedia('(max-width: 700px)').matches) closePanel();
    document.body.classList.remove('is-graph-view');
    document.body.classList.add('is-editor-view');
    state.view = 'editor';
    state.noteID = note?.id ?? null;
    state.noteVersion = note?.version ?? null;
    elements.searchView.hidden = true;
    elements.graphView.hidden = true;
    elements.editorView.hidden = false;
    elements.newNote.hidden = true;
    elements.noteTitle.value = note ? note.title : createAutomaticNoteTitle();
    state.frontmatterExpanded = false;
    state.noteFolder = note ? note.folder : state.folder;
    elements.deleteCurrentNote.hidden = !note;
    elements.attachmentList.replaceChildren();
    elements.attachmentList.hidden = true;
    elements.attachmentsEmpty.hidden = false;
    elements.attachmentsButton.title = 'Abrir anexos';
    elements.attachmentsButton.setAttribute('aria-label', 'Abrir anexos');
    sidePanels.resetBacklinks();
    state.pendingBacklink = null;
    state.pendingOutlineLine = null;
    state.pendingTaskLine = null;
    elements.saveStatus.className = 'save-status';
    elements.saveStatus.textContent = note ? 'Salvo' : 'Rascunho';
    const content = note ? ensureFrontmatterTags(note.content, note.tags || []) : '';
    state.savedTags = note ? [...(note.tags || [])] : [];
    state.outline = extractMarkdownOutline(content);
    sidePanels.updateOutlineCount();
    editorPreview.resetViewState();
    elements.noteContent.value = content;
    state.savedDraft = saveSession.getDraft();
    markdownEditor.setValue(content, { silent: true });
    syncMarkdownHighlight();
    const savedMode = localStorage.getItem('editorMode');
    const preferredMode = ['edit', 'split', 'preview'].includes(savedMode) ? savedMode : 'split';
    editorPreview.setMode(window.matchMedia('(max-width: 700px)').matches && preferredMode === 'split'
        ? 'edit'
        : preferredMode);
    editorPreview.update();
    // Setting a textarea's value puts the caret at the end in Chromium, and
    // focusing it then scrolls the editor (and, through scroll sync, the
    // preview) to the last line. Reset the caret and both panes so long notes
    // always open at the top.
    elements.noteContent.setSelectionRange(0, 0);
    elements.noteContent.scrollTop = 0;
    elements.noteContentHighlight.scrollTop = 0;
    elements.markdownPreview.scrollTop = 0;
    elements.noteContent.focus();
    requestAnimationFrame(refreshEditorHighlightLayout);
    updateEditorBreadcrumb();
    if (note) {
        void loadAttachments(note.id);
        void sidePanels.loadBacklinks(note.id);
    } else if (elements.panel.dataset.panel === 'backlinks') {
        sidePanels.renderBacklinks();
    } else if (elements.panel.dataset.panel === 'outline') {
        sidePanels.renderOutline();
    }
}

function updateEditorBreadcrumb() {
    elements.currentFolder.textContent = state.noteFolder || 'Sem pasta';
    elements.noteTitle.title = elements.noteTitle.value || 'Título da nota';
}

// HELP.md is rendered on the server so the dialog follows the same Markdown
// pipeline (and security rules) as note previews.
let helpRequestID = 0;

async function openHelp() {
    const dialog = elements.helpDialog;
    if (!dialog.open) {
        dialog.showModal();
        elements.helpButton.setAttribute('aria-expanded', 'true');
    }
    const requestID = ++helpRequestID;
    if (!elements.helpContent.childElementCount) {
        elements.helpContent.textContent = 'Carregando ajuda…';
    }
    elements.helpContent.setAttribute('aria-busy', 'true');
    try {
        const response = await fetch('/api/help');
        if (response.status === 401) {
            location.replace('/login.html');
            return;
        }
        if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
        const html = await response.text();
        if (requestID !== helpRequestID) return;
        elements.helpContent.innerHTML = html;
        for (const link of elements.helpContent.querySelectorAll('a[href]')) {
            if (/^https?:/i.test(link.href)) {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
        }
    } catch (error) {
        if (requestID === helpRequestID) {
            elements.helpContent.textContent = `Não foi possível carregar a ajuda: ${error.message}`;
        }
    } finally {
        if (requestID === helpRequestID) elements.helpContent.removeAttribute('aria-busy');
    }
}

// Moving a note or folder can rewrite links in the note that is currently
// open. Reload it when the local draft is clean so the editor does not save
// the stale content over the server-side fix.
function positionAttachmentsDialog() {
    const dialog = elements.attachmentsDialog;
    if (!dialog.open) return;
    const button = elements.attachmentsButton.getBoundingClientRect();
    const width = dialog.offsetWidth;
    const height = dialog.offsetHeight;
    const margin = 12;
    const gap = 8;
    const left = Math.max(margin, Math.min(
        button.right - width,
        window.innerWidth - width - margin
    ));
    let top = button.bottom + gap;
    if (top + height > window.innerHeight - margin) {
        top = Math.max(margin, button.top - height - gap);
    }
    dialog.style.left = `${Math.round(left)}px`;
    dialog.style.top = `${Math.round(top)}px`;
}

async function loadAttachments(noteID) {
    try {
        const attachments = await requestJSON(`/api/notes/${noteID}/attachments`);
        if (state.noteID === noteID) renderAttachments(attachments, noteID);
    } catch (error) {
        if (state.noteID === noteID) showMessage(`Não foi possível carregar os anexos: ${error.message}`, 'error');
    }
}

function renderAttachments(attachments, noteID) {
    const list = elements.attachmentList;
    list.replaceChildren();
    for (const attachment of attachments) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = attachment.url;
        link.textContent = `${attachment.filename} (${formatFileSize(attachment.size)})`;
        link.title = attachment.filename;
        const remove = document.createElement('button');
        remove.className = 'attachment-remove';
        remove.type = 'button';
        remove.dataset.deleteAttachment = String(attachment.id);
        remove.dataset.noteId = String(noteID);
        remove.setAttribute('aria-label', `Excluir anexo ${attachment.filename}`);
        remove.textContent = '×';
        item.append(link, remove);
        list.append(item);
    }
    list.hidden = attachments.length === 0;
    elements.attachmentsEmpty.hidden = attachments.length !== 0;
    const label = attachments.length ? `Anexos (${attachments.length})` : 'Abrir anexos';
    elements.attachmentsButton.title = label;
    elements.attachmentsButton.setAttribute('aria-label', label);
    positionAttachmentsDialog();
}

const maxAttachmentBytes = 25 * 1024 * 1024;
const uploadingAttachmentInputs = new WeakSet();
let pendingAttachmentInput = null;
let attachmentPickerTimer = 0;

function startAttachmentPicker(input) {
    if (!input) return;
    pendingAttachmentInput = input;
    window.clearTimeout(attachmentPickerTimer);
    // Se o usuário cancelar o seletor, não deixe um input pendente para sempre.
    attachmentPickerTimer = window.setTimeout(() => {
        if (pendingAttachmentInput === input) pendingAttachmentInput = null;
    }, 120000);
    input.click();
}

function clearPendingAttachmentInput(input) {
    if (pendingAttachmentInput !== input) return;
    pendingAttachmentInput = null;
    window.clearTimeout(attachmentPickerTimer);
}

function handleAttachmentSelection(input) {
    if (!input || uploadingAttachmentInputs.has(input)) return false;
    const files = input.files ? Array.from(input.files) : [];
    if (!files.length) return false;
    clearPendingAttachmentInput(input);
    uploadingAttachmentInputs.add(input);
    void uploadAttachments(files)
        .catch(error => {
            showMessage(`Não foi possível enviar o anexo: ${error.message}`, 'error');
        })
        .finally(() => {
            uploadingAttachmentInputs.delete(input);
            // Só limpa depois que o upload terminou: em alguns Android o
            // reset imediato invalida os File entregues pelo seletor.
            input.value = '';
        });
    return true;
}

function processPendingAttachmentSelection(attempt = 0) {
    const input = pendingAttachmentInput;
    if (!input) return;
    // O Chrome no Android pode preencher input.files alguns instantes depois
    // de a janela recuperar o foco. Tentamos algumas vezes antes de desistir.
    const delays = [150, 400, 900, 1600];
    window.setTimeout(() => {
        if (pendingAttachmentInput !== input) return;
        if (handleAttachmentSelection(input)) return;
        if (attempt + 1 >= delays.length) {
            clearPendingAttachmentInput(input);
            return;
        }
        processPendingAttachmentSelection(attempt + 1);
    }, delays[attempt] ?? delays[delays.length - 1]);
}

function attachmentFilename(file) {
    const name = (file.name || '').trim();
    if (name) return name;
    // Android pickers sometimes hand back a file without a name. Without one
    // the server rejects the upload, so synthesize one from the MIME type.
    const subtype = (file.type || '').split('/')[1] || '';
    const extension = subtype.replace(/[^a-z0-9]/gi, '') || 'bin';
    return `anexo-${Date.now()}.${extension}`;
}

async function attachmentResponseError(response) {
    const text = (await response.text()).trim();
    // Proxies costumam devolver uma página HTML inteira em erros (413, 502).
    // O aviso na tela deve mostrar apenas um resumo legível.
    const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const detail = plain || `HTTP ${response.status}`;
    return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
}

function setAttachmentUploading(uploading) {
    for (const button of [elements.addAttachment, elements.addAttachmentPhoto]) {
        if (!button) continue;
        button.disabled = uploading;
    }
    const submit = elements.addAttachment;
    if (submit) submit.textContent = uploading ? 'Enviando…' : 'Enviar arquivos';
}

async function uploadAttachments(files) {
    if (!files.length || state.view !== 'editor') return;
    setAttachmentUploading(true);
    try {
        // A brand-new note only exists in the browser until it is saved. Force
        // the first save so the attachment has a note to belong to; otherwise
        // the upload was silently dropped.
        const saved = await saveSession.flush({ create: true });
        if (!saved || state.noteID === null) {
            showMessage(state.noteID === null
                ? 'Não foi possível criar a nota antes de enviar o anexo. Informe um título e tente novamente.'
                : 'Não foi possível salvar a nota antes de enviar o anexo. Tente novamente.', 'error');
            return;
        }
        const noteID = state.noteID;
        for (const file of files) {
            if (file.size > maxAttachmentBytes) {
                showMessage(`${attachmentFilename(file)} tem ${formatFileSize(file.size)}; o limite por anexo é ${formatFileSize(maxAttachmentBytes)}.`, 'error');
                continue;
            }
            const form = new FormData();
            form.append('file', file, attachmentFilename(file));
            try {
                const response = await fetch(`/api/notes/${noteID}/attachments`, { method: 'POST', body: form });
                if (response.status === 401) {
                    location.replace('/login.html');
                    return;
                }
                if (!response.ok) {
                    if (response.status === 413) {
                        throw new Error('o servidor recusou o arquivo por tamanho (413); se houver um proxy reverso, aumente o limite de corpo (por exemplo, client_max_body_size 26m)');
                    }
                    throw new Error(await attachmentResponseError(response));
                }
                const attachment = await response.json();
                if (state.noteID === noteID) {
                    insertAttachmentMarkdown(attachment);
                    tableView.invalidate();
                    await loadAttachments(noteID);
                }
            } catch (error) {
                const message = error instanceof TypeError
                    ? 'falha de rede; verifique a conexão ou o proxy reverso'
                    : error.message;
                showMessage(`Não foi possível enviar ${attachmentFilename(file)}: ${message}`, 'error');
                return;
            }
        }
        if (state.noteID === noteID) await saveSession.flush();
    } finally {
        setAttachmentUploading(false);
    }
}

function insertAttachmentMarkdown(attachment) {
    const textarea = elements.noteContent;
    const label = attachment.filename.replace(/[\r\n]/g, ' ').replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
    const inlineImage = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(attachment.media_type);
    const destination = `${attachment.url}${inlineImage ? '?inline=1' : ''}`;
    const markdown = inlineImage ? `![${label}](${destination})` : `[${label}](${destination})`;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const prefix = before && !/\s$/.test(before) ? '\n' : '';
    const suffix = after && !/^\s/.test(after) ? '\n' : '';
    const next = `${before}${prefix}${markdown}${suffix}${after}`;
    const cursor = before.length + prefix.length + markdown.length + suffix.length;
    textarea.value = next;
    textarea.focus();
    textarea.setSelectionRange(cursor, cursor);
    markdownEditor.handleInput({ inputType: 'insertFromPaste' });
}

async function deleteAttachment(attachmentID) {
    const noteID = state.noteID;
    if (noteID === null) return;
    const button = document.querySelector(`[data-delete-attachment="${attachmentID}"]`);
    const filename = button?.previousElementSibling?.textContent || 'este anexo';
    if (!window.confirm(`Excluir ${filename}? Essa ação não pode ser desfeita.`)) return;
    try {
        await requestJSON(`/api/notes/${noteID}/attachments/${attachmentID}`, { method: 'DELETE' });
        tableView.removeAttachment(noteID, attachmentID);
        await loadAttachments(noteID);
        showMessage('Anexo excluído.', 'success');
    } catch (error) {
        showMessage(`Não foi possível excluir o anexo: ${error.message}`, 'error');
    }
}

function navigateBack() {
    if (state.view !== 'editor') return;
    if (state.directEntry) {
        void returnToList(state.listState || captureListState(), true);
    } else {
        history.back();
    }
}

async function showAllNotes() {
    const allNotes = { query: '', mode: 'title', folder: '', tag: '', offset: 0, graphVisible: false };
    if (state.view === 'editor') {
        await returnToList(allNotes, true);
        return;
    }
    if (state.graphVisible) closeGraphView();
    restoreListState(allNotes);
    state.view = 'list';
    state.noteID = null;
    elements.editorView.hidden = true;
    elements.newNote.hidden = false;
    document.body.classList.remove('is-editor-view');
    updateListHistory();
    await loadNotes();
    elements.searchInput.focus();
}

async function returnToList(listState, replace = false) {
    if (!(await saveSession.flush())) return;
    const target = listState || { query: '', mode: 'title', folder: '', offset: 0 };
    if (replace) history.replaceState({ view: 'list', list: target }, '', location.pathname);
    state.view = 'list';
    state.noteID = null;
    sidePanels.resetBacklinks();
    sidePanels.resetOutline();
    document.body.classList.remove('is-editor-view');
    state.directEntry = false;
    restoreListState(target);
    elements.editorView.hidden = true;
    elements.graphView.hidden = !state.graphVisible;
    elements.searchView.hidden = state.graphVisible;
    elements.newNote.hidden = false;
    await loadNotes();
    if (elements.panel.dataset.panel === 'search') elements.searchInput.focus();
}

function restoreListState(listState) {
    elements.searchInput.value = listState.query || '';
    state.mode = listState.mode || 'title';
    state.folder = listState.folder || '';
    state.tag = listState.tag || '';
    state.offset = listState.offset || 0;
    state.graphVisible = Boolean(listState.graphVisible);
    document.body.classList.toggle('is-graph-view', state.graphVisible);
    elements.graphView.hidden = !state.graphVisible;
    elements.searchView.hidden = state.graphVisible;
    const graphButton = document.querySelector('#graphButton');
    graphButton.classList.toggle('is-active', state.graphVisible);
    graphButton.setAttribute('aria-pressed', String(state.graphVisible));
    if (state.graphVisible && state.graphData) {
        graphView.setGraph(state.graphData);
        updateGraphSummary(state.graphData);
        requestAnimationFrame(() => graphView.resize());
    } else if (state.graphVisible) {
        void openGraphView();
    }
    updateSearchModes();
    document.querySelector('#currentFolder').textContent = state.folder || 'Todas as notas';
}

async function handlePopState(event) {
    const target = event.state || { view: 'list', list: state.listState };
    if (state.view === 'editor' && !(await saveSession.flush())) {
        history.forward();
        return;
    }
    if (target.view === 'editor' && target.noteId) {
        try {
            const note = await requestJSON(`/api/notes/${target.noteId}`);
            state.listState = target.list || state.listState || captureListState();
            state.directEntry = false;
            showEditor(note);
        } catch (error) {
            showMessage(`Não foi possível abrir a nota: ${error.message}`, 'error');
            history.forward();
        }
        return;
    }
    if (target.view === 'editor') {
        state.listState = target.list || state.listState || captureListState();
        state.directEntry = Boolean(target.direct);
        showEditor(null);
        return;
    }
    state.listState = target.list || state.listState;
    state.directEntry = false;
    state.view = 'list';
    document.body.classList.remove('is-editor-view');
    restoreListState(state.listState || {});
    state.noteID = null;
    sidePanels.resetBacklinks();
    sidePanels.resetOutline();
    elements.editorView.hidden = true;
    elements.graphView.hidden = !state.graphVisible;
    elements.searchView.hidden = state.graphVisible;
    elements.newNote.hidden = false;
    await loadNotes();
    if (elements.panel.dataset.panel === 'search') elements.searchInput.focus();
}

async function deleteCurrentNote() {
    if (state.noteID === null) return;
    if (!window.confirm(`Excluir “${elements.noteTitle.value}”? Essa ação não pode ser desfeita.`)) return;
    try {
        window.clearTimeout(state.saveTimer);
        if (state.savePromise) await state.savePromise;
        await requestJSON(`/api/notes/${state.noteID}`, { method: 'DELETE' });
        state.graphData = null;
        tableView.invalidate();
        state.savedDraft = saveSession.getDraft();
        showMessage('Nota excluída.', 'success');
        state.noteID = null;
        sidePanels.resetBacklinks();
        sidePanels.resetOutline();
        state.folderNotesGeneration++;
        state.folderNotes.clear();
        navigateBack();
        void Promise.all([loadFolders(), loadNotes(), loadTags()]);
        void loadFolderNotes('', false);
    } catch (error) {
        saveSession.setStatus(`Não foi possível excluir: ${error.message}`, 'error');
    }
}

async function deleteNote(id) {
    const note = state.notes.find(item => item.id === id) ||
        [...state.folderNotes.values()].flatMap(page => page.items).find(item => item.id === id);
    if (!window.confirm(`Excluir “${note?.title || 'esta nota'}”? Essa ação não pode ser desfeita.`)) return;
    const deletingCurrent = state.view === 'editor' && state.noteID === id;
    try {
        if (deletingCurrent) {
            window.clearTimeout(state.saveTimer);
            if (state.savePromise) await state.savePromise;
        }
        await requestJSON(`/api/notes/${id}`, { method: 'DELETE' });
        state.graphData = null;
        tableView.invalidate();
        showMessage('Nota excluída.', 'success');
        state.folderNotesGeneration++;
        state.folderNotes.clear();
        void tasksPanel.load();
        if (deletingCurrent) {
            state.savedDraft = saveSession.getDraft();
            state.noteID = null;
            sidePanels.resetBacklinks();
            sidePanels.resetOutline();
            if (state.directEntry) await returnToList(state.listState || captureListState(), true);
            else history.back();
            void Promise.all([loadFolders(), loadNotes(), loadTags()]);
            void loadFolderNotes('', false);
            return;
        }
        state.total = Math.max(0, state.total - 1);
        if (state.offset > 0 && state.offset >= state.total) state.offset = Math.max(0, state.offset - pageSize);
        await Promise.all([loadNotes(), loadFolders()]);
        await loadFolderNotes('', false);
    } catch (error) {
        showMessage(`Não foi possível excluir a nota: ${error.message}`, 'error');
    }
}

async function deleteSelectedTreeNotes() {
    const ids = folderTree.selectedNoteIDs();
    if (!ids.length) return;
    if (ids.length === 1) {
        await deleteNote(ids[0]);
        return;
    }
    if (!window.confirm(`Excluir ${ids.length} notas? Essa ação não pode ser desfeita.`)) return;
    const deletingCurrent = state.view === 'editor' && ids.includes(state.noteID);
    try {
        if (deletingCurrent) {
            window.clearTimeout(state.saveTimer);
            if (state.savePromise) await state.savePromise;
        }
        const results = await Promise.allSettled(ids.map(id =>
            requestJSON(`/api/notes/${id}`, { method: 'DELETE' })
        ));
        const deleted = ids.filter((_, index) => results[index].status === 'fulfilled');
        const failed = ids.length - deleted.length;
        state.graphData = null;
        tableView.invalidate();
        state.folderNotesGeneration++;
        state.folderNotes.clear();
        folderTree.clearSelection();
        showMessage(
            failed
                ? `${deleted.length} notas excluídas, ${failed} falharam.`
                : `${deleted.length} notas excluídas.`,
            failed ? 'error' : 'success'
        );
        void tasksPanel.load();
        if (deletingCurrent) {
            state.savedDraft = saveSession.getDraft();
            state.noteID = null;
            sidePanels.resetBacklinks();
            sidePanels.resetOutline();
            if (state.directEntry) await returnToList(state.listState || captureListState(), true);
            else history.back();
            void Promise.all([loadFolders(), loadNotes(), loadTags()]);
            void loadFolderNotes('', false);
            return;
        }
        state.total = Math.max(0, state.total - deleted.length);
        if (state.offset > 0 && state.offset >= state.total) state.offset = Math.max(0, state.offset - pageSize);
        await Promise.all([loadNotes(), loadFolders()]);
        await loadFolderNotes('', false);
    } catch (error) {
        showMessage(`Não foi possível excluir as notas: ${error.message}`, 'error');
    }
}

function syncActiveRailButton() {
    const current = document.body.classList.contains('panel-open') ? elements.panel.dataset.panel : null;
    document.querySelectorAll('.rail-button[data-panel]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.panel === current);
    });
}

function togglePanel(name) {
    if (elements.panel.dataset.panel === name && document.body.classList.contains('panel-open')) {
        closePanel();
        return;
    }
    elements.panel.dataset.panel = name;
    document.body.classList.add('panel-open');
    syncActiveRailButton();
    if (name === 'backlinks') {
        elements.panelTitle.textContent = 'Backlinks';
        sidePanels.renderBacklinks();
        if (state.noteID !== null && state.backlinks === null) void sidePanels.loadBacklinks(state.noteID);
    } else if (name === 'outline') {
        elements.panelTitle.textContent = 'Sumário';
        sidePanels.renderOutline();
    } else if (name === 'tasks') {
        elements.panelTitle.textContent = 'Tarefas';
        tasksPanel.render();
        void tasksPanel.load();
    } else if (name === 'agenda') {
        elements.panelTitle.textContent = 'Agenda';
        agendaPanel.render();
        void agendaPanel.load().finally(() => agendaPanel.focus());
    } else if (name === 'settings') {
        settingsPanel.render();
    } else {
        elements.panelTitle.textContent = 'Pastas e notas';
        folderTree.render();
    }
}

function getWorkspacePanelWidthBounds() {
    const max = Math.max(220, Math.min(640, window.innerWidth - 40 - 80));
    return { min: Math.min(220, max), max };
}

function setWorkspacePanelWidth(width, persist = false) {
    const { min, max } = getWorkspacePanelWidthBounds();
    workspacePanelWidth = Math.round(Math.min(max, Math.max(min, width)));
    document.documentElement.style.setProperty('--workspace-panel-width', `${workspacePanelWidth}px`);
    elements.panelResizer.setAttribute('aria-valuemax', String(max));
    elements.panelResizer.setAttribute('aria-valuenow', String(workspacePanelWidth));
    if (persist) localStorage.setItem('workspacePanelWidth', String(workspacePanelWidth));
}

function startWorkspacePanelResize(event) {
    if (event.button !== 0 || window.matchMedia('(max-width: 700px)').matches) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing-workspace-panel');
    resizeWorkspacePanel(event);
}

function resizeWorkspacePanel(event) {
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    setWorkspacePanelWidth(event.clientX - 40);
}

function stopWorkspacePanelResize(event) {
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove('is-resizing-workspace-panel');
    setWorkspacePanelWidth(workspacePanelWidth, true);
}

function handleWorkspacePanelResizeKey(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const { min, max } = getWorkspacePanelWidthBounds();
    const width = event.key === 'Home' ? min
        : event.key === 'End' ? max
            : workspacePanelWidth + (event.key === 'ArrowRight' ? 20 : -20);
    setWorkspacePanelWidth(width, true);
}

function closePanel() {
    document.body.classList.remove('panel-open');
    syncActiveRailButton();
}

function revealNoteFolder(folder) {
    const target = folder || '';
    state.folder = target;
    if (target) {
        const parts = target.split('/');
        for (let index = 1; index <= parts.length; index++) {
            state.expandedFolders.add(parts.slice(0, index).join('/'));
        }
    }
    if (state.listState) state.listState = { ...state.listState, folder: target, offset: 0 };
    if (elements.panel.dataset.panel !== 'files' || !document.body.classList.contains('panel-open')) {
        togglePanel('files');
    } else {
        folderTree.render();
    }
    requestAnimationFrame(() => {
        elements.panelContent.querySelector('.tree-folder.is-selected, .tree-root.is-selected')
            ?.scrollIntoView({ block: 'nearest' });
    });
}

function openTask(noteID, line, folder = '') {
    revealNoteFolder(folder);
    if (window.matchMedia('(max-width: 700px)').matches) closePanel();
    if (state.view === 'editor' && state.noteID === noteID) {
        editorPreview.jumpToLine(line - 1);
        elements.noteContent.focus();
        return;
    }
    void openNote(noteID, { line });
}

function syncThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (meta && bg) meta.content = bg;
}

function setupTheme() {
    const saved = localStorage.getItem('theme');
    document.documentElement.dataset.theme = saved === 'light' ? 'light' : 'dark';
    syncThemeColor();
}

function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    syncThemeColor();
}

function buildCommandItems(query) {
    const themeLabel = document.documentElement.dataset.theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro';
    const commands = [
        {
            title: 'Nova nota',
            subtitle: 'Criar uma nota em branco',
            icon: 'plus',
            hint: 'Ctrl N',
            keywords: 'criar adicionar',
            run: () => openNewNote()
        },
        {
            title: 'Abrir grafo de notas',
            subtitle: 'Explorar relações e backlinks',
            icon: 'graph',
            keywords: 'relações conexões',
            run: () => openGraphView()
        },
        {
            title: 'Abrir tarefas',
            subtitle: 'Ver marcações TODO, FIXME e outras nas notas',
            icon: 'tasks',
            keywords: 'todo fixme tarefas pendências',
            run: () => {
                if (elements.panel.dataset.panel !== 'tasks' || !document.body.classList.contains('panel-open')) {
                    togglePanel('tasks');
                }
            }
        },
        {
            title: 'Todas as notas',
            subtitle: 'Voltar para a lista principal',
            icon: 'list',
            keywords: 'início lista',
            run: () => showAllNotes()
        },
        {
            title: 'Pesquisar notas',
            subtitle: 'Ir para o campo de busca',
            icon: 'search',
            hint: '/',
            keywords: 'buscar procurar',
            run: () => showAllNotes()
        },
        {
            title: themeLabel,
            subtitle: 'Alternar entre claro e escuro',
            icon: 'theme',
            keywords: 'tema cores',
            run: () => toggleTheme()
        },
        {
            title: 'Exportar backup',
            subtitle: 'Baixar notas, pastas e anexos em .zip',
            icon: 'download',
            keywords: 'salvar baixar',
            run: () => exportBackup()
        }
    ];
    const normalized = query.toLocaleLowerCase();
    if (!normalized) return commands;
    return commands.filter(command =>
        `${command.title} ${command.subtitle || ''} ${command.keywords || ''}`
            .toLocaleLowerCase()
            .includes(normalized)
    );
}

async function loadCommandNotes(query) {
    const params = new URLSearchParams({ limit: '8', offset: '0' });
    let endpoint = '/api/notes';
    if (query) {
        params.set('q', query);
        params.set('mode', 'title');
        endpoint = '/api/search';
    }
    const page = await requestJSON(`${endpoint}?${params}`);
    return Array.isArray(page.items) ? page.items : [];
}

const messageIcons = {
    error: '<svg viewBox="0 0 24 24"><path d="M12 8v5m0 3.5v.1M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg>',
    success: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.2 4.2L19 7"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8.5v.1"/></svg>'
};

function showMessage(message, kind = '') {
    window.clearTimeout(showMessage.clearTimer);
    elements.appMessage.replaceChildren();
    if (!message) return;
    const toast = document.createElement('div');
    toast.className = `toast${kind ? ` is-${kind}` : ''}`;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = messageIcons[kind] || messageIcons.info;
    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Fechar aviso');
    close.textContent = '×';
    close.addEventListener('click', () => {
        window.clearTimeout(showMessage.clearTimer);
        toast.remove();
    });
    toast.append(icon, text, close);
    elements.appMessage.append(toast);
    showMessage.clearTimer = window.setTimeout(() => {
        toast.remove();
    }, kind === 'success' ? 2800 : 6000);
}
