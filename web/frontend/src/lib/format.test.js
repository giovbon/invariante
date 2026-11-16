import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFileSize } from './format.js';

test('formats attachment sizes', () => {
    assert.equal(formatFileSize(0), '0 B');
    assert.equal(formatFileSize(1023), '1023 B');
    assert.equal(formatFileSize(1024), '1.0 KB');
    assert.equal(formatFileSize(1536), '1.5 KB');
    assert.equal(formatFileSize(1024 * 1024), '1.0 MB');
});
