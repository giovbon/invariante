import { iconHTML } from './icons.js';
import { formatFileSize } from './format.js';
import {
    fillTableRowSearch,
    normalizeTableSearch,
    parseTablePropertyValue,
    parseTableTags,
    tableAttachmentMatches,
    tableDisplayValue,
    tableFilterRow,
    tableNoteMatches,
    tablePropertyKeys,
    tableValuesEqual
} from './table-data.js';

const tablePageSize = 500;

// The Tabulator view is large and self-contained. Keeping it in its own
// factory makes the main module responsible for navigation/editor state while
// this module owns table data, formatting and inline property persistence.
export function createTableView({
    state,
    elements,
    requestJSON,
    showMessage,
    openNote,
    setFrontmatterProperty,
    loadTags
}) {
const tablePropertyPrefix = 'property:';
const tableIcons = {
    note: iconHTML('note'),
    file: iconHTML('file'),
    image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m5 17 5-4 3 2.5 3-3 3 3.5"/></svg>',
    pdf: iconHTML('pdf'),
    folder: iconHTML('folder'),
    open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg>',
    paperclip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 12.5 7.1-7.1a3 3 0 0 1 4.2 4.2l-9.2 9.2a5 5 0 0 1-7.1-7.1l9.2-9.2"/></svg>'
};

function tablePropertyField(key) {
    return `${tablePropertyPrefix}${key}`;
}

function invalidateTable() {
    state.tableLoaded = false;
    state.tableKey = '';
}

// Keeps the cached table data in sync after an attachment is deleted and
// invalidates the cache, so returning to the table view reloads it instead of
// showing stale attachment rows.
function removeAttachmentFromTable(noteID, attachmentID) {
    for (const note of state.tableData) {
        if (note.id !== noteID || !Array.isArray(note.attachments)) continue;
        note.attachments = note.attachments.filter(attachment => attachment.id !== attachmentID);
    }
    invalidateTable();
}

let tabulatorPromise = null;

// The 445 KB Tabulator bundle is only needed by the table view. Loading it on
// demand keeps the initial page light for the common note-editing flow.
function loadTabulator() {
    if (window.Tabulator) return Promise.resolve();
    if (!tabulatorPromise) {
        tabulatorPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/vendor/tabulator/tabulator.min.js';
            script.async = true;
            script.addEventListener('load', () => resolve(), { once: true });
            script.addEventListener('error', () => {
                tabulatorPromise = null;
                script.remove();
                reject(new Error('Não foi possível carregar o Tabulator.'));
            }, { once: true });
            document.head.append(script);
        });
    }
    return tabulatorPromise;
}

async function loadTable(more = false) {
    const key = `${state.folder}\u0000${state.tag}`;
    if (!more && state.tableLoaded && state.tableKey === key) {
        applyTableFilter();
        return;
    }
    const sameKey = state.tableLoaded && state.tableKey === key;
    const offset = more && sameKey ? state.tableData.length : 0;
    const requestID = ++state.tableRequestID;
    state.tableLoading = true;
    updateTableFooter();
    const params = new URLSearchParams({
        limit: String(tablePageSize),
        offset: String(offset)
    });
    if (state.folder) params.set('folder', state.folder);
    if (state.tag) params.set('tag', state.tag);
    try {
        const [payload] = await Promise.all([
            requestJSON(`/api/table?${params}`),
            loadTabulator()
        ]);
        if (requestID !== state.tableRequestID) return;
        const items = Array.isArray(payload.items) ? payload.items : [];
        if (more && offset === state.tableData.length) {
            state.tableData = [...state.tableData, ...items];
        } else {
            state.tableData = items;
        }
        state.tableTotal = Number.isFinite(payload.total) ? payload.total : state.tableData.length;
        state.tableTruncated = Boolean(payload.truncated);
        state.tableKey = key;
        state.tableLoaded = true;
        renderTable();
    } catch (error) {
        if (requestID !== state.tableRequestID) return;
        if (!more) {
            state.tableData = [];
            state.tableTotal = 0;
            state.tableTruncated = false;
            state.tableLoaded = false;
            renderTable();
        }
        showMessage(`Não foi possível carregar a tabela: ${error.message}`, 'error');
    } finally {
        if (requestID === state.tableRequestID) {
            state.tableLoading = false;
            updateTableFooter();
        }
    }
}

