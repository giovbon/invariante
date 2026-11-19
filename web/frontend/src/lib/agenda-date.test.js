import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
    agendaWeekLabel,
    formatAgendaItemDate,
    normalizePortugueseDates,
    parseAgendaInput,
    startOfAgendaWeek
} from './agenda-date.js';

// The vendored chrono bundle is a classic script that publishes a global, so
// the test loads it in a context and hands the parser to parseAgendaInput.
const chronoContext = vm.createContext({});
vm.runInContext(
    readFileSync(new URL('../../vendor/chrono/chrono.min.js', import.meta.url), 'utf8'),
    chronoContext
);
const chrono = chronoContext.chrono;

const now = new Date(2026, 10, 18, 12, 0, 0); // Wednesday, 18 Nov 2026.

function parse(text) {
    return parseAgendaInput(text, { now, chrono });
}

function parts(date) {
    return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
}

test('normaliza dias da semana sem "-feira"', () => {
    assert.equal(normalizePortugueseDates('reunião sexta 15h', now), 'reunião sexta-feira 15:00');
    assert.equal(normalizePortugueseDates('reunião terça 9h', now), 'reunião terça-feira 9:00');
    // The full form must not be duplicated.
    assert.equal(normalizePortugueseDates('sexta-feira 15h', now), 'sexta-feira 15:00');
});

test('resolve expressões relativas uma vez', () => {
    assert.equal(normalizePortugueseDates('daqui a 3 dias', now), '21/11/2026');
    assert.equal(normalizePortugueseDates('em 2 semanas', now), '02/12/2026');
    assert.equal(normalizePortugueseDates('próxima semana', now), '25/11/2026');
    assert.equal(normalizePortugueseDates('depois de amanhã 10h', now), '20/11/2026 10:00');
});

test('converte "dia N" para a próxima ocorrência', () => {
    assert.equal(normalizePortugueseDates('almoço dia 20', now), 'almoço 20/11/2026');
    assert.equal(normalizePortugueseDates('almoço dia 5', now), 'almoço 05/12/2026');
    // Explicit months belong to chrono.
    assert.equal(normalizePortugueseDates('dia 25 de dezembro', now), 'dia 25 de dezembro');
});

test('interpreta data e hora e separa o título', () => {
    const friday = parse('dentista sexta 15h');
    assert.equal(friday.error, undefined);
    assert.equal(friday.title, 'dentista');
    assert.deepEqual(parts(friday.date), [2026, 11, 20, 15, 0]);

    const explicit = parse('Dentista 25/11 às 15h');
    assert.equal(explicit.title, 'Dentista');
    assert.deepEqual(parts(explicit.date), [2026, 11, 25, 15, 0]);
});

test('usa 09:00 quando o texto não traz horário', () => {
    const result = parse('aniversário 05/12');
    assert.equal(result.title, 'aniversário');
    assert.deepEqual(parts(result.date), [2026, 12, 5, 9, 0]);

    const relative = parse('consulta daqui a 3 dias');
    assert.deepEqual(parts(relative.date), [2026, 11, 21, 9, 0]);
});

test('mantém o horário em expressões relativas com hora', () => {
    const result = parse('remédio daqui a 2 horas');
    assert.deepEqual(parts(result.date), [2026, 11, 18, 14, 0]);
});

test('recusa texto sem data', () => {
    const result = parse('comprar pão');
    assert.match(result.error, /Não encontrei uma data/);
});

test('cai para "Compromisso" quando só a data foi escrita', () => {
    const result = parse('25/11 às 15h');
    assert.equal(result.title, 'Compromisso');
    assert.deepEqual(parts(result.date), [2026, 11, 25, 15, 0]);
});

test('agrupa semanas a partir de segunda-feira', () => {
    const week = startOfAgendaWeek(now);
    assert.deepEqual(parts(week), [2026, 11, 16, 0, 0]);
    assert.equal(agendaWeekLabel(week, now), 'Esta semana');
    assert.equal(agendaWeekLabel(new Date(2026, 10, 23), now), 'Próxima semana');
    assert.equal(agendaWeekLabel(new Date(2026, 10, 9), now), 'Semana passada');
    assert.equal(agendaWeekLabel(new Date(2026, 11, 7), now), 'Semana de 07/12');
    assert.equal(agendaWeekLabel(new Date(2027, 0, 4), now), 'Semana de 04/01/2027');
});

test('formata a data do item com o ano apenas quando necessário', () => {
    assert.equal(formatAgendaItemDate(new Date(2026, 10, 20, 15, 0), now), 'sex 20/11 · 15:00');
    assert.equal(formatAgendaItemDate(new Date(2027, 0, 4, 9, 30), now), 'seg 04/01/2027 · 09:30');
});
