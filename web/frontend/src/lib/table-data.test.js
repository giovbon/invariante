import test from 'node:test';
import assert from 'node:assert/strict';
import {
    fillTableRowSearch,
    normalizeTableSearch,
    parseTablePropertyValue,
    parseTableTags,
    tableAttachmentMatches,
    tableDisplayValue,
    tableFilterRow,
    tableNoteMatches,
    tablePropertyKeys,
    tableValuesEqual
} from './table-data.js';

test('normalizes case and accents for table search', () => {
    assert.equal(normalizeTableSearch('Área de Trabalho'), 'area de trabalho');
    assert.equal(normalizeTableSearch(null), '');
});

test('finds nested values in notes and attachments', () => {
    const note = {
        title: 'Plano',
        folder: 'Projetos',
        tags: ['sqlite'],
        properties: { owner: { name: 'Giovani' }, priority: 2 }
    };
    assert.equal(tableNoteMatches(note, 'giovani'), true);
    assert.equal(tableNoteMatches(note, 'ausente'), false);
    assert.equal(tableAttachmentMatches({ filename: 'diagrama.png', media_type: 'image/png', size: 2048 }, '2.0 kb'), true);
});

test('filters note rows including attachment children', () => {
    const row = { kind: 'note', __search: ['Plano'], children: [{ kind: 'attachment', __search: ['diagrama'] }] };
    assert.equal(tableFilterRow(row, 'plano'), true);
    assert.equal(tableFilterRow(row, 'diagrama'), true);
    assert.equal(tableFilterRow(row, 'nada'), false);
});

test('collects and sorts property keys without tags', () => {
    const keys = tablePropertyKeys([
        { properties: { status: 'ativo', tags: ['x'], Prioridade: 1 } },
        { properties: { owner: { name: 'A' } } }
    ]);
    assert.deepEqual(keys, ['owner', 'Prioridade', 'status']);
});

test('renders values for the table cells', () => {
    assert.equal(tableDisplayValue(true), 'Sim');
    assert.equal(tableDisplayValue(false), 'Não');
    assert.equal(tableDisplayValue(['a', 'b']), 'a, b');
    assert.equal(tableDisplayValue({ a: 1 }), '{"a":1}');
    assert.equal(tableDisplayValue(null), '');
});

test('parses tags and typed property values', () => {
    assert.deepEqual(parseTableTags('b, a, b, '), ['b', 'a']);
    assert.deepEqual(parseTablePropertyValue('a, b', []), ['a', 'b']);
    assert.equal(parseTablePropertyValue('2,5', 0), 2.5);
    assert.equal(parseTablePropertyValue('sim', false), true);
    assert.equal(parseTablePropertyValue('nao', true), false);
    assert.deepEqual(parseTablePropertyValue('{"a":1}', {}), { a: 1 });
    assert.equal(parseTablePropertyValue('', 'old'), null);
    assert.equal(tableValuesEqual({ a: 1 }, { a: 1 }), true);
    assert.equal(tableValuesEqual([1], [2]), false);
});

test('builds a searchable value list from a table row', () => {
    const row = { children: [{ __search: ['diagrama'] }] };
    fillTableRowSearch(row, {
        title: 'Plano',
        folder: 'Projetos',
        tags: ['sqlite'],
        properties: { dono: 'Giovani' }
    });
    assert.deepEqual(row.__search, ['Plano', 'Projetos', 'sqlite', 'Giovani', 'diagrama']);
});