function updateTableFooter() {
    if (!elements.tableFooter) return;
    const remaining = Math.max(0, state.tableTotal - state.tableData.length);
    const visible = state.mode === 'table' && state.tableLoaded && remaining > 0;
    elements.tableFooter.hidden = !visible;
    if (!visible) return;
    elements.loadMoreTable.disabled = state.tableLoading;
    elements.loadMoreTable.textContent = state.tableLoading
        ? 'Carregando…'
        : `Carregar mais (${remaining})`;
    elements.tableLoadedStatus.textContent =
        `${state.tableData.length} de ${state.tableTotal} ${state.tableTotal === 1 ? 'nota' : 'notas'}`;
}

function resetTableContainer() {
    const host = document.querySelector('#notesTableHost');
    if (!host) return null;
    const fresh = document.createElement('div');
    fresh.id = 'notesTable';
    fresh.className = 'notes-table';
    host.replaceChildren(fresh);
    elements.notesTable = fresh;
    return fresh;
}

function tableHeight() {
    const host = document.querySelector('#notesTableHost');
    const measured = host?.clientHeight || 0;
    return Math.max(280, Math.floor(measured || window.innerHeight - 264));
}

const tableColumnsEndpoint = '/api/table-columns';
const tableColumnsStorageKey = 'tableHiddenProperties';

function normalizeHiddenColumns(values) {
    if (!Array.isArray(values)) return [];
    const hidden = [];
    const seen = new Set();
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const key = value.trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        hidden.push(key);
    }
    return hidden;
}

function readStoredColumnPreferences() {
    try {
        return normalizeHiddenColumns(JSON.parse(localStorage.getItem(tableColumnsStorageKey) || '[]'));
    } catch {
        return [];
    }
}

// localStorage keeps a small offline mirror; the server is the source of
// truth so every browser sees the same columns.
function writeStoredColumnPreferences(hidden) {
    try {
        localStorage.setItem(tableColumnsStorageKey, JSON.stringify(hidden));
    } catch {
        // Private mode or a full quota should not break the table.
    }
}

let columnSaveChain = Promise.resolve();

async function loadTableColumnPreferences() {
    const stored = readStoredColumnPreferences();
    try {
        const payload = await requestJSON(tableColumnsEndpoint);
        const hidden = normalizeHiddenColumns(payload?.hidden);
        if (!payload?.configured && stored.length) {
            // Migrate the selection made before the preference moved to the
            // server, then keep using it until the save completes.
            state.tableHiddenProperties = new Set(stored);
            saveTableColumnPreferences();
            return;
        }
        state.tableHiddenProperties = new Set(hidden);
        writeStoredColumnPreferences(hidden);
    } catch {
        // An older server or a temporary failure should still leave the table
        // usable with the last selection known by this browser.
        state.tableHiddenProperties = new Set(stored);
    }
}

function saveTableColumnPreferences() {
    const hidden = normalizeHiddenColumns([...state.tableHiddenProperties]);
    writeStoredColumnPreferences(hidden);
    // Serialize saves so a fast sequence of clicks cannot reach the server
    // out of order and leave the older selection stored.
    columnSaveChain = columnSaveChain
        .catch(() => {})
        .then(async () => {
            try {
                await requestJSON(tableColumnsEndpoint, {
                    method: 'PUT',
                    body: JSON.stringify({ hidden })
                });
            } catch (error) {
                showMessage(`Não foi possível salvar as colunas da tabela: ${error.message}`, 'error');
            }
        });
    return columnSaveChain;
}

function renderTableColumnsMenu(propertyKeys) {
    if (!elements.tableColumnsPicker) return;
    elements.tableColumnsEmpty.hidden = propertyKeys.length > 0;
    elements.tableColumnsAll.disabled = propertyKeys.length === 0;
    elements.tableColumnsNone.disabled = propertyKeys.length === 0;
    elements.tableColumnsList.replaceChildren();
    const visibleCount = propertyKeys.filter(key => !state.tableHiddenProperties.has(key)).length;
    const label = propertyKeys.length
        ? `Colunas do frontmatter (${visibleCount} de ${propertyKeys.length} visíveis)`
        : 'Colunas do frontmatter';
    elements.tableColumnsToggle.title = label;
    elements.tableColumnsToggle.setAttribute('aria-label', label);
    elements.tableColumnsPicker.classList.toggle('has-hidden-columns', visibleCount < propertyKeys.length);
    for (const key of propertyKeys) {
        const label = document.createElement('label');
        label.className = 'table-columns-item';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.tableColumn = key;
        input.checked = !state.tableHiddenProperties.has(key);
        const text = document.createElement('span');
        text.textContent = key;
        label.append(input, text);
        elements.tableColumnsList.append(label);
    }
}

