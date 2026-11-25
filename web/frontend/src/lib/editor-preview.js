import { stripFrontmatter, parseFrontmatter, isMarkmapNote } from './markdown-editor.js';
import { estimateSourceLine, getScrollSpacerHeight, mapEditorToPreview, mapPreviewToEditor } from './scroll-sync.js';
import { highlightCode } from './syntax-highlight.js';
import { findLinkOccurrence, linkTargetMatches } from './note-links.js';

// Short notes stay almost immediate; long documents wait a little longer so a
// burst of typing does not trigger a full server render on every pause.
export function previewDelay(markdown) {
    const length = markdown.length;
    if (length <= 16 * 1024) return 140;
    if (length <= 128 * 1024) return 220;
    return 320;
}

// The preview HTML also depends on the saved title and folder, which the
// server uses to resolve wikilinks and dynamic blocks. Unsaved title edits
// must not force a new render, so the key uses the last saved draft.
function previewContextKey(state) {
    return [
        state.noteID ?? '',
        state.savedDraft?.title ?? '',
        state.savedDraft?.folder ?? ''
    ].join('\x00');
}

let sourceCache = null;

// stripFrontmatter and the frontmatter line count both split the whole
// document. The scroll sync asks for them on every frame, so keep the result
// of the last document around instead of re-parsing it repeatedly.
function deriveSource(content) {
    if (sourceCache?.content === content) return sourceCache;
    const markdown = stripFrontmatter(content);
    sourceCache = {
        content,
        markdown,
        offset: content.split('\n').length - markdown.split('\n').length
    };
    return sourceCache;
}

// Preview rendering, editor/reading modes and bidirectional scroll sync.
export function createEditorPreview({ state, elements, closePanel }) {
    let previewTimer = 0;
    let previewRequestID = 0;
    let previewAbortController = null;
    let previewInFlight = null;
    let renderedPreviewMarkdown = '';
    let renderedPreviewContext = '';
    let editorLinePositionCache = null;
    let scrollSyncFrame = 0;
    let pendingScrollSource = null;
    let programmaticScroll = null;
    let scrollSyncSuspendedUntil = 0;
    let pendingReadingLine = null;
    // markmap is only needed by notes that opt in through
    // `note-type: markmap` in the frontmatter, so its ~650 KB bundle is
    // loaded on demand and reused across notes.
    let markmapLoader = null;
    let markmapTimer = 0;
    let markmapInstance = null;

const markmapScripts = [
    '/vendor/markmap/d3.min.js',
    '/vendor/markmap/markmap-lib.min.js',
    '/vendor/markmap/markmap-view.min.js'
];

function isMarkmapPreview() {
    return elements.markdownPreview.classList.contains('is-markmap');
}

function loadMarkmap() {
    if (window.markmap?.Transformer && window.markmap?.Markmap) {
        return Promise.resolve(window.markmap);
    }
    if (markmapLoader) return markmapLoader;
    markmapLoader = (async () => {
        for (const src of markmapScripts) {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = src;
                script.dataset.markmapScript = src;
                script.addEventListener('load', resolve, { once: true });
                script.addEventListener('error', () => {
                    reject(new Error(`Não foi possível carregar ${src}.`));
                }, { once: true });
                document.head.append(script);
            });
        }
        if (!window.markmap?.Transformer || !window.markmap?.Markmap) {
            throw new Error('A biblioteca do markmap não foi inicializada.');
        }
        return window.markmap;
    })().catch(error => {
        markmapLoader = null;
        throw error;
    });
    return markmapLoader;
}

function destroyMarkmap() {
    window.clearTimeout(markmapTimer);
    markmapTimer = 0;
    markmapInstance?.destroy?.();
    markmapInstance = null;
}

function resetMarkmapPreview() {
    const wasMarkmap = elements.markdownPreview.classList.contains('is-markmap');
    destroyMarkmap();
    elements.markdownPreview.classList.remove('is-markmap');
    delete elements.markdownPreview.dataset.noteType;
    if (wasMarkmap) {
        // The SVG is not the server-rendered preview, so the next non-markmap
        // update must fetch even when the Markdown text did not change.
        renderedPreviewMarkdown = '';
        renderedPreviewContext = '';
    }
}

function scheduleMarkmapPreview(markdown, requestID, immediate = false) {
    elements.markdownPreview.classList.add('is-markmap');
    elements.markdownPreview.dataset.noteType = 'markmap';
    window.clearTimeout(markmapTimer);
    markmapTimer = window.setTimeout(() => {
        markmapTimer = 0;
        void drawMarkmapPreview(markdown, requestID);
    }, immediate ? 0 : 140);
}

