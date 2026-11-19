import { DEFAULT_TASK_MARKERS } from './markdown-editor.js';

const taskPageSize = 250;

// Task extraction is server-side, but loading, pagination, marker settings and
// sidebar rendering belong together on the client. This factory keeps the
// timers and marker parsing out of the main navigation module.
export function createTasksPanel({
    state,
    elements,
    requestJSON,
    showMessage,
    syncMarkdownHighlight,
    skeletonLines
}) {
    let tasksRefreshTimer = null;
function parseTaskMarkers(value) {
    const markers = [];
    const seen = new Set();
    for (const raw of String(value ?? '').split(/[\s,;]+/)) {
        const marker = raw.replace(/:+$/, '').trim();
        if (!marker) continue;
        if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(marker)) {
            return { error: `Marcador de tarefa inválido: “${raw}”. Use apenas letras maiúsculas, números, hífen e sublinhado.` };
        }
        if (seen.has(marker)) continue;
        seen.add(marker);
        markers.push(marker);
    }
    if (markers.length > 20) return { error: 'Use no máximo 20 marcadores de tarefa.' };
    return { markers: markers.length ? markers : [...DEFAULT_TASK_MARKERS] };
}

async function loadTaskMarkersSetting() {
    let fallback = null;
    const stored = localStorage.getItem('taskMarkers');
    if (stored) {
        const parsed = parseTaskMarkers(stored);
        if (!parsed.error) fallback = parsed.markers;
    }
    try {
        const data = await requestJSON('/api/task-markers');
        if (!Array.isArray(data?.markers)) throw new Error('resposta de marcadores inválida');
        const parsed = parseTaskMarkers(data.markers.join(','));
        if (parsed.error) throw new Error(parsed.error);
        state.taskMarkers = parsed.markers;
        localStorage.setItem('taskMarkers', state.taskMarkers.join(','));
    } catch (error) {
        if (fallback) state.taskMarkers = fallback;
    }
    syncMarkdownHighlight();
}

async function saveTaskMarkers(input, button) {
    const parsed = parseTaskMarkers(input.value);
    if (parsed.error) {
        input.setAttribute('aria-invalid', 'true');
        showMessage(parsed.error, 'error');
        input.focus();
        return;
    }
    input.removeAttribute('aria-invalid');
    button.disabled = true;
    try {
        const data = await requestJSON('/api/task-markers', {
            method: 'PUT',
            body: JSON.stringify({ markers: parsed.markers })
        });
        if (!Array.isArray(data?.markers)) throw new Error('resposta de marcadores inválida');
        const saved = parseTaskMarkers(data.markers.join(','));
        if (saved.error) throw new Error(saved.error);
        state.taskMarkers = saved.markers;
        input.value = state.taskMarkers.join(', ');
        localStorage.setItem('taskMarkers', state.taskMarkers.join(','));
        syncMarkdownHighlight();
        await loadTasks();
        showMessage('Marcadores de tarefa atualizados.', 'success');
    } catch (error) {
        showMessage(`Não foi possível salvar os marcadores: ${error.message}`, 'error');
    } finally {
        button.disabled = false;
    }
}

function updateTasksCount() {
    const count = state.tasks?.total || 0;
    elements.tasksCount.textContent = count > 9 ? '9+' : String(count);
    elements.tasksCount.hidden = count === 0;
    const label = count ? `Tarefas (${count})` : 'Abrir tarefas';
    document.querySelector('#tasksButton').title = label;
    document.querySelector('#tasksButton').setAttribute('aria-label', label);
}

// Refreshing tasks scans every note, so autosaves coalesce into one request
// instead of starting a full scan on each keystroke pause. The scan also only
// runs while the Tasks panel is visible: keeping the badge fresh while typing
// was costing a full-library scan every few seconds.
function scheduleTasksRefresh() {
    if (elements.panel.dataset.panel !== 'tasks') return;
    window.clearTimeout(tasksRefreshTimer);
    tasksRefreshTimer = window.setTimeout(() => {
        tasksRefreshTimer = null;
        void loadTasks();
    }, 1500);
}

async function loadTasks(more = false) {
    const requestID = ++state.tasksRequestID;
    state.tasksLoading = true;
    state.tasksError = '';
    const offset = more && state.tasks ? state.tasks.items.length : 0;
    if (elements.panel.dataset.panel === 'tasks') renderTasksPanel();
    try {
        const params = new URLSearchParams({
            markers: state.taskMarkers.join(','),
            limit: String(taskPageSize),
            offset: String(offset)
        });
        const data = await requestJSON(`/api/tasks?${params.toString()}`);
        if (requestID !== state.tasksRequestID) return;
        if (!Array.isArray(data?.items)) throw new Error('resposta de tarefas inválida');
        if (more && state.tasks && offset === state.tasks.items.length) {
            data.items = [...state.tasks.items, ...data.items];
        }
        state.tasks = data;
    } catch (error) {
        if (requestID !== state.tasksRequestID) return;
        state.tasksError = error.message;
    } finally {
        if (requestID === state.tasksRequestID) {
            state.tasksLoading = false;
            updateTasksCount();
            if (elements.panel.dataset.panel === 'tasks') renderTasksPanel();
        }
    }
}