function tableAttachmentRow(note, attachment) {
    const values = [attachment.filename, attachment.media_type, formatFileSize(attachment.size)];
    return {
        kind: 'attachment',
        noteID: note.id,
        attachmentID: attachment.id,
        filename: attachment.filename,
        media_type: attachment.media_type,
        size: attachment.size,
        url: attachment.url,
        title: attachment.filename,
        folder: '',
        __search: values
    };
}

function renderTable() {
    if (state.table) {
        try {
            state.table.destroy();
        } catch {
            // The table may already be gone after a failed render.
        }
        state.table = null;
    }
    const container = resetTableContainer();
    if (!container) return;
    if (!window.Tabulator) {
        container.textContent = 'Não foi possível carregar o Tabulator.';
        return;
    }

    const propertyKeys = tablePropertyKeys(state.tableData);
    const visiblePropertyKeys = propertyKeys.filter(key => !state.tableHiddenProperties.has(key));
    renderTableColumnsMenu(propertyKeys);
    const rows = state.tableData.map(note => {
        const attachments = (note.attachments || []).map(attachment => tableAttachmentRow(note, attachment));
        const row = {
            kind: 'note',
            noteID: note.id,
            title: note.title,
            folder: note.folder || '',
            tags: note.tags || [],
            updated_at: note.updated_at || '',
            created_at: note.created_at || '',
            properties: note.properties || {},
            __search: []
        };
        for (const key of propertyKeys) row[tablePropertyField(key)] = row.properties[key] ?? null;
        if (attachments.length) row.children = attachments;
        fillTableRowSearch(row, note);
        return row;
    });

    const columns = [
        {
            title: 'Título',
            field: 'title',
            minWidth: 240,
            widthGrow: 3,
            formatter: tableTitleFormatter,
            sorter: tableTextSorter
        },
        {
            title: 'Pasta',
            field: 'folder',
            minWidth: 130,
            widthGrow: 1,
            formatter: tableFolderFormatter,
            sorter: tableTextSorter
        },
        {
            title: 'Tags',
            field: 'tags',
            minWidth: 170,
            widthGrow: 1.5,
            formatter: tablePropertyFormatter,
            editor: tableCellEditor,
            sorter: tablePropertySorter
        },
        ...visiblePropertyKeys.map(key => ({
            title: key,
            field: tablePropertyField(key),
            minWidth: 110,
            widthGrow: 1,
            formatter: tablePropertyFormatter,
            editor: tableCellEditor,
            sorter: tablePropertySorter
        })),
        {
            title: 'Atualizado',
            field: 'updated_at',
            minWidth: 140,
            widthGrow: 1,
            formatter: tableDateFormatter,
            sorter: tableTextSorter
        },
        {
            title: 'Ações',
            field: 'actions',
            width: 96,
            minWidth: 96,
            hozAlign: 'right',
            headerHozAlign: 'right',
            headerSort: false,
            resizable: false,
            formatter: tableActionsFormatter
        },
    ];

    state.table = new window.Tabulator(container, {
        data: rows,
        columns,
        height: tableHeight(),
        layout: 'fitDataStretch',
        rowHeight: 40,
        placeholder: 'Nenhuma nota encontrada.',
        movableColumns: false,
        resizableColumns: true,
        selectableRows: false,
        dataTree: true,
        dataTreeChildField: 'children',
        dataTreeElementColumn: 'title',
        dataTreeChildIndent: 18,
        dataTreeStartExpanded: false,
        dataTreeFilter: true,
        dataTreeSort: false,
        initialSort: [{ column: 'updated_at', dir: 'desc' }],
        editTriggerEvent: 'dblclick',
        rowFormatter: row => {
            const kind = row.getData().kind;
            row.getElement().classList.add(kind === 'attachment' ? 'is-attachment-row' : 'is-note-row');
        }
    });
    state.table.on('cellEdited', handleTableCellEdited);
    applyTableFilter();
}