async function drawMarkmapPreview(markdown, requestID) {
    try {
        const library = await loadMarkmap();
        if (requestID !== previewRequestID || !isMarkmapPreview()) return;
        const preview = elements.markdownPreview;
        destroyMarkmap();
        preview.replaceChildren();
        renderedPreviewMarkdown = markdown;
        renderedPreviewContext = previewContextKey(state);
        editorLinePositionCache = null;
        pendingReadingLine = null;

        if (!markdown.trim()) {
            const empty = document.createElement('p');
            empty.className = 'markmap-empty';
            empty.textContent = 'Escreva a estrutura do mapa mental com títulos e listas Markdown.';
            preview.append(empty);
            renderFrontmatterProperties();
            runPendingBacklink();
            runPendingTaskLine();
            return;
        }

        const host = document.createElement('div');
        host.className = 'markmap-host';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'markmap');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', 'Mapa mental da nota');
        host.append(svg);
        preview.append(host);
        renderFrontmatterProperties();

        const transformer = new library.Transformer();
        const { root } = transformer.transform(markdown);
        // Wait one frame so the svg has its final size before markmap
        // measures and lays out the tree.
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (requestID !== previewRequestID || !isMarkmapPreview()) return;
        // markmap-view always appends an inline <style> to the svg. The
        // strict `style-src 'self'` CSP blocks it (and the base styles are
        // already loaded from /vendor/markmap/markmap.css), so hand it an
        // inert stand-in instead.
        const svgSelection = window.d3.select(svg);
        const append = svgSelection.append.bind(svgSelection);
        const inertStyle = { text() { return this; } };
        svgSelection.append = name => name === 'style' ? inertStyle : append(name);
        markmapInstance = library.Markmap.create(svgSelection, library.deriveOptions({
            colorFreezeLevel: 2,
            duration: 200,
            embedGlobalCSS: false
        }), root);

        if (state.pendingOutlineLine !== null) {
            const pendingLine = state.pendingOutlineLine;
            state.pendingOutlineLine = null;
            requestAnimationFrame(() => scrollToOutlineHeading(pendingLine));
        }
        runPendingBacklink();
        runPendingTaskLine();
    } catch (error) {
        if (requestID !== previewRequestID) return;
        resetMarkmapPreview();
        elements.markdownPreview.textContent = `Falha ao renderizar o mapa mental: ${error.message}`;
        renderedPreviewMarkdown = '';
    }
}

function highlightPreviewCode() {
    for (const code of elements.markdownPreview.querySelectorAll('pre > code')) {
        const languageClass = [...code.classList].find(name => name.startsWith('language-'));
        const language = languageClass?.slice('language-'.length) || '';
        const safeLanguage = /^[\w+-]{1,30}$/.test(language) ? language : '';
        const pre = code.parentElement;
        if (safeLanguage) pre.dataset.language = safeLanguage;
        else delete pre.dataset.language;
        code.innerHTML = highlightCode(code.textContent, safeLanguage);
    }
}


function cancelPreviewRequest() {
    window.clearTimeout(previewTimer);
    previewTimer = 0;
    previewAbortController?.abort();
    previewAbortController = null;
    previewInFlight = null;
}

