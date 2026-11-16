import { highlightCode } from './syntax-highlight.js';
import { matchSnippet } from './snippets.js';

function replaceSelection(value, start, end, before, after = before, placeholder = '') {
    const selected = value.slice(start, end) || placeholder;
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    const selectionStart = start + before.length;
    return {
        value: next,
        start: selectionStart,
        end: selectionStart + selected.length
    };
}

function changeLines(value, start, end, transform) {
    const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const lineEndIndex = value.indexOf('\n', end);
    const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
    const lines = value.slice(lineStart, lineEnd).split('\n');
    let removedFromFirst = 0;
    let addedToFirst = 0;
    let lengthDelta = 0;
    const changed = lines.map((line, index) => {
        const next = transform(line);
        const delta = next.length - line.length;
        lengthDelta += delta;
        if (index === 0) {
            removedFromFirst = Math.max(0, -delta);
            addedToFirst = Math.max(0, delta);
        }
        return next;
    }).join('\n');
    const nextValue = `${value.slice(0, lineStart)}${changed}${value.slice(lineEnd)}`;
    return {
        value: nextValue,
        start: Math.max(lineStart, start - removedFromFirst) + addedToFirst,
        end: Math.max(lineStart, end + lengthDelta)
    };
}

export function splitWikilinkQuery(query) {
    const hashIndex = query.indexOf('#');
    if (hashIndex < 0) {
        return { noteQuery: query, headingQuery: null, hasHeading: false };
    }
    return {
        noteQuery: query.slice(0, hashIndex),
        headingQuery: query.slice(hashIndex + 1),
        hasHeading: true
    };
}

export function indentSelection(value, start, end, outdent = false) {
    if (start === end && !outdent) {
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        // Só insere espaços soltos quando o cursor está na indentação inicial da linha.
        // Em qualquer outro ponto indentamos a linha inteira, para que marcadores de
        // lista (ex.: "- item") se movam junto com o conteúdo.
        if (/^[ \t]*$/.test(value.slice(lineStart, start))) {
            const next = `${value.slice(0, start)}    ${value.slice(end)}`;
            return { value: next, start: start + 4, end: start + 4 };
        }
    }
    return changeLines(value, start, end, line => {
        if (!outdent) return `    ${line}`;
        return line.startsWith('\t') ? line.slice(1) : line.replace(/^ {1,4}/, '');
    });
}

const maxHistoryEntries = 200;
const maxHistoryChars = 16 * 1024 * 1024;

export class MarkdownEditor {
    constructor(textarea, onChange, onHistoryChange = () => {}) {
        this.textarea = textarea;
        this.onChange = onChange;
        this.onHistoryChange = onHistoryChange;
        this.history = [textarea.value];
        this.historyChars = textarea.value.length;
        this.historyIndex = 0;
        this.lastInputAt = 0;
    }

    setValue(value, { silent = false } = {}) {
        this.textarea.value = value;
        this.history = [value];
        this.historyChars = value.length;
        this.historyIndex = 0;
        this.lastInputAt = 0;
        this.notifyHistory();
        if (!silent) this.onChange(value);
    }

    // Expande atalhos como `;hoje` e `;tabela3x4` no próprio cursor. Retorna
    // true quando o texto foi alterado; quem chama decide como registrar.
    expandSnippet(now = new Date()) {
        const { selectionStart, selectionEnd } = this.textarea;
        if (selectionStart !== selectionEnd) return false;
        const match = matchSnippet(this.textarea.value, selectionStart, now);
        if (!match) return false;
        const value = this.textarea.value;
        this.textarea.value = `${value.slice(0, match.start)}${match.text}${value.slice(selectionStart)}`;
        const caret = match.start + (match.selectStart ?? match.text.length);
        const caretEnd = match.start + (match.selectEnd ?? match.text.length);
        this.textarea.setSelectionRange(caret, caretEnd);
        return true;
    }

