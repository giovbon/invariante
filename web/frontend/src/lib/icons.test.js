import test from 'node:test';
import assert from 'node:assert/strict';
import { iconHTML, iconPaths } from './icons.js';

test('note icon keeps the canonical page, fold and text lines', () => {
    const parts = iconPaths('note');
    assert.deepEqual(parts.map(([part]) => part), ['page', 'fold', 'lines']);
    assert.equal(parts[0][1], 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z');
    assert.equal(parts[1][1], 'M14 2v6h6');
    assert.equal(parts[2][1], 'M16 13H8m8 4H8m5-8H8');
});

test('folder icon keeps the body and tab shared with the explorer', () => {
    const parts = iconPaths('folder');
    assert.deepEqual(parts.map(([part]) => part), ['body', 'tab']);
    assert.equal(parts[0][1], 'M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z');
    assert.equal(parts[1][1], 'M3.5 8.5v-2a2 2 0 0 1 2-2h3l2 2');
});

test('unknown icon names fall back to the note drawing', () => {
    assert.deepEqual(iconPaths('does-not-exist'), iconPaths('note'));
});

test('iconHTML serializes every path with the shared viewBox', () => {
    const html = iconHTML('note');
    assert.match(html, /^<svg viewBox="0 0 24 24" aria-hidden="true">/);
    assert.equal((html.match(/<path /g) || []).length, 3);
    assert.ok(html.includes('d="M16 13H8m8 4H8m5-8H8"'));
});
