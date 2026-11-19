// Portuguese-friendly date parsing for the agenda input. The heavy lifting is
// done by the vendored chrono-node bundle; this module normalizes the
// expressions chrono does not understand (bare weekdays, "dia 20", "em 3
// dias") and turns the result into a stable title + Date pair.

const weekdayShort = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const weekdayLong = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

export function isChronoMatchIsolated(fullText, matchedText) {
    if (!matchedText) return false;
    const index = fullText.indexOf(matchedText);
    if (index === -1) return false;
    const before = index > 0 ? fullText[index - 1] : ' ';
    const after = index + matchedText.length < fullText.length ? fullText[index + matchedText.length] : ' ';
    const wordCharacter = /[\wáàâãéèêíìîóòôõúùûç]/i;
    return !wordCharacter.test(before) && !wordCharacter.test(after);
}

export function formatShortDate(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}/${date.getFullYear()}`;
}

export function formatAgendaDate(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${weekdayShort[date.getDay()]}, ${day}/${month}/${date.getFullYear()} às ${hours}:${minutes}`;
}

function pad(value) {
    return String(value).padStart(2, '0');
}

function nextDayOfMonth(now, day) {
    const clamp = (year, month) => Math.min(day, new Date(year, month + 1, 0).getDate());
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let candidate = new Date(now.getFullYear(), now.getMonth(), clamp(now.getFullYear(), now.getMonth()));
    if (candidate < today) {
        const nextMonth = now.getMonth() + 1;
        candidate = new Date(now.getFullYear(), nextMonth, clamp(now.getFullYear(), nextMonth));
    }
    return candidate;
}

function addUnit(now, amount, unit) {
    const date = new Date(now);
    switch (unit) {
        case 'semana':
            date.setDate(date.getDate() + amount * 7);
            break;
        case 'dia':
            date.setDate(date.getDate() + amount);
            break;
        case 'mês':
            date.setMonth(date.getMonth() + amount);
            break;
        case 'ano':
            date.setFullYear(date.getFullYear() + amount);
            break;
        case 'hora':
            date.setHours(date.getHours() + amount);
            break;
        case 'minuto':
            date.setMinutes(date.getMinutes() + amount);
            break;
        default:
            break;
    }
    return date;
}

