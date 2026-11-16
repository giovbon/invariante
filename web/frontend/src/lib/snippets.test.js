import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSnippet } from './snippets.js';

const fixedDate = new Date(2026, 10, 16, 9, 5);

test('expands the date snippets from the current date', () => {
    assert.equal(matchSnippet(';hoje', 5, fixedDate).text, '2026-11-16');
    assert.equal(matchSnippet(';data', 5, fixedDate).text, '16/11/2026');
    assert.equal(matchSnippet(';hora', 5, fixedDate).text, '09:05');
    assert.equal(matchSnippet(';dia', 4, fixedDate).text, 'segunda-feira, 16/11/2026');
    assert.equal(matchSnippet(';amanha', 7, fixedDate).text, '2026-11-17');
    assert.equal(matchSnippet(';ontem', 6, fixedDate).text, '2026-11-15');
});

test('reports where the snippet starts so the trigger is replaced', () => {
    const match = matchSnippet('nota: ;hoje', 11, fixedDate);
    assert.equal(match.start, 6);
});

test('ignores triggers glued to a word', () => {
    assert.equal(matchSnippet('10;hoje', 7, fixedDate), null);
    assert.equal(matchSnippet(';desconhecido', 13, fixedDate), null);
});

test('builds tables with the requested number of columns and rows', () => {
    const result = matchSnippet(';tabela3x4', 10, fixedDate);
    assert.equal(result.text, [
        '| Coluna 1 | Coluna 2 | Coluna 3 |',
        '| --- | --- | --- |',
        '|   |   |   |',
        '|   |   |   |',
        '|   |   |   |',
        '|   |   |   |'
    ].join('\n'));
    assert.equal(result.text.slice(result.selectStart, result.selectEnd), 'Coluna 1');
});

test('requires table dimensions before expanding', () => {
    assert.equal(matchSnippet(';tabela', 7, fixedDate), null);
    assert.equal(matchSnippet(';tabela2x', 9, fixedDate), null);
    assert.equal(matchSnippet(';tabela2x3', 10, fixedDate).text.split('\n').length, 5);
});

test('clamps the table dimensions', () => {
    const wide = matchSnippet(';tabela99x99', 12, fixedDate);
    assert.equal(wide.text.split('\n')[0].split('|').length - 2, 12);
    assert.equal(wide.text.split('\n').length, 2 + 20);
});