// `immediate` skips the typing debounce. Opening a note or switching to a
// reading mode has nothing to coalesce, so waiting only adds latency.
function updatePreview({ immediate = false } = {}) {
    const content = elements.noteContent.value;
    // Cancel the previous render before scheduling another one. Discarding the
    // response was not enough: the server kept parsing stale documents while
    // the user kept typing.
    if (elements.editorWorkspace.dataset.editorMode === 'edit') {
        cancelPreviewRequest();
        runPendingBacklink();
        return;
    }
    const markdown = deriveSource(content).markdown;
    if (isMarkmapNote(content)) {
        cancelPreviewRequest();
        scheduleMarkmapPreview(markdown, ++previewRequestID, immediate);
        return;
    }
    resetMarkmapPreview();
    if (!markdown.trim()) {
        cancelPreviewRequest();
        previewRequestID++;
        elements.markdownPreview.textContent = '';
        renderFrontmatterProperties();
        renderedPreviewMarkdown = markdown;
        renderedPreviewContext = previewContextKey(state);
        editorLinePositionCache = null;
        pendingReadingLine = null;
        syncPreviewMinimumHeight();
        syncEditorScrollFromSource();
        runPendingBacklink();
        runPendingTaskLine();
        return;
    }
    // The server round-trip is only needed when the body or the note context
    // actually changed. Frontmatter is not part of the preview HTML, so it is
    // refreshed even when the stripped Markdown is identical.
    const contextKey = previewContextKey(state);
    if (markdown === renderedPreviewMarkdown && contextKey === renderedPreviewContext) {
        cancelPreviewRequest();
        previewRequestID++;
        renderFrontmatterProperties();
        syncPreviewMinimumHeight();
        syncEditorScrollFromSource();
        runPendingBacklink();
        runPendingTaskLine();
        return;
    }
    // The same document may be requested twice in a row (for example when a
    // note is opened and the mode is applied right after). Reusing the request
    // in flight avoids aborting it and starting the server work over.
    if (previewInFlight?.markdown === markdown && previewInFlight?.context === contextKey) return;

    cancelPreviewRequest();
    const requestID = ++previewRequestID;
    const controller = new AbortController();
    previewAbortController = controller;
    previewInFlight = { markdown, context: contextKey };
    const renderPreview = async () => {
        try {
            const response = await fetch('/api/preview', {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    ...(state.noteID === null ? {} : { 'X-Note-ID': String(state.noteID) })
                },
                body: markdown,
                signal: controller.signal
            });
            if (response.status === 401) {
                location.replace('/login.html');
                return;
            }
            if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
            const html = await response.text();
            if (requestID === previewRequestID) {
                elements.markdownPreview.innerHTML = html;
                highlightPreviewCode();
                renderFrontmatterProperties();
                syncPreviewMinimumHeight();
                renderedPreviewMarkdown = markdown;
                renderedPreviewContext = contextKey;
                annotatePreviewLandmarks(markdown);
                const readingLine = pendingReadingLine;
                pendingReadingLine = null;
                if (readingLine !== null) {
                    scrollEditorToLine(readingLine);
                    scrollPreviewToSourceLine(readingLine);
                } else {
                    syncEditorScrollFromSource();
                }
                if (state.pendingOutlineLine !== null) {
                    const pendingLine = state.pendingOutlineLine;
                    state.pendingOutlineLine = null;
                    requestAnimationFrame(() => scrollToOutlineHeading(pendingLine));
                }
                runPendingBacklink();
                runPendingTaskLine();
            }
        } catch (error) {
            if (error.name === 'AbortError') return;
            if (requestID === previewRequestID) {
                elements.markdownPreview.textContent = `Falha ao renderizar Markdown: ${error.message}`;
                renderedPreviewMarkdown = '';
                renderedPreviewContext = '';
                pendingReadingLine = null;
                renderFrontmatterProperties();
                syncPreviewMinimumHeight();
                syncEditorScrollFromSource();
            }
        } finally {
            if (previewAbortController === controller) previewAbortController = null;
            if (previewInFlight?.markdown === markdown && previewInFlight?.context === contextKey) {
                previewInFlight = null;
            }
        }
    };
    // Starting the request synchronously lets the server work in parallel with
    // the editor's highlight rebuild that runs right after a note is opened.
    if (immediate) void renderPreview();
    else previewTimer = window.setTimeout(renderPreview, previewDelay(markdown));
}