function relativeStamp(date, withTime) {
    const day = formatShortDate(date);
    if (!withTime) return day;
    return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Rewrites expressions that chrono-node's Portuguese parser misses into
// absolute dates, before chrono runs. Relative values are resolved against
// `now` once and then stored as absolute dates by the caller.
export function normalizePortugueseDates(text, now = new Date()) {
    let result = String(text ?? '');

    // "8 pm" -> "20:00", "8:30am" -> "08:30".
    result = result.replace(/(\b\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi, (match, hour, minutes, suffix) => {
        let value = parseInt(hour, 10);
        const rest = minutes || '00';
        if (suffix.toLowerCase() === 'pm' && value < 12) value += 12;
        if (suffix.toLowerCase() === 'am' && value === 12) value = 0;
        return `${value}:${rest}`;
    });

    // "15h30" -> "15:30", "15h" -> "15:00".
    result = result.replace(/(\b\d{1,2})[hH](\d{2})?\b/g, (match, hour, minutes) => {
        return `${hour}:${minutes || '00'}`;
    });

    // "depois de amanhã" has to run before the plain "amanhã" rules. The
    // lookahead replaces \b because "ã" is not a JavaScript word character.
    const afterTomorrow = addUnit(now, 2, 'dia');
    result = result.replace(/\bdepois de amanh[ãa](?=\s|$|[,.;:!?])/gi, relativeStamp(afterTomorrow, false));

    // "em 3 dias"/"daqui a 2 semanas" and friends.
    result = result.replace(/\b(?:daqui a|em)\s+(uma?|um|\d+)\s+(semanas?|dias?|meses|m[eê]s|anos?|horas?|minutos?)\b/gi,
        (match, rawAmount, rawUnit) => {
            const lowered = rawAmount.toLowerCase();
            const amount = lowered === 'um' || lowered === 'uma' ? 1 : parseInt(lowered, 10);
            const units = {
                semana: 'semana', semanas: 'semana',
                dia: 'dia', dias: 'dia',
                mes: 'mês', mês: 'mês', meses: 'mês',
                ano: 'ano', anos: 'ano',
                hora: 'hora', horas: 'hora',
                minuto: 'minuto', minutos: 'minuto'
            };
            const unit = units[rawUnit.toLowerCase()];
            const withTime = unit === 'hora' || unit === 'minuto';
            return relativeStamp(addUnit(now, amount, unit), withTime);
        });

    // "semana que vem", "próximo mês", "próximo ano".
    result = result.replace(/\b(?:a\s+)?semana que vem\b/gi, relativeStamp(addUnit(now, 1, 'semana'), false));
    result = result.replace(/\bpr[óo]xim[ao] semana\b/gi, relativeStamp(addUnit(now, 1, 'semana'), false));
    result = result.replace(/\bm[eê]s que vem\b/gi, relativeStamp(addUnit(now, 1, 'mês'), false));
    result = result.replace(/\bpr[óo]xim[ao] m[eê]s\b/gi, relativeStamp(addUnit(now, 1, 'mês'), false));
    result = result.replace(/\bano que vem\b/gi, relativeStamp(addUnit(now, 1, 'ano'), false));
    result = result.replace(/\bpr[óo]xim[ao] ano\b/gi, relativeStamp(addUnit(now, 1, 'ano'), false));

    // "dia 20" -> "20/11" (the next time that day of the month happens).
    // "dia 25 de dezembro" is left alone because chrono understands it.
    result = result.replace(/\bdia\s+(\d{1,2})\b(?!\s*(?:de|\/))/gi, (match, rawDay) => {
        const day = parseInt(rawDay, 10);
        if (day < 1 || day > 31) return match;
        return formatShortDate(nextDayOfMonth(now, day));
    });

    // chrono only recognizes the full "-feira" forms for most weekdays.
    result = result.replace(/\b(segunda|ter[cç]a|quarta|quinta|sexta)(?!-feira)(?![\wáàâãéèêíìîóòôõúùûç])/gi, (match, day) => {
        const normalized = day.toLowerCase().replace('terca', 'terça');
        return `${normalized}-feira`;
    });
    result = result.replace(/\b(s[áa]b)\b/gi, 'sábado');
    result = result.replace(/\bdom\b/gi, 'domingo');

    return result;
}

function cleanAgendaTitle(raw) {
    let title = String(raw ?? '')
        .replace(/^[\s\-–—,;:.]+/, '')
        .replace(/[\s\-–—,;:.]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    // The date token often leaves a connector behind ("reunião dia",
    // "às 15:00"); trim those at both ends without touching the inner text.
    for (let pass = 0; pass < 3; pass += 1) {
        const cleaned = title
            .replace(/^(?:às|as|no dia|dia|de|em)\s+/i, '')
            .replace(/\s+(?:às|as|no dia|dia|de|em)$/i, '')
            .trim();
        if (cleaned === title) break;
        title = cleaned;
    }
    return title.slice(0, 500);
}

const timePattern = /(?:\d{1,2}:\d{2})|(?:meio-dia)|(?:\b\d{1,2}\s*(?:am|pm)\b)/i;

// Turns free text into { date, title } using chrono. Returns { error } when no
// date could be found, so the caller can refuse to save an undated entry.
export function parseAgendaInput(text, { now = new Date(), chrono = globalThis.chrono } = {}) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return { error: 'Escreva o compromisso e a data.' };
    const chronoPt = chrono?.pt;
    if (!chronoPt || typeof chronoPt.parse !== 'function') {
        return { error: 'O interpretador de datas não carregou. Recarregue a página.' };
    }

    const normalized = normalizePortugueseDates(trimmed, now);
    let results = [];
    try {
        results = chronoPt.parse(normalized, now, { forwardDate: true }) || [];
    } catch {
        results = [];
    }
    const match = results.find(result => isChronoMatchIsolated(normalized, result.text));
    if (!match) {
        return { error: 'Não encontrei uma data. Tente “sexta 15h”, “25/11 14:30” ou “daqui a 3 dias”.' };
    }
    const date = match.start?.date?.();
    if (!date || typeof date.getTime !== 'function' || Number.isNaN(date.getTime())) {
        return { error: 'Não consegui entender essa data. Tente outro formato.' };
    }
    if (!timePattern.test(match.text)) {
        // A date without a time is an all-day commitment; 09:00 reads better
        // than "the exact moment the text was typed".
        date.setHours(9, 0, 0, 0);
    }
    const title = cleanAgendaTitle(normalized.replace(match.text, ' ')) || 'Compromisso';
    return { date, title };
}

export function startOfAgendaWeek(date) {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const offset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - offset);
    return start;
}

export function agendaWeekLabel(weekStart, now = new Date()) {
    const current = startOfAgendaWeek(now);
    const difference = Math.round((weekStart.getTime() - current.getTime()) / (7 * 24 * 60 * 60 * 1000));
    if (difference === 0) return 'Esta semana';
    if (difference === 1) return 'Próxima semana';
    if (difference === -1) return 'Semana passada';
    const day = String(weekStart.getDate()).padStart(2, '0');
    const month = String(weekStart.getMonth() + 1).padStart(2, '0');
    const suffix = weekStart.getFullYear() === now.getFullYear() ? '' : `/${weekStart.getFullYear()}`;
    return `Semana de ${day}/${month}${suffix}`;
}

export function formatAgendaItemDate(date, now = new Date()) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear() === now.getFullYear() ? '' : `/${date.getFullYear()}`;
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${weekdayShort[date.getDay()]} ${day}/${month}${year} · ${hours}:${minutes}`;
}

export function weekdayName(date) {
    return weekdayLong[date.getDay()];
}
