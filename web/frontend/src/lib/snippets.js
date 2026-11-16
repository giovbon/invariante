// Snippets de digitação do editor: digitar `;nome` (ou `;nome<Tab>`) expande
// o atalho no próprio cursor. A lógica é pura para poder ser testada sem DOM.

const pad = value => String(value).padStart(2, '0');

export const MAX_TABLE_COLUMNS = 12;
export const MAX_TABLE_ROWS = 20;

export function formatISODate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatShortDate(date) {
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

export function formatClock(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const weekdays = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
    'quinta-feira', 'sexta-feira', 'sábado'];

export function formatWeekday(date) {
    return `${weekdays[date.getDay()]}, ${formatShortDate(date)}`;
}

function shiftDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function buildTableMarkdown(columns = 2, rows = 2) {
    const headers = Array.from({ length: columns }, (_, index) => `Coluna ${index + 1}`);
    const separator = Array.from({ length: columns }, () => '---');
    const empty = Array.from({ length: columns }, () => ' ');
    const lines = [
        `| ${headers.join(' | ')} |`,
        `| ${separator.join(' | ')} |`,
        ...Array.from({ length: rows }, () => `| ${empty.join(' | ')} |`)
    ];
    const text = lines.join('\n');
    const selectStart = text.indexOf('Coluna 1');
    return { text, selectStart, selectEnd: selectStart + 'Coluna 1'.length };
}

export const SNIPPETS = {
    ';hoje': now => ({ text: formatISODate(now) }),
    ';data': now => ({ text: formatShortDate(now) }),
    ';hora': now => ({ text: formatClock(now) }),
    ';dia': now => ({ text: formatWeekday(now) }),
    ';amanha': now => ({ text: formatISODate(shiftDays(now, 1)) }),
    ';ontem': now => ({ text: formatISODate(shiftDays(now, -1)) })
};

export const SNIPPET_TRIGGERS = Object.freeze([...Object.keys(SNIPPETS), ';tabelaNxM']);

// O gatilho só vale no começo de uma palavra, para não estragar textos como
// "10;hoje" ou URLs. A tabela exige as dimensões: `;tabela3x4` cria 3 colunas
// e 4 linhas de corpo.
const triggerPattern = /(^|[\s([{>])(;[\p{L}]+(?:\d+[xX×]\d+)?)$/u;
const tablePattern = /^;tabela(\d+)[xX×](\d+)$/;

export function matchSnippet(value, caret, now = new Date()) {
    const match = value.slice(0, caret).match(triggerPattern);
    if (!match) return null;
    const token = match[2].toLowerCase();
    const start = caret - token.length;
    const table = token.match(tablePattern);
    if (table) {
        const columns = clamp(Number(table[1]), 1, MAX_TABLE_COLUMNS);
        const rows = clamp(Number(table[2]), 1, MAX_TABLE_ROWS);
        return { start, ...buildTableMarkdown(columns, rows) };
    }
    const build = SNIPPETS[token];
    if (!build) return null;
    return { start, ...build(now) };
}