    handleInput() {
        // A expansão acontece antes de registrar o histórico, então o undo
        // volta para o texto digitado e o preview recebe o valor final.
        if (this.expandSnippet()) this.lastInputAt = 0;
        const value = this.textarea.value;
        if (this.history[this.historyIndex] !== value) {
            const now = Date.now();
            if (this.historyIndex < this.history.length - 1) {
                this.dropFutureHistory();
            }
            if (now - this.lastInputAt < 500 && this.historyIndex > 0) {
                const previous = this.history[this.historyIndex];
                this.historyChars += value.length - previous.length;
                this.history[this.historyIndex] = value;
            } else {
                this.history.push(value);
                this.historyChars += value.length;
                this.historyIndex++;
            }
            this.lastInputAt = now;
            this.trimHistory();
        }
        this.notifyHistory();
        this.onChange(value);
    }

    getWikilinkToken() {
        const { selectionStart, selectionEnd, value } = this.textarea;
        if (selectionStart !== selectionEnd) return null;
        const before = value.slice(0, selectionStart);
        const tokenStart = before.lastIndexOf('[[');
        if (tokenStart < 0 || (tokenStart > 0 && before[tokenStart - 1] === '!')) return null;
        const query = before.slice(tokenStart + 2);
        if (query.length > 100 || /[\[\]\n|]/.test(query)) return null;
        return {
            query,
            ...splitWikilinkQuery(query),
            tokenStart: tokenStart + 2,
            caret: selectionStart
        };
    }

    acceptWikilink(target) {
        const token = this.getWikilinkToken();
        if (!token || !target) return false;
        const { value } = this.textarea;
        const after = value.slice(token.caret);
        const hasClosingBrackets = after.startsWith(']]');
        const closingBrackets = hasClosingBrackets ? '' : ']]';
        const next = `${value.slice(0, token.tokenStart)}${target}${closingBrackets}${after}`;
        const caret = token.tokenStart + target.length + closingBrackets.length + (hasClosingBrackets ? 2 : 0);
        this.apply({ value: next, start: caret, end: caret });
        return true;
    }

    apply(result) {
        this.textarea.value = result.value;
        this.textarea.focus();
        this.textarea.setSelectionRange(result.start, result.end);
        this.dropFutureHistory();
        this.history.push(result.value);
        this.historyChars += result.value.length;
        this.historyIndex++;
        this.lastInputAt = 0;
        this.trimHistory();
        this.notifyHistory();
        this.onChange(result.value);
    }

    format(format) {
        if (format === 'table') {
            this.insertTable();
            return;
        }
        const value = this.textarea.value;
        const { selectionStart: start, selectionEnd: end } = this.textarea;
        let result;
        if (['bold', 'italic', 'strike', 'code'].includes(format)) {
            const wrappers = {
                bold: ['**', '**', 'texto'],
                italic: ['*', '*', 'texto'],
                strike: ['~~', '~~', 'texto'],
                code: ['`', '`', 'código']
            }[format];
            result = replaceSelection(value, start, end, ...wrappers);
        } else if (format === 'link') {
            const selected = value.slice(start, end);
            result = replaceSelection(value, start, end, '[', '](url)', selected || 'texto');
            result.end = result.start + (selected || 'texto').length;
        } else if (format === 'codeblock') {
            result = replaceSelection(value, start, end, '```\n', '\n```', 'código');
        } else {
            const prefix = {
                heading: '## ',
                quote: '> ',
                unordered: '- ',
                ordered: '1. ',
                task: '- [ ] '
            }[format];
            if (!prefix) return;
            result = changeLines(value, start, end, line => `${prefix}${line}`);
            if (start === end) result.end = result.start;
        }
        this.apply(result);
    }