function applyTableFilter() {
    if (!state.table) {
        updateTableSummary();
        return;
    }
    const query = elements.searchInput.value.trim();
    if (query) {
        const needle = normalizeTableSearch(query);
        state.table.setFilter(data => tableFilterRow(data, needle));
    } else {
        state.table.clearFilter();
    }
    updateTableSummary();
}

function updateTableSummary() {
    const query = elements.searchInput.value.trim();
    const needle = normalizeTableSearch(query);
    let notes = 0;
    let attachments = 0;
    for (const note of state.tableData) {
        const noteMatches = !needle || tableNoteMatches(note, needle);
        const matchingAttachments = (note.attachments || [])
            .filter(attachment => !needle || tableAttachmentMatches(attachment, needle));
        if (noteMatches || matchingAttachments.length) {
            notes++;
            attachments += matchingAttachments.length;
        }
    }
    const noteLabel = `${notes} ${notes === 1 ? 'nota' : 'notas'}`;
    const attachmentLabel = `${attachments} ${attachments === 1 ? 'anexo' : 'anexos'}`;
    elements.resultCount.textContent = `${noteLabel} · ${attachmentLabel}`;
}

function tableTextSorter(left, right) {
    return String(left ?? '').localeCompare(String(right ?? ''), 'pt-BR', { sensitivity: 'base' });
}

function tablePropertySorter(left, right) {
    return tableDisplayValue(left).localeCompare(tableDisplayValue(right), 'pt-BR', { sensitivity: 'base' });
}

function tableNoteIcon() {
    const icon = document.createElement('span');
    icon.className = 'table-cell-icon is-note';
    icon.innerHTML = tableIcons.note;
    return icon;
}

function tableFileIcon(filename) {
    const extension = String(filename || '').split('.').pop()?.toLocaleLowerCase() || '';
    const icon = document.createElement('span');
    icon.className = 'table-cell-icon';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp'].includes(extension)) {
        icon.classList.add('is-image');
        icon.innerHTML = tableIcons.image;
    } else if (extension === 'pdf') {
        icon.classList.add('is-pdf');
        icon.innerHTML = tableIcons.pdf;
    } else {
        icon.classList.add('is-text');
        icon.innerHTML = tableIcons.file;
    }
    return icon;
}

function tableTitleFormatter(cell) {
    const data = cell.getRow().getData();
    const wrapper = document.createElement('div');
    wrapper.className = 'table-title-cell';

    if (data.kind === 'attachment') {
        wrapper.append(tableFileIcon(data.filename));
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'table-note-link table-file-name';
        link.textContent = data.filename;
        link.title = data.filename;
        link.addEventListener('click', event => {
            event.stopPropagation();
            openTableAttachment(data);
        });
        const type = document.createElement('span');
        type.className = 'table-file-type';
        type.textContent = (data.filename.split('.').pop() || data.media_type.split('/').pop() || 'arquivo').toLocaleUpperCase();
        const size = document.createElement('span');
        size.className = 'table-file-size';
        size.textContent = formatFileSize(data.size);
        wrapper.append(link, type, size);
        return wrapper;
    }

    wrapper.append(tableNoteIcon());
    const copy = document.createElement('div');
    copy.className = 'table-title-copy';
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'table-note-link';
    link.textContent = data.title;
    link.title = data.title;
    link.addEventListener('click', event => {
        event.stopPropagation();
        void openNote(data.noteID);
    });
    const count = Array.isArray(data.children) ? data.children.length : 0;
    const subtitle = document.createElement('span');
    subtitle.className = 'table-note-sub';
    subtitle.textContent = count === 0
        ? 'sem anexos'
        : `${count} ${count === 1 ? 'anexo' : 'anexos'}`;
    copy.append(link, subtitle);
    wrapper.append(copy);
    return wrapper;
}

function tableFolderFormatter(cell) {
    const data = cell.getRow().getData();
    const wrapper = document.createElement('div');
    wrapper.className = 'table-folder-cell';
    if (data.kind === 'attachment') {
        const empty = document.createElement('span');
        empty.className = 'table-empty-value';
        empty.textContent = '—';
        wrapper.append(empty);
        return wrapper;
    }
    wrapper.innerHTML = tableIcons.folder;
    const label = document.createElement('span');
    label.textContent = data.folder || 'Raiz';
    label.title = data.folder || 'Raiz';
    if (!data.folder) label.className = 'table-empty-value';
    wrapper.append(label);
    return wrapper;
}