function renderTasksPanel() {
    elements.panelContent.replaceChildren();
    if (state.tasksLoading && !state.tasks) {
        const loading = document.createElement('div');
        loading.className = 'tasks-panel-empty';
        loading.setAttribute('aria-label', 'Carregando tarefas');
        loading.append(...skeletonLines(3));
        elements.panelContent.append(loading);
        return;
    }
    if (state.tasksError && !state.tasks) {
        const error = document.createElement('div');
        error.className = 'tasks-panel-empty';
        const message = document.createElement('p');
        message.textContent = 'Não foi possível carregar as tarefas.';
        const detail = document.createElement('small');
        detail.textContent = state.tasksError;
        error.append(message, detail);
        elements.panelContent.append(error);
        return;
    }
    if (!state.tasks || state.tasks.total === 0) {
        const empty = document.createElement('div');
        empty.className = 'tasks-panel-empty';
        const message = document.createElement('p');
        message.textContent = 'Nenhuma tarefa encontrada.';
        empty.append(message);
        const hint = document.createElement('small');
        hint.textContent = `Marcadores ativos: ${state.taskMarkers.join(', ')}. Use, por exemplo, “TODO: revisar”.`;
        empty.append(hint);
        elements.panelContent.append(empty);
        return;
    }

    const groups = new Map();
    for (const task of state.tasks.items) {
        if (!groups.has(task.note_id)) groups.set(task.note_id, []);
        groups.get(task.note_id).push(task);
    }

    const summary = document.createElement('p');
    summary.className = 'tasks-summary';
    const noteCount = groups.size;
    summary.textContent = `${state.tasks.total} ${state.tasks.total === 1 ? 'tarefa' : 'tarefas'} em ` +
        `${noteCount} ${noteCount === 1 ? 'nota' : 'notas'}`;
    elements.panelContent.append(summary);

    if (state.tasksError) {
        const warning = document.createElement('p');
        warning.className = 'tasks-warning';
        warning.textContent = 'A lista pode estar desatualizada.';
        elements.panelContent.append(warning);
    }

    for (const tasks of groups.values()) {
        const note = tasks[0];
        const group = document.createElement('section');
        group.className = 'task-group';

        const header = document.createElement('div');
        header.className = 'task-group-header';
        const title = document.createElement('span');
        title.className = 'task-group-title';
        title.textContent = note.note_title;
        title.title = note.folder ? `${note.folder}/${note.note_title}` : note.note_title;
        header.append(title);
        if (note.folder) {
            const folder = document.createElement('span');
            folder.className = 'task-group-folder';
            folder.textContent = note.folder;
            header.append(folder);
        }
        group.append(header);

        const list = document.createElement('div');
        list.className = 'task-items';
        for (const task of tasks) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'task-item';
            item.dataset.taskNote = String(task.note_id);
            item.dataset.taskLine = String(task.line);
            item.dataset.taskFolder = task.folder || '';
            item.title = `${note.folder ? `${note.folder}/` : ''}${note.note_title} · linha ${task.line}`;

            const marker = document.createElement('span');
            marker.className = 'task-marker';
            marker.dataset.marker = task.marker;
            marker.textContent = task.marker;

            const text = document.createElement('span');
            text.className = 'task-text';
            text.textContent = task.text || 'Sem descrição';
            if (!task.text) text.classList.add('is-empty');

            const line = document.createElement('span');
            line.className = 'task-line';
            line.textContent = `L${task.line}`;

            item.append(marker, text, line);
            list.append(item);
        }
        group.append(list);
        elements.panelContent.append(group);
    }

    if (state.tasks.items.length < state.tasks.total) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'button tasks-more';
        more.dataset.variant = 'muted';
        more.disabled = state.tasksLoading;
        more.textContent = state.tasksLoading
            ? 'Carregando…'
            : `Carregar mais (${state.tasks.total - state.tasks.items.length})`;
        more.addEventListener('click', () => void loadTasks(true));
        elements.panelContent.append(more);
    }
}



    return {
        parseMarkers: parseTaskMarkers,
        loadMarkers: loadTaskMarkersSetting,
        saveMarkers: saveTaskMarkers,
        updateCount: updateTasksCount,
        scheduleRefresh: scheduleTasksRefresh,
        load: loadTasks,
        render: renderTasksPanel
    };
}
