import test from 'node:test';
import assert from 'node:assert/strict';
import { draftsEqual, hidesFromExplorer, tagListsEqual } from './draft-state.js';

test('compares drafts by value without serializing them', () => {
    const first = { title: 'A', folder: 'P', content: 'x' };
    assert.equal(draftsEqual(first, { ...first }), true);
    assert.equal(draftsEqual(first, { ...first, content: 'y' }), false);
    assert.equal(draftsEqual(null, null), true);
    assert.equal(draftsEqual(null, first), false);
});

test('compares tag lists in order', () => {
    assert.equal(tagListsEqual(['a', 'b'], ['a', 'b']), true);
    assert.equal(tagListsEqual(['a', 'b'], ['b', 'a']), false);
    assert.equal(tagListsEqual(undefined, []), true);
    assert.equal(tagListsEqual(['a'], []), false);
});

test('detects hide_from_explorer and ignores unrelated frontmatter', () => {
    assert.equal(hidesFromExplorer('---\nhide_from_explorer: true\n---\nbody'), true);
    assert.equal(hidesFromExplorer('---\nhide_from_explorer: "true"\n---\nbody'), true);
    assert.equal(hidesFromExplorer('---\nhide_from_explorer: false\n---\nbody'), false);
    assert.equal(hidesFromExplorer('---\nother: true\n---\nbody'), false);
    assert.equal(hidesFromExplorer('texto sem frontmatter'), false);
    assert.equal(hidesFromExplorer(''), false);
});
