import test from 'node:test';
import assert from 'node:assert/strict';
import { previewDelay } from './editor-preview.js';

test('preview debounce grows with the document size', () => {
    assert.equal(previewDelay(''), 140);
    assert.equal(previewDelay('a'.repeat(16 * 1024)), 140);
    assert.equal(previewDelay('a'.repeat(16 * 1024 + 1)), 220);
    assert.equal(previewDelay('a'.repeat(128 * 1024)), 220);
    assert.equal(previewDelay('a'.repeat(128 * 1024 + 1)), 320);
});