function renderFrontmatterProperties() {
    elements.markdownPreview.querySelector('.frontmatter-properties')?.remove();
    const metadata = parseFrontmatter(elements.noteContent.value);
    if (!metadata) return;

    const panel = document.createElement('section');
    panel.className = 'frontmatter-properties';
    panel.setAttribute('aria-label', 'Propriedades da nota');

    const tagsValue = metadata.tags;
    const tags = tagsValue === undefined || tagsValue === null
        ? []
        : (Array.isArray(tagsValue) ? tagsValue : [tagsValue]).map(String);
    const priority = ['date', 'created', 'author', 'status', 'priority', 'type', 'category'];
    const priorityFields = priority
        .filter(key => metadata[key] !== undefined && metadata[key] !== null && !Array.isArray(metadata[key]))
        .slice(0, 3);

    const summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'frontmatter-summary';
    summary.dataset.frontmatterToggle = '';
    summary.setAttribute('aria-expanded', String(state.frontmatterExpanded));
    summary.setAttribute('aria-label', state.frontmatterExpanded
        ? 'Recolher propriedades da nota'
        : 'Expandir propriedades da nota');

    const summaryLabel = document.createElement('span');
    summaryLabel.className = 'frontmatter-summary-label';
    summaryLabel.textContent = '⚙ Propriedades';
    summary.append(summaryLabel);
    for (const tag of tags.slice(0, 5)) {
        const chip = document.createElement('span');
        chip.className = 'frontmatter-tag';
        chip.textContent = `#${tag}`;
        summary.append(chip);
    }
    if (tags.length > 5) {
        const more = document.createElement('span');
        more.className = 'frontmatter-muted';
        more.textContent = `+${tags.length - 5}`;
        summary.append(more);
    }
    for (const key of priorityFields) {
        const field = document.createElement('span');
        field.className = 'frontmatter-summary-field';
        field.textContent = `${key}: ${metadata[key]}`;
        summary.append(field);
    }
    const summaryChevron = document.createElement('span');
    summaryChevron.className = 'frontmatter-chevron';
    summaryChevron.textContent = '▼';
    summary.append(summaryChevron);
    if (!state.frontmatterExpanded) panel.append(summary);

    if (state.frontmatterExpanded) {
        const details = document.createElement('div');
        details.className = 'frontmatter-details';
        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'frontmatter-details-header';
        header.dataset.frontmatterToggle = '';
        header.setAttribute('aria-expanded', 'true');
        header.textContent = '⚙ Propriedades · Recolher ▲';
        details.append(header);

        for (const [key, rawValue] of Object.entries(metadata)) {
            const row = document.createElement('div');
            row.className = 'frontmatter-row';
            const name = document.createElement('span');
            name.className = 'frontmatter-key';
            name.textContent = key;
            const value = document.createElement('span');
            value.className = 'frontmatter-value';
            const values = Array.isArray(rawValue) ? rawValue : [rawValue];
            value.textContent = values.map(item => item === null ? '' : String(item)).join(', ');
            row.append(name, value);
            details.append(row);
        }
        panel.append(details);
    }
    elements.markdownPreview.prepend(panel);
}

function syncPreviewMinimumHeight() {
    const preview = elements.markdownPreview;
    if (isMarkmapPreview()) {
        preview.querySelector(':scope > .preview-scroll-spacer')?.remove();
        return;
    }
    let spacer = preview.querySelector(':scope > .preview-scroll-spacer');
    if (elements.noteContent.clientHeight === 0 || preview.clientHeight === 0) {
        spacer?.remove();
        return;
    }
    const contentEnd = spacer ? spacer.previousElementSibling : preview.lastElementChild;
    const contentHeight = contentEnd
        ? Math.max(0, contentEnd.getBoundingClientRect().bottom - preview.getBoundingClientRect().top + preview.scrollTop)
        : 0;
    const neededHeight = getScrollSpacerHeight(
        Math.max(0, elements.noteContent.scrollHeight - elements.noteContent.clientHeight),
        contentHeight,
        preview.clientHeight
    );
    if (neededHeight > 0 && !spacer) {
        spacer = document.createElement('div');
        spacer.className = 'preview-scroll-spacer';
        preview.append(spacer);
    }
    if (spacer) {
        if (neededHeight > 0) spacer.style.height = `${neededHeight}px`;
        else spacer.remove();
    }
}