// Tabulator calls custom editors with the cell, a render hook and the success
// and cancel callbacks. A single text input keeps the interaction identical
// for tags and frontmatter properties: commas split list values, an empty
// value removes the property.
function tableCellEditor(cell, onRendered, success, cancel) {
    const field = cell.getField();
    const value = cell.getValue();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'table-cell-editor';
    input.value = field === 'tags'
        ? parseTableTags(value).join(', ')
        : tableDisplayValue(value);
    if (field === 'tags') {
        input.placeholder = 'tag1, tag2, …';
        input.title = 'Separe as tags por vírgula';
    }
    let finished = false;
    const finish = apply => {
        if (finished) return;
        finished = true;
        if (apply) success(input.value);
        else cancel();
    };
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            finish(true);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            finish(false);
        }
        event.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    onRendered(() => {
        input.focus();
        input.select();
    });
    return input;
}

function findTableNoteRow(noteID) {
    if (!state.table) return null;
    return state.table.getRows().find(row => {
        const data = row.getData();
        return data.kind === 'note' && data.noteID === noteID;
    }) || null;
}

function updateTableNoteCache(noteID, key, value) {
    const note = state.tableData.find(item => item.id === noteID);
    if (!note) return null;
    note.properties = { ...(note.properties || {}) };
    if (key === 'tags') {
        note.tags = Array.isArray(value) ? value : parseTableTags(value);
        if (note.tags.length) note.properties.tags = note.tags;
        else delete note.properties.tags;
    } else if (value === null) {
        delete note.properties[key];
    } else {
        note.properties[key] = value;
    }
    return note;
}

function refreshTableNoteRow(noteID) {
    const note = state.tableData.find(item => item.id === noteID);
    const row = findTableNoteRow(noteID);
    if (!note || !row) return;
    const data = row.getData();
    const patch = {
        tags: note.tags || [],
        updated_at: note.updated_at || data.updated_at || '',
        properties: note.properties || {}
    };
    for (const field of Object.keys(data)) {
        if (!field.startsWith(tablePropertyPrefix)) continue;
        const key = field.slice(tablePropertyPrefix.length);
        patch[field] = note.properties[key] ?? null;
    }
    fillTableRowSearch(data, note);
    patch.__search = data.__search;
    void row.update(patch);
}

function handleTableCellEdited(cell) {
    const data = cell.getRow().getData();
    if (data.kind !== 'note') return;
    const field = cell.getField();
    const previous = cell.getOldValue();
    let key;
    let value;
    if (field === 'tags') {
        key = 'tags';
        value = parseTableTags(cell.getValue());
        if (tableValuesEqual(value, parseTableTags(previous))) return;
    } else if (field.startsWith(tablePropertyPrefix)) {
        key = field.slice(tablePropertyPrefix.length);
        value = parseTablePropertyValue(cell.getValue(), previous);
        if (tableValuesEqual(value, previous ?? null)) return;
    } else {
        return;
    }
    updateTableNoteCache(data.noteID, key, value);
    refreshTableNoteRow(data.noteID);
    void queueTablePropertySave(data.noteID, key, value);
}

// Saves run one after another so editing two cells on the same note never
// races on the note version (each save reads, rewrites and PUTs the content).
let tableSaveQueue = Promise.resolve();

function queueTablePropertySave(noteID, key, value) {
    const job = tableSaveQueue.then(() => persistTableProperty(noteID, key, value));
    tableSaveQueue = job.catch(() => {});
    return job;
}