    handleKeydown(event) {
        const mod = event.ctrlKey || event.metaKey;
        if (mod && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            if (event.shiftKey) this.redo();
            else this.undo();
            return;
        }
        if (mod && event.key.toLowerCase() === 'y') {
            event.preventDefault();
            this.redo();
            return;
        }
        if (mod && ['b', 'i'].includes(event.key.toLowerCase())) {
            event.preventDefault();
            this.format(event.key.toLowerCase() === 'b' ? 'bold' : 'italic');
            return;
        }
        if (mod && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            this.format('link');
            return;
        }
        if (mod && event.altKey && event.key.toLowerCase() === 't') {
            event.preventDefault();
            this.insertTable();
            return;
        }
        if (event.key === 'Tab') {
            event.preventDefault();
            if (!event.shiftKey && this.expandSnippet()) {
                this.apply({
                    value: this.textarea.value,
                    start: this.textarea.selectionStart,
                    end: this.textarea.selectionEnd
                });
                return;
            }
            const { selectionStart, selectionEnd } = this.textarea;
            this.apply(indentSelection(this.textarea.value, selectionStart, selectionEnd, event.shiftKey));
            return;
        }
        if (event.key === 'Enter' && this.continueMarkdownList()) {
            event.preventDefault();
            return;
        }
        const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
        const inlineMarkers = ['*', '_', '`'];
        const { selectionStart, selectionEnd, value } = this.textarea;
        if (selectionStart !== selectionEnd && inlineMarkers.includes(event.key)) {
            event.preventDefault();
            this.apply(replaceSelection(value, selectionStart, selectionEnd, event.key));
        } else if (pairs[event.key] && selectionStart !== selectionEnd) {
            event.preventDefault();
            this.apply(replaceSelection(value, selectionStart, selectionEnd, event.key, pairs[event.key]));
        } else if (pairs[event.key] && selectionStart === selectionEnd) {
            event.preventDefault();
            this.apply({
                value: `${value.slice(0, selectionStart)}${event.key}${pairs[event.key]}${value.slice(selectionEnd)}`,
                start: selectionStart + 1,
                end: selectionStart + 1
            });
        } else if ([')', ']', '}', '"', "'"].includes(event.key) &&
            value[selectionStart] === event.key && selectionStart === selectionEnd) {
            event.preventDefault();
            this.textarea.setSelectionRange(selectionStart + 1, selectionStart + 1);
        }
    }

    insertTable() {
        const value = this.textarea.value;
        const { selectionStart: start, selectionEnd: end } = this.textarea;
        let insertionStart = start;
        let insertionEnd = end;
        while (insertionStart > 0 && /[ \t]/.test(value[insertionStart - 1])) insertionStart--;
        while (insertionEnd < value.length && /[ \t]/.test(value[insertionEnd])) insertionEnd++;
        const table = '| Coluna 1 | Coluna 2 |\n| --- | --- |\n| Célula | Célula |';
        const before = insertionStart > 0 && value[insertionStart - 1] !== '\n'
            ? '\n\n'
            : insertionStart > 1 && value[insertionStart - 1] === '\n' && value[insertionStart - 2] !== '\n' ? '\n' : '';
        const after = insertionEnd < value.length && value[insertionEnd] !== '\n'
            ? '\n\n'
            : insertionEnd < value.length - 1 && value[insertionEnd] === '\n' && value[insertionEnd + 1] !== '\n' ? '\n' : '';
        const cellStart = table.indexOf('Célula');
        this.apply({
            value: `${value.slice(0, insertionStart)}${before}${table}${after}${value.slice(insertionEnd)}`,
            start: insertionStart + before.length + cellStart,
            end: insertionStart + before.length + cellStart + 'Célula'.length
        });
    }

    continueMarkdownList() {
        const { value, selectionStart, selectionEnd } = this.textarea;
        if (selectionStart !== selectionEnd) return false;
        const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
        const line = value.slice(lineStart, selectionStart);
        const match = line.match(/^([ \t]*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|[ \t]*>\s?)(.*)$/);
        if (!match) return false;
        if (match[2].trim() === '') {
            this.apply({
                value: `${value.slice(0, lineStart)}${value.slice(selectionStart)}`,
                start: lineStart,
                end: lineStart
            });
        } else {
            const prefix = match[1].replace(/^(\s*)\d+([.)])/, (_, indent, punctuation) =>
                `${indent}${Number(line.match(/^\s*(\d+)/)?.[1] || 0) + 1}${punctuation}`);
            this.apply({
                value: `${value.slice(0, selectionStart)}\n${prefix}${value.slice(selectionEnd)}`,
                start: selectionStart + 1 + prefix.length,
                end: selectionStart + 1 + prefix.length
            });
        }
        return true;
    }

    dropFutureHistory() {
        for (let index = this.historyIndex + 1; index < this.history.length; index++) {
            this.historyChars -= this.history[index].length;
        }
        this.history = this.history.slice(0, this.historyIndex + 1);
    }

    trimHistory() {
        while (this.history.length > maxHistoryEntries ||
            (this.historyChars > maxHistoryChars && this.history.length > 1 && this.historyIndex > 0)) {
            const removed = this.history.shift();
            this.historyChars -= removed.length;
            this.historyIndex = Math.max(0, this.historyIndex - 1);
        }
    }

    undo() {
        if (this.historyIndex === 0) return;
        this.historyIndex--;
        this.restoreHistory();
    }

    redo() {
        if (this.historyIndex >= this.history.length - 1) return;
        this.historyIndex++;
        this.restoreHistory();
    }

    restoreHistory() {
        const value = this.history[this.historyIndex];
        this.textarea.value = value;
        this.textarea.focus();
        this.textarea.setSelectionRange(value.length, value.length);
        this.lastInputAt = 0;
        this.notifyHistory();
        this.onChange(value);
    }

    notifyHistory() {
        this.onHistoryChange({
            canUndo: this.historyIndex > 0,
            canRedo: this.historyIndex < this.history.length - 1
        });
    }
}

