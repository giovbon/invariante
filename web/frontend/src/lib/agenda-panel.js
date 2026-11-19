import {
    agendaWeekLabel,
    formatAgendaDate,
    formatAgendaItemDate,
    parseAgendaInput,
    startOfAgendaWeek
} from './agenda-date.js';

// The agenda panel combines the free-text parser with a compact list grouped
// by week. Loading and mutations live here so main.js only has to open the
// panel and render it.
export function createAgendaPanel({ elements, requestJSON, showMessage, skeletonLines }) {
    let events = null;
    let error = '';
    let loading = false;
    let requestID = 0;
    let saving = false;
    let form = null;
    let input = null;
    let preview = null;
    let saveButton = null;
    let list = null;
    let parsed = null;

    function render() {
        elements.panelContent.replaceChildren();
        const container = document.createElement('div');
        container.className = 'agenda-panel';

        form = document.createElement('form');
        form.className = 'agenda-form';
        form.noValidate = true;

        const label = document.createElement('label');
        label.className = 'sr-only';
        label.htmlFor = 'agendaInput';
        label.textContent = 'Novo apontamento';

        input = document.createElement('input');
        input.type = 'text';
        input.id = 'agendaInput';
        input.className = 'settings-input agenda-input';
        input.autocomplete = 'off';
        input.maxLength = 500;
        input.placeholder = 'Ex.: dentista sexta 15h';
        input.addEventListener('input', updatePreview);

        preview = document.createElement('p');
        preview.className = 'agenda-preview';
        preview.dataset.state = 'hint';

        saveButton = document.createElement('button');
        saveButton.type = 'submit';
        saveButton.className = 'button agenda-submit';
        saveButton.dataset.variant = 'primary';
        saveButton.textContent = 'Adicionar';
        saveButton.disabled = true;

        form.append(label, input, preview, saveButton);
        form.addEventListener('submit', handleSubmit);

        list = document.createElement('div');
        list.className = 'agenda-list';

        container.append(form, list);
        elements.panelContent.append(container);
        parsed = null;
        updatePreview();
        renderList();
    }

    function updatePreview() {
        if (!input || !preview || !saveButton) return;
        const value = input.value.trim();
        parsed = null;
        if (!value) {
            preview.dataset.state = 'hint';
            preview.textContent = 'Escreva o compromisso junto com a data.';
            saveButton.disabled = true;
            return;
        }
        const result = parseAgendaInput(value);
        if (result.error) {
            parsed = null;
            preview.dataset.state = 'error';
            preview.textContent = result.error;
            saveButton.disabled = true;
            return;
        }
        parsed = result;
        preview.dataset.state = 'ok';
        preview.textContent = `${formatAgendaDate(result.date)} — ${result.title}`;
        saveButton.disabled = false;
    }

    async function handleSubmit(event) {
        event.preventDefault();
        if (saving) return;
        updatePreview();
        if (!parsed) return;
        saving = true;
        saveButton.disabled = true;
        saveButton.textContent = 'Adicionando…';
        try {
            await requestJSON('/api/agenda', {
                method: 'POST',
                body: JSON.stringify({
                    title: parsed.title,
                    event_at: parsed.date.toISOString()
                })
            });
            if (input) input.value = '';
            parsed = null;
            updatePreview();
            if (input) input.focus();
            showMessage('Apontamento adicionado.', 'success');
            await load();
        } catch (failure) {
            showMessage(`Não foi possível adicionar o apontamento: ${failure.message}`, 'error');
        } finally {
            saving = false;
            if (saveButton) {
                saveButton.textContent = 'Adicionar';
                saveButton.disabled = !parsed;
            }
        }
    }

    async function load() {
        const currentRequest = ++requestID;
        loading = true;
        error = '';
        renderList();
        try {
            const data = await requestJSON('/api/agenda');
            if (currentRequest !== requestID) return;
            if (!Array.isArray(data?.items)) throw new Error('resposta de agenda inválida');
            events = data.items;
        } catch (failure) {
            if (currentRequest !== requestID) return;
            error = failure.message;
        } finally {
            if (currentRequest === requestID) {
                loading = false;
                updateCount();
                renderList();
            }
        }
    }

    function updateCount() {
        if (!elements.agendaCount) return;
        const now = Date.now();
        const count = (events || []).filter(event =>
            !event.done && new Date(event.event_at).getTime() >= now
        ).length;
        elements.agendaCount.textContent = count > 9 ? '9+' : String(count);
        elements.agendaCount.hidden = count === 0;
        const button = document.querySelector('#agendaButton');
        if (!button) return;
        const label = count ? `Agenda (${count})` : 'Abrir agenda';
        button.title = label;
        button.setAttribute('aria-label', label);
    }

    function renderList() {
        if (!list) return;
        list.replaceChildren();
        if (loading && !events) {
            const placeholder = document.createElement('div');
            placeholder.className = 'agenda-empty';
            placeholder.setAttribute('aria-label', 'Carregando agenda');
            placeholder.append(...skeletonLines(3));
            list.append(placeholder);
            return;
        }
        if (error && !events) {
            const failure = document.createElement('div');
            failure.className = 'agenda-empty';
            const message = document.createElement('p');
            message.textContent = 'Não foi possível carregar a agenda.';
            const detail = document.createElement('small');
            detail.textContent = error;
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'button';
            retry.dataset.variant = 'muted';
            retry.textContent = 'Tentar novamente';
            retry.addEventListener('click', () => void load());
            failure.append(message, detail, retry);
            list.append(failure);
            return;
        }
        if (!events || events.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'agenda-empty';
            const message = document.createElement('p');
            message.textContent = 'Nenhum apontamento ainda.';
            const hint = document.createElement('small');
            hint.textContent = 'Escreva algo como “dentista sexta 15h” ou “reunião dia 24 às 9h”.';
            empty.append(message, hint);
            list.append(empty);
            return;
        }

        const now = new Date();
        const groups = new Map();
        for (const event of events) {
            const when = new Date(event.event_at);
            if (Number.isNaN(when.getTime())) continue;
            const weekStart = startOfAgendaWeek(when);
            const key = weekStart.getTime();
            if (!groups.has(key)) groups.set(key, { start: weekStart, items: [] });
            groups.get(key).items.push({ event, when });
        }
        const currentWeek = startOfAgendaWeek(now).getTime();
        const ordered = [...groups.values()].sort((left, right) => left.start - right.start);
        const upcomingWeeks = ordered.filter(group => group.start.getTime() >= currentWeek);
        const pastWeeks = ordered.filter(group => group.start.getTime() < currentWeek).reverse();

        const summary = document.createElement('p');
        summary.className = 'agenda-summary';
        const pending = events.filter(event => !event.done).length;
        summary.textContent = `${events.length} ${events.length === 1 ? 'apontamento' : 'apontamentos'}` +
            (pending === events.length ? '' : ` · ${pending} em aberto`);
        list.append(summary);

        for (const group of upcomingWeeks) appendGroup(group, now, false);
        if (pastWeeks.length > 0) {
            const divider = document.createElement('p');
            divider.className = 'agenda-divider';
            divider.textContent = 'Semanas anteriores';
            list.append(divider);
            for (const group of pastWeeks) appendGroup(group, now, true);
        }
    }

    function appendGroup(group, now, isPastWeek) {
        const section = document.createElement('section');
        section.className = 'agenda-group';
        if (isPastWeek) section.classList.add('is-past');

        const header = document.createElement('h3');
        header.className = 'agenda-group-title';
        header.textContent = agendaWeekLabel(group.start, now);
        section.append(header);

        const items = document.createElement('div');
        items.className = 'agenda-items';
        const sorted = [...group.items].sort((left, right) => left.when - right.when);
        for (const item of sorted) items.append(renderItem(item.event, item.when, now));
        section.append(items);
        list.append(section);
    }

    function renderItem(event, when, now) {
        const item = document.createElement('div');
        item.className = 'agenda-item';
        if (event.done) item.classList.add('is-done');
        if (when < now) item.classList.add('is-past');

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'agenda-check';
        checkbox.checked = Boolean(event.done);
        checkbox.setAttribute('aria-label', `Concluir ${event.title}`);
        checkbox.addEventListener('change', () => void toggleDone(event, checkbox));

        const body = document.createElement('div');
        body.className = 'agenda-item-body';
        const title = document.createElement('span');
        title.className = 'agenda-item-title';
        title.textContent = event.title;
        title.title = event.title;
        const date = document.createElement('span');
        date.className = 'agenda-item-date';
        date.textContent = formatAgendaItemDate(when, now);
        body.append(title, date);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'agenda-delete';
        remove.setAttribute('aria-label', `Excluir ${event.title}`);
        remove.title = 'Excluir apontamento';
        remove.textContent = '×';
        remove.addEventListener('click', () => void removeEvent(event));

        item.append(checkbox, body, remove);
        return item;
    }

    async function toggleDone(event, checkbox) {
        const next = checkbox.checked;
        checkbox.disabled = true;
        try {
            const updated = await requestJSON(`/api/agenda/${event.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ done: next })
            });
            event.done = Boolean(updated?.done);
            updateCount();
            renderList();
        } catch (failure) {
            checkbox.checked = !next;
            checkbox.disabled = false;
            showMessage(`Não foi possível atualizar o apontamento: ${failure.message}`, 'error');
        }
    }

    async function removeEvent(event) {
        if (!window.confirm(`Excluir “${event.title}”?`)) return;
        try {
            await requestJSON(`/api/agenda/${event.id}`, { method: 'DELETE' });
            showMessage('Apontamento excluído.', 'success');
            await load();
        } catch (failure) {
            showMessage(`Não foi possível excluir o apontamento: ${failure.message}`, 'error');
        }
    }

    function focus() {
        if (input) input.focus();
    }

    return {
        render,
        load,
        updateCount,
        focus
    };
}