async function persistTableProperty(noteID, key, value) {
    try {
        const note = await requestJSON(`/api/notes/${noteID}`);
        const content = setFrontmatterProperty(note.content || '', key, value);
        const payload = {
            title: note.title,
            folder: note.folder || '',
            content,
            // Preserve tags stored only in the database; validateNote overrides
            // this with frontmatter tags when the content declares them.
            tags: Array.isArray(note.tags) ? note.tags : [],
            version: note.version
        };
        if (key === 'tags') {
            payload.tags = Array.isArray(value) ? value : parseTableTags(value);
        }
        const saved = await requestJSON(`/api/notes/${noteID}`, {
            method: 'PUT',
            body: JSON.stringify(payload)
        });
        const cached = state.tableData.find(item => item.id === noteID);
        if (cached) {
            cached.tags = Array.isArray(saved.tags) ? saved.tags : [];
            cached.updated_at = saved.updated_at || cached.updated_at;
            cached.properties = { ...(cached.properties || {}) };
            if (key === 'tags') {
                if (cached.tags.length) cached.properties.tags = cached.tags;
                else delete cached.properties.tags;
            }
            refreshTableNoteRow(noteID);
        }
        if (elements.searchInput.value.trim()) applyTableFilter();
        else updateTableSummary();
        if (key === 'tags') void loadTags();
    } catch (error) {
        const conflict = error.status === 409;
        showMessage(
            conflict
                ? 'A nota foi alterada em outra aba. A tabela foi recarregada com a versão mais recente.'
                : `Não foi possível salvar a alteração: ${error.message}`,
            'error'
        );
        invalidateTable();
        if (state.mode === 'table') void loadTable();
    }
}

function tablePropertyFormatter(cell) {
    const value = cell.getValue();
    if (Array.isArray(value)) {
        const list = document.createElement('div');
        list.className = 'table-tag-list';
        if (!value.length) {
            list.append(tableMutedValue('—'));
            return list;
        }
        for (const item of value) {
            const tag = document.createElement('span');
            const label = tableDisplayValue(item);
            tag.className = 'table-tag';
            tag.textContent = label;
            tag.title = label;
            list.append(tag);
        }
        return list;
    }
    const text = tableDisplayValue(value);
    if (!text) return tableMutedValue('—');
    const span = document.createElement('span');
    span.className = 'table-property-value';
    span.textContent = text;
    span.title = text;
    return span;
}

function tableDateFormatter(cell) {
    const data = cell.getRow().getData();
    if (data.kind === 'attachment') return tableMutedValue('');
    const value = cell.getValue();
    if (!value) return tableMutedValue('—');
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const parsed = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
    const label = Number.isNaN(parsed.getTime())
        ? value
        : parsed.toLocaleString('pt-BR', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    const span = document.createElement('span');
    span.className = 'table-property-value';
    span.textContent = label;
    span.title = value;
    return span;
}

function tableMutedValue(text) {
    const span = document.createElement('span');
    span.className = 'table-empty-value';
    span.textContent = text;
    return span;
}

function tableActionButton(label, icon, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'table-action';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon;
    button.addEventListener('click', onClick);
    return button;
}

function tableActionsFormatter(cell) {
    const data = cell.getRow().getData();
    const wrapper = document.createElement('div');
    wrapper.className = 'table-actions';
    if (data.kind === 'attachment') {
        wrapper.append(
            tableActionButton('Abrir anexo', tableIcons.open, event => {
                event.stopPropagation();
                openTableAttachment(data);
            }),
            tableActionButton('Baixar anexo', tableIcons.download, event => {
                event.stopPropagation();
                downloadTableAttachment(data);
            })
        );
        return wrapper;
    }
    const count = Array.isArray(data.children) ? data.children.length : 0;
    if (count) {
        const badge = document.createElement('span');
        badge.className = 'table-attachment-count';
        badge.title = `${count} ${count === 1 ? 'anexo' : 'anexos'}`;
        badge.innerHTML = tableIcons.paperclip;
        badge.append(document.createTextNode(String(count)));
        wrapper.append(badge);
    }
    return wrapper;
}

function openTableAttachment(data) {
    window.open(`${data.url}?inline=1`, '_blank', 'noopener');
}

function downloadTableAttachment(data) {
    const link = document.createElement('a');
    link.href = data.url;
    link.download = data.filename;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
}



    return {
        load: loadTable,
        applyFilter: applyTableFilter,
        render: renderTable,
        invalidate: invalidateTable,
        resize() {
            if (state.table && state.mode === 'table') state.table.setHeight(tableHeight());
        },
        loadColumnPreferences: loadTableColumnPreferences,
        saveColumnPreferences: saveTableColumnPreferences,
        updateFooter: updateTableFooter,
        removeAttachment: removeAttachmentFromTable
    };
}