function escapeHTML(source) {
    return source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export const DEFAULT_TASK_MARKERS = ['TODO', 'FIXME', 'HACK', 'XXX', 'BUG', 'NOTE'];

function escapeRegExp(source) {
    return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightTaskMarkers(html, markers) {
    const words = (markers || DEFAULT_TASK_MARKERS).filter(marker => /^[A-Z][A-Z0-9_-]*$/.test(marker));
    if (!words.length) return html;
    const pattern = new RegExp(
        `(^|[^\\p{L}\\p{N}_])(${words.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`,
        'gu'
    );
    return html.split(/(<[^>]+>)/).map(part => {
        if (part.startsWith('<')) return part;
        return part.replace(pattern, (match, prefix, word) =>
            `${prefix}<span class="md-task-marker" data-marker="${escapeHTML(word.toUpperCase())}">${word}</span>`
        );
    }).join('');
}

function highlightMarkdownLine(source, markers) {
    const inlineTokens = /(!?\[\[[^\]\n]+\]\]|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)]+\))/g;
    let result = '';
    let previousEnd = 0;
    for (const match of source.matchAll(inlineTokens)) {
        const [token] = match;
        const start = match.index;
        result += escapeHTML(source.slice(previousEnd, start));
        const tokenClass = token.startsWith('[[') || token.startsWith('![[')
            ? 'md-wikilink'
            : token.startsWith('`')
                ? 'md-code'
                : token.startsWith('**') || token.startsWith('__')
                    ? 'md-strong'
                    : token.startsWith('*') || token.startsWith('_')
                        ? 'md-emphasis'
                        : 'md-link';
        result += `<span class="${tokenClass}">${escapeHTML(token)}</span>`;
        previousEnd = start + token.length;
    }
    result += escapeHTML(source.slice(previousEnd));
    if (/^\s{0,3}#{1,6}\s/.test(source)) result = `<span class="md-heading">${result}</span>`;
    else if (/^\s{0,3}(?:[-+*]|\d+[.)])\s/.test(source)) result = result.replace(/^(\s*(?:[-+*]|\d+[.)])\s+)/, '<span class="md-list">$1</span>');
    else if (/^\s{0,3}>\s?/.test(source)) result = result.replace(/^(\s*&gt;\s?)/, '<span class="md-quote">$1</span>');
    return highlightTaskMarkers(result, markers);
}

