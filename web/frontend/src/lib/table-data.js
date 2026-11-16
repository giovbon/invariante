import { formatFileSize } from './format.js';

// Pure data helpers for the table view. Tabulator formatters/editors stay in
// main.js because they need the DOM; search, comparison and display rules are
// easier to test (and easier to reuse) as plain functions.

export function normalizeTableSearch(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase();
}

export function flattenTableSearchValues(value, output) {
    if (value === null || value === undefined || value === '') return;
    if (Array.isArray(value)) {
        for (const item of value) flattenTableSearchValues(item, output);
        return;
    }
    if (typeof value === 'object') {
        for (const item of Object.values(value)) flattenTableSearchValues(item, output);
        return;
    }
    output.push(String(value));
}

export function tableNoteMatches(note, needle) {
    const values = [note.title, note.folder];
    flattenTableSearchValues(note.tags, values);
    for (const value of Object.values(note.properties || {})) flattenTableSearchValues(value, values);
    return values.some(value => normalizeTableSearch(value).includes(needle));
}

export function tableAttachmentMatches(attachment, needle) {
    return [attachment.filename, attachment.media_type, formatFileSize(attachment.size)]
        .some(value => normalizeTableSearch(value).includes(needle));
}

export function tableFilterRow(data, needle) {
    const values = data.__search || [];
    if (values.some(value => normalizeTableSearch(value).includes(needle))) return true;
    if (data.kind === 'note' && Array.isArray(data.children)) {
        return data.children.some(child => tableFilterRow(child, needle));
    }
    return false;
}

export function tablePropertyKeys(notes) {
    const keys = new Set();
    for (const note of notes) {
        for (const key of Object.keys(note.properties || {})) {
            if (key !== 'tags') keys.add(key);
        }
    }
    return [...keys].sort((left, right) => left.localeCompare(right, 'pt-BR'));
}

export function tableDisplayValue(value) {
    if (value === null || value === undefined || value === '') return '';
    if (Array.isArray(value)) return value.map(tableDisplayValue).join(', ');
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
    return String(value);
}

export function tableValuesEqual(left, right) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function parseTableTags(value) {
    const source = Array.isArray(value) ? value : String(value ?? '').split(',');
    const tags = [];
    const seen = new Set();
    for (const item of source) {
        const tag = String(item ?? '').trim();
        if (!tag) continue;
        const key = tag.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push(tag);
    }
    return tags;
}

export function parseTablePropertyValue(value, previous) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (Array.isArray(previous)) {
        return text.split(',').map(item => item.trim()).filter(Boolean);
    }
    if (typeof previous === 'number') {
        const parsed = Number(text.replace(',', '.'));
        return Number.isFinite(parsed) ? parsed : text;
    }
    if (typeof previous === 'boolean') {
        const normalized = normalizeTableSearch(text);
        if (['sim', 'true', 'verdadeiro', '1'].includes(normalized)) return true;
        if (['nao', 'false', 'falso', '0'].includes(normalized)) return false;
        return text;
    }
    if (previous && typeof previous === 'object') {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }
    return text;
}

export function fillTableRowSearch(row, note) {
    const values = [];
    flattenTableSearchValues(note.title, values);
    flattenTableSearchValues(note.folder, values);
    flattenTableSearchValues(note.tags, values);
    flattenTableSearchValues(note.properties, values);
    for (const child of row.children || []) {
        if (Array.isArray(child.__search)) values.push(...child.__search);
    }
    row.__search = values;
}
