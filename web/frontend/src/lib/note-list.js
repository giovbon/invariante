import { iconHTML } from './icons.js';

// Rendering for the search/list view. It owns no navigation state: callbacks
// for opening/deleting notes stay in main.js, while the markup and skeleton
// helpers can be tested and reused independently.
export function skeletonLines(count) {
    return Array.from({ length: count }, () => {
        const line = document.createElement('span');
        line.className = 'skeleton skeleton-line';
        line.setAttribute('aria-hidden', 'true');
        return line;
    });
}

export function createNoteListView({
    state,
    elements,
    requestJSON,
    showMessage,
    renderTagFilter
}) {
function formatResultTotal(page) {
    return page.total_capped ? `${page.total}+` : String(page.total);
}

function renderNotes(page) {
    elements.notesList.replaceChildren();
    const query = elements.searchInput.value.trim();
    const tagLabel = state.tag ? `#${state.tag}` : '';
    if (query) {
        elements.resultsTitle.textContent = tagLabel
            ? `Resultados para “${query}” em ${tagLabel}`
            : `Resultados para “${query}”`;
    } else if (tagLabel) {
        elements.resultsTitle.textContent = `Notas com ${tagLabel}`;
    } else {
        elements.resultsTitle.textContent = state.folder ? state.folder.split('/').at(-1) : 'Todas as notas';
    }
    const totalLabel = formatResultTotal(page);
    elements.resultCount.textContent = `${totalLabel} ${page.total === 1 && !page.total_capped ? 'nota' : 'notas'}`;
    if (state.view === 'list') {
        document.querySelector('#currentFolder').textContent = state.folder || 'Todas as notas';
    }
    elements.clearFolder.hidden = !state.folder;
    elements.clearTag.hidden = !state.tag;
    if (page.items.length === 0) {
        elements.notesList.append(createEmptyState({
            query,
            tag: state.tag,
            folder: state.folder
        }));
    } else {
        const contentSearch = Boolean(query && state.mode === 'content');
        for (const note of page.items) elements.notesList.append(createNoteCard(note, contentSearch, query));
    }
    renderTagFilter();
    const first = page.total === 0 ? 0 : page.offset + 1;
    const last = Math.min(page.offset + page.items.length, page.total);
    elements.pagination.hidden = page.total <= page.limit;
    elements.pageStatus.textContent = `${first}–${last} de ${totalLabel}`;
    elements.previousPage.disabled = page.offset === 0;
    elements.nextPage.disabled = page.offset + page.limit >= page.total;
}

function createEmptyState({ query, tag, folder }) {
    const wrapper = document.createElement('div');
    wrapper.className = 'empty-state';

    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('h3');
    const text = document.createElement('p');
    const actions = document.createElement('div');
    actions.className = 'empty-actions';

    if (query) {
        icon.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
        title.textContent = 'Nada encontrado';
        text.textContent = `Não encontramos notas para “${query}”. Tente outro termo ou limpe os filtros.`;
        actions.append(
            emptyAction('Limpar filtros', 'muted', 'clear'),
            emptyAction('Nova nota', 'primary', 'new')
        );
    } else if (tag) {
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8.5" cy="8.5" r="1.3"/></svg>';
        title.textContent = `Nenhuma nota com #${tag}`;
        text.textContent = 'Remova o filtro de tag ou crie uma nota com esta tag para começar.';
        actions.append(
            emptyAction('Limpar filtros', 'muted', 'clear'),
            emptyAction('Nova nota', 'primary', 'new')
        );
    } else if (folder) {
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 8.5v-2a2 2 0 0 1 2-2h3l2 2"/></svg>';
        title.textContent = 'Esta pasta está vazia';
        text.textContent = 'Crie uma nota aqui ou mova uma nota existente para esta pasta.';
        actions.append(
            emptyAction('Nova nota', 'primary', 'new'),
            emptyAction('Limpar filtros', 'ghost', 'clear')
        );
    } else {
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 2.5h8l4.5 4.5v15H5z"/><path d="M13 2.5V7h4.5M8 11h7m-7 3.5h7"/></svg>';
        title.textContent = 'Seu espaço para pensar';
        text.textContent = 'Crie sua primeira nota ou explore o grafo de relações. Tudo fica salvo localmente.';
        actions.append(
            emptyAction('Nova nota', 'primary', 'new'),
            emptyAction('Explorar grafo', 'ghost', 'graph')
        );
    }

    wrapper.append(icon, title, text, actions);
    return wrapper;
}

function emptyAction(label, variant, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button';
    button.dataset.variant = variant;
    button.dataset.emptyAction = action;
    button.textContent = label;
    return button;
}

function renderNoteSkeletons() {
    elements.notesList.replaceChildren();
    for (let index = 0; index < 4; index++) {
        const card = document.createElement('div');
        card.className = 'skeleton-card';
        card.setAttribute('aria-hidden', 'true');
        const title = document.createElement('span');
        title.className = 'skeleton skeleton-line is-title';
        const preview = document.createElement('span');
        preview.className = 'skeleton skeleton-line';
        preview.style.width = `${68 + index * 5}%`;
        const meta = document.createElement('span');
        meta.className = 'skeleton skeleton-line is-short';
        card.append(title, preview, meta);
        elements.notesList.append(card);
    }
}


function createNoteCard(note, contentSearch, query = '') {
    const card = document.createElement('article');
    card.className = `note-card card${contentSearch ? ' is-content-result' : ''}`;
    card.dataset.noteId = String(note.id);
    if (contentSearch) card.dataset.searchQuery = query;
    const main = document.createElement('button');
    main.className = 'note-card-main';
    main.type = 'button';
    main.dataset.action = 'open';
    const title = document.createElement('span');
    title.className = 'note-title';
    title.textContent = note.title;
    main.append(title);
    if (contentSearch) {
        const preview = document.createElement('span');
        preview.className = 'note-preview';
        const snippets = Array.isArray(note.snippets) && note.snippets.length
            ? note.snippets
            : [note.preview || 'Nenhum trecho disponível.'];
        for (const value of snippets) {
            const snippet = document.createElement('span');
            snippet.className = 'note-preview-snippet';
            appendHighlightedPreview(snippet, value);
            preview.append(snippet);
        }
        main.append(preview);
    }
    const info = document.createElement('div');
    info.className = 'note-meta';
    const tags = document.createElement('div');
    tags.className = 'note-tags';
    for (const value of note.tags || []) {
        const tag = document.createElement('button');
        tag.type = 'button';
        tag.className = `note-tag${value.toLowerCase() === state.tag.toLowerCase() ? ' is-active' : ''}`;
        tag.dataset.action = 'tag';
        tag.dataset.tag = value;
        tag.title = `Filtrar por #${value}`;
        tag.textContent = `#${value}`;
        tags.append(tag);
    }
    if (tags.childElementCount) info.append(tags);
    if (note.folder) {
        const folder = document.createElement('span');
        folder.className = 'note-folder';
        folder.title = note.folder;
        folder.innerHTML = iconHTML('folder');
        const label = document.createElement('span');
        label.textContent = note.folder;
        folder.append(label);
        info.append(folder);
    }
    if (contentSearch && note.occurrences > 1) {
        const occurrences = document.createElement('button');
        occurrences.type = 'button';
        occurrences.className = 'note-hit-count note-occurrences-toggle';
        occurrences.dataset.action = 'occurrences';
        occurrences.dataset.count = String(note.occurrences);
        occurrences.setAttribute('aria-expanded', 'false');
        occurrences.title = `Ver todas as ${note.occurrences} ocorrências nesta nota`;
        occurrences.innerHTML = `<span>${note.occurrences} ocorrências</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
        info.append(occurrences);
    }
    const actions = document.createElement('div');
    actions.className = 'note-actions';
    const remove = document.createElement('button');
    remove.className = 'icon-button danger-hover';
    remove.type = 'button';
    remove.dataset.action = 'delete';
    remove.setAttribute('aria-label', `Excluir ${note.title}`);
    remove.title = 'Excluir';
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>';
    actions.append(remove);
    card.append(main);
    if (info.childElementCount) card.append(info);
    card.append(actions);
    return card;
}

function appendHighlightedPreview(container, text) {
    const startMarker = '<mark>';
    const endMarker = '</mark>';
    let remaining = text;
    while (remaining) {
        const start = remaining.indexOf(startMarker);
        if (start < 0) {
            container.append(document.createTextNode(remaining));
            break;
        }
        if (start > 0) container.append(document.createTextNode(remaining.slice(0, start)));
        const contentStart = start + startMarker.length;
        const end = remaining.indexOf(endMarker, contentStart);
        if (end < 0) {
            container.append(document.createTextNode(remaining.slice(start)));
            break;
        }
        const highlight = document.createElement('mark');
        highlight.textContent = remaining.slice(contentStart, end);
        container.append(highlight);
        remaining = remaining.slice(end + endMarker.length);
    }
}

async function toggleNoteOccurrences(card, toggle) {
    const expanded = card.classList.toggle('is-expanded');
    toggle.setAttribute('aria-expanded', String(expanded));
    const count = toggle.dataset.count || '';
    toggle.title = expanded ? 'Recolher ocorrências' : `Ver todas as ${count} ocorrências nesta nota`;
    if (!expanded || card.dataset.occurrencesLoaded === 'true') return;
    const query = card.dataset.searchQuery || elements.searchInput.value.trim();
    if (!query) return;
    card.dataset.occurrencesLoading = 'true';
    toggle.setAttribute('aria-busy', 'true');
    try {
        const id = Number(card.dataset.noteId);
        const params = new URLSearchParams({ q: query });
        const payload = await requestJSON(`/api/notes/${id}/occurrences?${params}`);
        const snippets = Array.isArray(payload.snippets) ? payload.snippets : [];
        const preview = card.querySelector('.note-preview');
        if (preview && snippets.length) {
            preview.replaceChildren();
            for (const value of snippets) {
                const snippet = document.createElement('span');
                snippet.className = 'note-preview-snippet';
                appendHighlightedPreview(snippet, value);
                preview.append(snippet);
            }
        }
        card.dataset.occurrencesLoaded = 'true';
    } catch (error) {
        card.classList.remove('is-expanded');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.title = `Ver todas as ${count} ocorrências nesta nota`;
        showMessage(`Não foi possível carregar as ocorrências: ${error.message}`, 'error');
    } finally {
        delete card.dataset.occurrencesLoading;
        toggle.removeAttribute('aria-busy');
    }
}



    return {
        render: renderNotes,
        renderSkeletons: renderNoteSkeletons,
        toggleOccurrences: toggleNoteOccurrences
    };
}