function scanMarkdownLandmarks(markdown) {
    const lines = markdown.split('\n');
    const landmarks = [];
    let fence = null;
    let inTable = false;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const fenceMatch = line.match(/^ {0,3}(```+|~~~+)/);
        if (fence) {
            if (fenceMatch && fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length) {
                fence = null;
            }
            continue;
        }
        if (fenceMatch) {
            fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
            landmarks.push({ line: index, kind: 'pre' });
            inTable = false;
            continue;
        }
        const heading = line.match(/^ {0,3}(#{1,6})\s+/);
        if (heading) {
            landmarks.push({ line: index, kind: `h${heading[1].length}` });
            inTable = false;
            continue;
        }
        if (index > 0 && /^ {0,3}(=+|-+)\s*$/.test(line) && lines[index - 1].trim()) {
            landmarks.push({ line: index - 1, kind: line.trim()[0] === '=' ? 'h1' : 'h2' });
            inTable = false;
            continue;
        }
        if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
            landmarks.push({ line: index, kind: 'hr' });
            inTable = false;
            continue;
        }
        if (/^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line)) {
            landmarks.push({ line: index, kind: 'img' });
            inTable = false;
            continue;
        }
        const tableLine = /^\s*\|.*\|\s*$/.test(line);
        if (tableLine && !inTable) landmarks.push({ line: index, kind: 'table' });
        inTable = tableLine;
    }
    return landmarks;
}

function previewBlockKind(element) {
    if (/^H[1-6]$/.test(element.tagName)) return element.tagName.toLowerCase();
    if (element.tagName === 'PRE') return 'pre';
    if (element.tagName === 'HR') return 'hr';
    if (element.tagName === 'TABLE') return 'table';
    if (element.tagName === 'IMG' ||
        (element.tagName === 'P' && element.childNodes.length === 1 && element.firstElementChild?.tagName === 'IMG')) return 'img';
    return null;
}

function annotatePreviewLandmarks(markdown) {
    const byKind = new Map();
    for (const landmark of scanMarkdownLandmarks(markdown)) {
        if (!byKind.has(landmark.kind)) byKind.set(landmark.kind, []);
        byKind.get(landmark.kind).push(landmark);
    }
    const previewBlocks = [...elements.markdownPreview.children].map(element => ({
        element,
        kind: previewBlockKind(element)
    }));
    const previewByKind = new Map();
    for (const block of previewBlocks) {
        if (!block.kind) continue;
        if (!previewByKind.has(block.kind)) previewByKind.set(block.kind, []);
        previewByKind.get(block.kind).push(block.element);
    }
    for (const [kind, landmarks] of byKind) {
        const blocks = previewByKind.get(kind) || [];
        if (blocks.length !== landmarks.length) continue;
        blocks.forEach((element, index) => element.dataset.sourceLine = String(landmarks[index].line));
    }
}

function measureEditorLines(markdown, lines) {
    const editor = elements.noteContent;
    const computed = getComputedStyle(editor);
    const cacheKey = [
        markdown, editor.clientWidth, computed.fontFamily, computed.fontSize,
        computed.fontWeight, computed.lineHeight, computed.letterSpacing,
        computed.tabSize, computed.padding, [...lines].sort((a, b) => a - b).join(',')
    ].join('|');
    if (editorLinePositionCache?.key === cacheKey) return editorLinePositionCache.positions;

    const mirror = document.createElement('div');
    for (const property of [
        'direction', 'fontFamily', 'fontStyle', 'fontVariant', 'fontWeight',
        'fontStretch', 'fontSize', 'fontSizeAdjust', 'lineHeight',
        'letterSpacing', 'wordSpacing', 'tabSize', 'textIndent', 'textAlign',
        'textTransform', 'textDecoration'
    ]) mirror.style[property] = computed[property];
    const paddingLeft = parseFloat(computed.paddingLeft) || 0;
    const paddingRight = parseFloat(computed.paddingRight) || 0;
    mirror.style.boxSizing = 'content-box';
    mirror.style.width = `${Math.max(0, editor.clientWidth - paddingLeft - paddingRight)}px`;
    // Firefox serializa o shorthand com porcentagens (ex.: `max(12px, 50% -
    // 336px)`), que seriam recalculadas contra a largura do espelho. Copiar os
    // lados já resolvidos mantém as medidas iguais às do textarea.
    mirror.style.paddingTop = computed.paddingTop;
    mirror.style.paddingRight = computed.paddingRight;
    mirror.style.paddingBottom = computed.paddingBottom;
    mirror.style.paddingLeft = computed.paddingLeft;
    mirror.style.border = '0';
    mirror.style.height = 'auto';
    mirror.style.overflow = 'hidden';
    mirror.style.position = 'absolute';
    mirror.style.left = '-100000px';
    mirror.style.top = '0';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflowWrap = 'break-word';
    const wanted = new Set(lines);
    const sourceLines = markdown.split('\n');
    sourceLines.forEach((line, index) => {
        if (wanted.has(index)) {
            const marker = document.createElement('span');
            marker.dataset.line = String(index);
            marker.textContent = line || '\u200b';
            mirror.append(marker);
        } else {
            mirror.append(document.createTextNode(line));
        }
        if (index < sourceLines.length - 1) mirror.append(document.createTextNode('\n'));
    });
    document.body.append(mirror);
    const mirrorTop = mirror.getBoundingClientRect().top;
    const positions = new Map([...mirror.querySelectorAll('[data-line]')].map(marker => [
        Number(marker.dataset.line),
        marker.getBoundingClientRect().top - mirrorTop
    ]));
    mirror.remove();
    editorLinePositionCache = { key: cacheKey, positions };
    return positions;
}

function getScrollLandmarks() {
    if (isMarkmapPreview()) return [];
    const source = deriveSource(elements.noteContent.value);
    if (renderedPreviewMarkdown !== source.markdown) return [];
    const editor = elements.noteContent;
    const preview = elements.markdownPreview;
    const editorScrollable = Math.max(0, editor.scrollHeight - editor.clientHeight);
    const previewScrollable = Math.max(0, preview.scrollHeight - preview.clientHeight);
    if (!editorScrollable || !previewScrollable) return [];
    // Preview source lines are relative to the stripped body, but the editor
    // textarea still contains the frontmatter, so the measured line tops need
    // to be shifted by the removed lines to match the real editor scroll.
    const sourceLineOffset = source.offset;
    const blocks = [...elements.markdownPreview.querySelectorAll('[data-source-line]')];
    if (!blocks.length) return [];
    const positions = measureEditorLines(
        source.content,
        blocks.map(element => Number(element.dataset.sourceLine) + sourceLineOffset)
    );
    const previewRect = preview.getBoundingClientRect();
    return blocks
        .map(element => {
            const sourceY = positions.get(Number(element.dataset.sourceLine) + sourceLineOffset);
            const previewTop = element.getBoundingClientRect().top - previewRect.top + preview.scrollTop;
            return {
                editorPct: Number.isFinite(sourceY) ? sourceY / editorScrollable : NaN,
                previewTop
            };
        })
        .filter(anchor => anchor.editorPct > 0 && anchor.editorPct < 1 &&
            anchor.previewTop > 0 && anchor.previewTop < previewScrollable);
}

// Reading mode scrolls the preview, while the textarea keeps its previous
// offset. Capture the source line at the top of the preview so switching to
// edit or split can resume from the same place instead of jumping to the top.
function previewAnchorSourceLine() {
    const preview = elements.markdownPreview;
    if (!preview || preview.clientHeight === 0) return null;
    // The mind map has no source-line landmarks to map the scroll back.
    if (isMarkmapPreview()) return null;
    const source = deriveSource(elements.noteContent.value);
    const offset = source.offset;
    const previewRect = preview.getBoundingClientRect();
    const scrollTop = preview.scrollTop;
    const landmarks = [];
    for (const element of preview.children) {
        if (element.classList.contains('preview-scroll-spacer')) continue;
        const line = Number(element.dataset.sourceLine);
        if (!Number.isFinite(line)) continue;
        landmarks.push({
            line,
            top: element.getBoundingClientRect().top - previewRect.top + scrollTop
        });
    }
    const bodyLineCount = Math.max(0, source.markdown.split('\n').length);
    const scrollable = Math.max(0, preview.scrollHeight - preview.clientHeight);
    const fallback = scrollable > 0 ? (scrollTop / scrollable) * bodyLineCount : 0;
    const bodyLine = estimateSourceLine(scrollTop, landmarks, fallback);
    return Math.max(0, Math.round(bodyLine + offset));
}

function hasPreviewSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    return elements.markdownPreview.contains(selection.getRangeAt(0).commonAncestorContainer);
}

function handleEditorScroll(source) {
    if (elements.editorWorkspace.dataset.editorMode !== 'split') return;
    if (isMarkmapPreview()) return;
    if (source === elements.markdownPreview && hasPreviewSelection()) return;
    if (performance.now() < scrollSyncSuspendedUntil) {
        if (programmaticScroll?.element === source) programmaticScroll = null;
        return;
    }
    if (programmaticScroll?.element === source) {
        const matched = Math.abs(source.scrollTop - programmaticScroll.scrollTop) < 1;
        programmaticScroll = null;
        if (matched) return;
    }
    pendingScrollSource = source;
    if (scrollSyncFrame) return;
    scrollSyncFrame = requestAnimationFrame(() => {
        scrollSyncFrame = 0;
        const source = pendingScrollSource;
        pendingScrollSource = null;
        if (!source) return;
        // At the very top the mapping is always zero; measuring every landmark
        // there only costs layout work while a long note is opening.
        const landmarks = source.scrollTop <= 0 ? [] : getScrollLandmarks();
        const fromEditor = source === elements.noteContent;
        const sourceScrollable = Math.max(0, source.scrollHeight - source.clientHeight);
        const target = fromEditor ? elements.markdownPreview : elements.noteContent;
        const targetScrollable = Math.max(0, target.scrollHeight - target.clientHeight);
        const targetTop = fromEditor
            ? mapEditorToPreview(source.scrollTop, sourceScrollable, targetScrollable, landmarks)
            : mapPreviewToEditor(source.scrollTop, sourceScrollable, targetScrollable, landmarks);
        if (Math.abs(target.scrollTop - targetTop) >= 1) {
            programmaticScroll = { element: target, scrollTop: targetTop };
            target.scrollTop = targetTop;
        }
    });
}

function syncEditorScrollFromSource() {
    if (elements.editorWorkspace.dataset.editorMode !== 'split') return;
    if (isMarkmapPreview()) return;
    if (hasPreviewSelection()) return;
    if (performance.now() < scrollSyncSuspendedUntil) return;
    const editor = elements.noteContent;
    const preview = elements.markdownPreview;
    const targetTop = mapEditorToPreview(
        editor.scrollTop,
        Math.max(0, editor.scrollHeight - editor.clientHeight),
        Math.max(0, preview.scrollHeight - preview.clientHeight),
        editor.scrollTop <= 0 ? [] : getScrollLandmarks()
    );
    if (Math.abs(preview.scrollTop - targetTop) >= 1) {
        programmaticScroll = { element: preview, scrollTop: targetTop };
        preview.scrollTop = targetTop;
    }
}

function updateEditorHistoryButtons({ canUndo, canRedo }) {
    document.querySelector('[data-action="undo"]').disabled = !canUndo;
    document.querySelector('[data-action="redo"]').disabled = !canRedo;
}

function setEditorMode(mode, { render = true } = {}) {
    if (mode === 'split' && window.matchMedia('(max-width: 700px)').matches) mode = 'edit';
    const previousMode = elements.editorWorkspace.dataset.editorMode;
    if (previousMode === mode) return;
    // Leaving reading mode must carry the preview position back to the source
    // editor. Only use the preview when it matches the current text, otherwise
    // a note switch would map the previous note's scroll position.
    const readingLine = previousMode === 'preview' && mode !== 'preview' && previewSourceReady()
        ? previewAnchorSourceLine()
        : null;
    elements.editorWorkspace.dataset.editorMode = mode;
    localStorage.setItem('editorMode', mode);
    document.querySelectorAll('.editor-mode[data-editor-mode]').forEach(button => {
        const active = button.dataset.editorMode === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    const previewNeedsRender = mode !== 'edit' && !previewSourceReady();
    pendingReadingLine = readingLine !== null && previewNeedsRender ? readingLine : null;
    if (mode === 'edit') {
        window.clearTimeout(previewTimer);
        previewRequestID++;
        previewAbortController?.abort();
        previewAbortController = null;
        previewInFlight = null;
    } else if (previewNeedsRender && render) {
        updatePreview({ immediate: true });
    }
    requestAnimationFrame(() => {
        syncPreviewMinimumHeight();
        if (readingLine === null) {
            syncEditorScrollFromSource();
        } else if (!previewNeedsRender) {
            // The preview is still exactly where the user was reading, so only
            // move the editor to the matching line. The async render path
            // applies pendingReadingLine after it rebuilds the preview.
            scrollEditorToLine(readingLine);
        }
    });
}

function scrollPreviewToSourceLine(lineIndex) {
    if (isMarkmapPreview()) return false;
    const bodyLine = Math.max(0, lineIndex - deriveSource(elements.noteContent.value).offset);
    const blocks = [...elements.markdownPreview.querySelectorAll('[data-source-line]')];
    let target = null;
    for (const block of blocks) {
        const sourceLine = Number(block.dataset.sourceLine);
        if (!Number.isFinite(sourceLine)) continue;
        if (sourceLine > bodyLine) break;
        target = block;
    }
    if (!target) return false;
    scrollPreviewToElement(target, { flash: true });
    return true;
}

function previewSourceReady() {
    return renderedPreviewMarkdown === deriveSource(elements.noteContent.value).markdown;
}

function jumpToSourceLine(lineIndex) {
    const line = Number(lineIndex);
    if (!Number.isFinite(line) || line < 0) return;
    const mode = elements.editorWorkspace.dataset.editorMode;
    if (mode === 'edit') {
        scrollEditorToLine(line);
        return;
    }
    if (!previewSourceReady()) {
        // Keep the target until the asynchronous preview rendering finishes.
        state.pendingTaskLine = line;
        updatePreview();
        return;
    }
    if (mode === 'split') scrollEditorToLine(line);
    scrollPreviewToSourceLine(line);
}

function runPendingTaskLine() {
    if (state.pendingTaskLine === null) return;
    const mode = elements.editorWorkspace.dataset.editorMode;
    if (mode !== 'edit' && !previewSourceReady()) return;
    const line = state.pendingTaskLine;
    state.pendingTaskLine = null;
    jumpToSourceLine(line);
}

function suspendScrollSync(duration = 350) {
    scrollSyncSuspendedUntil = performance.now() + duration;
}

function scrollEditorToLine(lineIndex) {
    const lineTop = measureEditorLines(elements.noteContent.value, [lineIndex]).get(lineIndex);
    if (!Number.isFinite(lineTop)) return false;
    const targetTop = Math.max(0, lineTop - 12);
    suspendScrollSync();
    programmaticScroll = { element: elements.noteContent, scrollTop: targetTop };
    elements.noteContent.scrollTop = targetTop;
    elements.noteContentHighlight.scrollTop = elements.noteContent.scrollTop;
    elements.noteContentHighlight.scrollLeft = elements.noteContent.scrollLeft;
    return true;
}

function scrollPreviewToElement(element, { offset = 12, flash = false } = {}) {
    const preview = elements.markdownPreview;
    const block = element.closest('p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr, table, img') || element;
    const targetTop = Math.max(0, Math.min(
        preview.scrollHeight - preview.clientHeight,
        preview.scrollTop + element.getBoundingClientRect().top - preview.getBoundingClientRect().top - offset
    ));
    suspendScrollSync();
    programmaticScroll = { element: preview, scrollTop: targetTop };
    preview.scrollTop = targetTop;
    if (flash) {
        block.classList.add('is-jump-target');
        window.setTimeout(() => block.classList.remove('is-jump-target'), 1600);
    }
}

function findPreviewHeading(heading) {
    const headings = [...elements.markdownPreview.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    return headings.find(element => Number(element.dataset.sourceLine) === heading.bodyLine) ||
        headings[state.outline.indexOf(heading)] ||
        headings.find(element => element.textContent.trim() === heading.text) ||
        null;
}

function runPendingBacklink() {
    const target = state.pendingBacklink;
    if (!target || state.view !== 'editor') return;
    state.pendingBacklink = null;
    const mode = elements.editorWorkspace.dataset.editorMode;
    const occurrence = findLinkOccurrence(elements.noteContent.value, target, state.noteFolder);
    if (mode !== 'preview' && occurrence) scrollEditorToLine(occurrence.line);
    if (mode === 'edit') return;
    requestAnimationFrame(() => {
        const anchor = [...elements.markdownPreview.querySelectorAll('a[href]')]
            .find(link => linkTargetMatches(link.getAttribute('href'), target, state.noteFolder));
        if (anchor) scrollPreviewToElement(anchor, { offset: 40, flash: true });
    });
}

function normalizeHeadingReference(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase()
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function scrollToLinkedHeading(reference) {
    const wanted = normalizeHeadingReference(reference);
    if (!wanted) return;
    const headings = state.outline;
    const heading = headings.find(item => normalizeHeadingReference(item.text) === wanted) ||
        headings.find(item => normalizeHeadingReference(item.text).startsWith(wanted)) ||
        headings.find(item => normalizeHeadingReference(item.text).includes(wanted));
    if (heading) scrollToOutlineHeading(heading.line);
}

function scrollToOutlineHeading(line) {
    const lineIndex = Number(line);
    const heading = state.outline.find(item => item.line === lineIndex);
    if (!heading) return;
    if (window.matchMedia('(max-width: 700px)').matches) closePanel();
    const mode = elements.editorWorkspace.dataset.editorMode;
    if (mode !== 'edit' && renderedPreviewMarkdown !== deriveSource(elements.noteContent.value).markdown) {
        state.pendingOutlineLine = lineIndex;
        updatePreview();
        return;
    }
    if (mode !== 'preview') scrollEditorToLine(heading.line);
    if (mode !== 'edit') {
        const previewHeading = findPreviewHeading(heading);
        if (!previewHeading) return;
        requestAnimationFrame(() => scrollPreviewToElement(previewHeading));
    }
}



    return {
        update: updatePreview,
        renderFrontmatterProperties,
        syncMinimumHeight: syncPreviewMinimumHeight,
        handleScroll: handleEditorScroll,
        syncScroll: syncEditorScrollFromSource,
        updateHistoryButtons: updateEditorHistoryButtons,
        setMode: setEditorMode,
        scrollToLinkedHeading,
        scrollToOutlineHeading,
        jumpToLine: jumpToSourceLine,
        runPendingTaskLine,
        runPendingBacklink,
        resetViewState() {
            cancelPreviewRequest();
            previewRequestID++;
            resetMarkmapPreview();
            renderedPreviewMarkdown = '';
            renderedPreviewContext = '';
            editorLinePositionCache = null;
            sourceCache = null;
            scrollSyncSuspendedUntil = 0;
            programmaticScroll = null;
            pendingReadingLine = null;
        },
        invalidateMeasurements() {
            editorLinePositionCache = null;
        }
    };
}
