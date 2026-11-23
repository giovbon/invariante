function escapeHTML(source) {
    return source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// Re-highlighting every fenced block on each preview is wasted work: the
// preview replaces the whole HTML, but most blocks keep the same text and
// language while the user types elsewhere. The cache is bounded so a long
// editing session cannot grow it without limit.
const highlightCache = new Map();
const maxHighlightCacheEntries = 256;
const maxCachedSourceLength = 64 * 1024;

export function highlightCode(source, language = '') {
    const normalizedLanguage = language.trim().toLowerCase();
    const cacheable = source.length <= maxCachedSourceLength;
    const cacheKey = `${normalizedLanguage}\x00${source}`;
    if (cacheable) {
        const cached = highlightCache.get(cacheKey);
        if (cached !== undefined) return cached;
    }
    const highlighter = globalThis.hljs;
    let html;
    if (!highlighter || !normalizedLanguage || !highlighter.getLanguage(normalizedLanguage)) {
        html = escapeHTML(source);
    } else {
        html = highlighter.highlight(source, {
            language: normalizedLanguage,
            ignoreIllegals: true
        }).value;
    }
    if (cacheable) {
        if (highlightCache.size >= maxHighlightCacheEntries) {
            highlightCache.delete(highlightCache.keys().next().value);
        }
        highlightCache.set(cacheKey, html);
    }
    return html;
}