export function highlightMarkdown(source, markers = DEFAULT_TASK_MARKERS) {
    const lines = source.split('\n');
    const highlighted = [];
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const opening = line.match(/^(\s*)(`{3,}|~{3,})([^\s`]*)?(.*)$/);
        if (!opening) {
            highlighted.push(highlightMarkdownLine(line, markers));
            continue;
        }

        const [, indent, delimiter, language = '', rest] = opening;
        const languageLabel = language
            ? `<span class="md-code-language">${escapeHTML(language)}</span>`
            : '';
        highlighted.push(`${escapeHTML(indent)}<span class="md-code-fence">${escapeHTML(delimiter)}</span>${languageLabel}${escapeHTML(rest)}`);
        const code = [];
        let closed = false;
        while (++index < lines.length) {
            const closing = lines[index].match(/^\s*(`{3,}|~{3,})\s*$/);
            if (closing && closing[1][0] === delimiter[0] && closing[1].length >= delimiter.length) {
                highlighted.push(`<span class="md-code-fence">${escapeHTML(lines[index])}</span>`);
                closed = true;
                break;
            }
            code.push(lines[index]);
        }
        if (code.length) {
            const body = highlightCode(code.join('\n'), language);
            highlighted.splice(highlighted.length - (closed ? 1 : 0), 0, ...body.split('\n'));
        }
    }
    return highlighted.join('\n');
}

export function ensureFrontmatterTags(content, tags) {
    if (!tags.length) return content;
    const lines = content.split('\n');
    const formatTag = tag => /^[\p{L}\p{N}_.\/-]+$/u.test(tag) ? tag : JSON.stringify(tag);
    const tagLines = tags.length === 1
        ? [`tags: ${formatTag(tags[0])}`]
        : ['tags:', ...tags.map(tag => `  - ${formatTag(tag)}`)];
    if (lines[0]?.trim() === '---') {
        const closeIndex = lines.findIndex((line, index) => index > 0 && ['---', '...'].includes(line.trim()));
        if (closeIndex > 0) {
            const existing = lines.slice(1, closeIndex).some(line => /^\s*tags\s*:/.test(line));
            if (existing) return content;
            lines.splice(closeIndex, 0, ...tagLines);
            return lines.join('\n');
        }
    }
    const frontmatter = ['---', ...tagLines, '---', ''];
    return [...frontmatter, ...lines].join('\n');
}

const frontmatterPropertyName = /^[\p{L}\p{N}_][\p{L}\p{N}_.\/ -]*$/u;

function escapeFrontmatterKey(key) {
    return key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatFrontmatterScalar(value) {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (value && typeof value === 'object') return JSON.stringify(value);
    const text = String(value ?? '');
    if (text !== '' && /^[\p{L}\p{N}_.\/-]+$/u.test(text)) return text;
    return JSON.stringify(text);
}

function frontmatterPropertyLines(key, value) {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) {
        const items = value.filter(item =>
            item !== null && item !== undefined && String(item).trim() !== '');
        if (items.length === 0) return [];
        if (items.length === 1) return [`${key}: ${formatFrontmatterScalar(items[0])}`];
        return [`${key}:`, ...items.map(item => `  - ${formatFrontmatterScalar(item)}`)];
    }
    if (typeof value === 'string' && value.trim() === '') return [];
    return [`${key}: ${formatFrontmatterScalar(value)}`];
}

function findFrontmatterBounds(lines) {
    if (lines[0]?.trim() !== '---') return null;
    const end = lines.findIndex((line, index) =>
        index > 0 && ['---', '...'].includes(line.trim()));
    return end > 0 ? { start: 1, end } : null;
}

export function setFrontmatterProperty(content, key, value) {
    if (!frontmatterPropertyName.test(key)) {
        throw new Error('invalid frontmatter property name');
    }
    const lines = content.split('\n');
    const bounds = findFrontmatterBounds(lines);
    const propertyLines = frontmatterPropertyLines(key, value);
    if (!bounds) {
        if (propertyLines.length === 0) return content;
        return ['---', ...propertyLines, '---', '', ...lines].join('\n');
    }

    const propertyPattern = new RegExp(`^(?:"${escapeFrontmatterKey(key)}"|'${escapeFrontmatterKey(key)}'|${escapeFrontmatterKey(key)})\\s*:`);
    const propertyIndex = lines.findIndex((line, index) =>
        index >= bounds.start && index < bounds.end && propertyPattern.test(line));
    if (propertyIndex >= 0) {
        let removeEnd = propertyIndex + 1;
        while (removeEnd < bounds.end &&
            (lines[removeEnd].trim() === '' || /^\s/.test(lines[removeEnd]))) {
            removeEnd++;
        }
        lines.splice(propertyIndex, removeEnd - propertyIndex, ...propertyLines);
    } else if (propertyLines.length) {
        lines.splice(bounds.end, 0, ...propertyLines);
    }

    const updated = findFrontmatterBounds(lines);
    if (updated && !lines.slice(updated.start, updated.end).some(line => line.trim() !== '')) {
        // Removing the last property should not leave an empty "---" block.
        let removeCount = updated.end - updated.start + 2;
        if (lines[updated.end + 1]?.trim() === '') removeCount++;
        lines.splice(updated.start - 1, removeCount);
    }
    return lines.join('\n');
}

export function stripFrontmatter(content) {
    const lines = content.split('\n');
    if (lines[0]?.trim() !== '---') return content;
    const closeIndex = lines.findIndex((line, index) => index > 0 && ['---', '...'].includes(line.trim()));
    return closeIndex < 0 ? content : lines.slice(closeIndex + 1).join('\n').replace(/^\s*\n/, '');
}

export function frontmatterLineOffset(content) {
    return content.split('\n').length - stripFrontmatter(content).split('\n').length;
}

export function parseFrontmatter(content) {
    const lines = content.split('\n');
    if (lines[0]?.trim() !== '---') return null;
    const closeIndex = lines.findIndex((line, index) => index > 0 && ['---', '...'].includes(line.trim()));
    if (closeIndex < 0) return null;

    const metadata = {};
    let currentKey = null;
    let currentValue = [];
    const parseValue = raw => {
        const value = raw.trim();
        if (!value) return null;
        if (value.startsWith('[') && value.endsWith(']')) {
            return value.slice(1, -1).split(',').map(item => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        }
        if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
        if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
        if (/^(null|~)$/i.test(value)) return null;
        return value.replace(/^["']|["']$/g, '');
    };
    const saveValue = () => {
        if (currentKey === null) return;
        const listItems = currentValue
            .map(line => line.match(/^\s+-\s*(.*)$/)?.[1])
            .filter(value => value !== undefined)
            .map(parseValue)
            .filter(value => value !== null);
        metadata[currentKey] = listItems.length
            ? listItems
            : parseValue(currentValue.join('\n'));
    };

    for (const line of lines.slice(1, closeIndex)) {
        const keyValue = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
        if (keyValue) {
            saveValue();
            currentKey = keyValue[1];
            currentValue = [keyValue[2]];
        } else if (currentKey && /^\s+/.test(line)) {
            currentValue.push(line);
        }
    }
    saveValue();
    return Object.keys(metadata).length ? metadata : null;
}

// Frontmatter `note-type` switches how the reading view renders the note.
// Unknown or missing values fall back to the regular Markdown preview.
export function noteType(content) {
    const metadata = parseFrontmatter(content);
    const value = metadata?.['note-type'];
    if (value === undefined || value === null) return '';
    const first = Array.isArray(value) ? value[0] : value;
    return first === undefined || first === null ? '' : String(first).trim().toLowerCase();
}

export function isMarkmapNote(content) {
    return noteType(content) === 'markmap';
}

export function extractMarkdownOutline(content) {
    const lines = content.split('\n');
    const outline = [];
    let inFrontmatter = lines[0]?.trim() === '---';
    let inFence = null;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (inFrontmatter) {
            if (index > 0 && ['---', '...'].includes(line.trim())) inFrontmatter = false;
            continue;
        }
        const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (inFence) {
            if (fence && fence[1][0] === inFence.character && fence[1].length >= inFence.length) inFence = null;
            continue;
        }
        if (fence) {
            inFence = { character: fence[1][0], length: fence[1].length };
            continue;
        }

        const atx = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (atx) {
            outline.push({
                level: atx[1].length,
                text: atx[2].trim(),
                line: index
            });
            continue;
        }
        if (index > 0 && line.trim() && /^ {0,3}(=+|-+)\s*$/.test(line) && lines[index - 1].trim()) {
            outline.push({
                level: line.trim()[0] === '=' ? 1 : 2,
                text: lines[index - 1].trim(),
                line: index - 1
            });
        }
    }

    if (inFrontmatter) return [];
    const bodyLineOffset = frontmatterLineOffset(content);
    return outline.map(heading => ({ ...heading, bodyLine: heading.line - bodyLineOffset }));
}
