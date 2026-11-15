import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test('long notes open scrolled to the top', async ({ page, request }) => {
    const title = uniqueTitle('Nota longa');
    const content = Array.from({ length: 250 }, (_, index) => `Linha ${index + 1} com algum texto.`).join('\n');
    const note = await createNote(request, { title, content });

    await page.goto(`/?note=${note.id}`);
    await expect(page.locator('#noteTitle')).toHaveValue(title);
    await expect(page.locator('#noteContent')).toHaveValue(content);
    // The preview render is debounced; give scroll sync time to settle.
    await page.waitForTimeout(500);

    expect(await page.locator('#noteContent').evaluate(element => element.scrollTop)).toBe(0);
    expect(await page.locator('#markdownPreview').evaluate(element => element.scrollTop)).toBe(0);
});

test('switching from reading mode keeps the reading position', async ({ page, request }) => {
    const title = uniqueTitle('Leitura posição');
    const content = Array.from({ length: 6 }, (_, chapter) => [
        `## Capítulo ${chapter + 1}`,
        '',
        ...Array.from({ length: 25 }, (_, index) =>
            `Linha ${chapter + 1}.${index + 1} com algum texto para gerar altura.`)
    ].join('\n')).join('\n\n');
    const note = await createNote(request, { title, content });
    await page.addInitScript(() => localStorage.setItem('editorMode', 'preview'));

    await page.goto(`/?note=${note.id}`);
    await expect(page.locator('#noteTitle')).toHaveValue(title);
    await expect(page.locator('.editor-workspace')).toHaveAttribute('data-editor-mode', 'preview');

    const chapter = page.locator('#markdownPreview h2', { hasText: 'Capítulo 4' });
    await chapter.scrollIntoViewIfNeeded();
    await expect.poll(() => page.locator('#markdownPreview').evaluate(element => element.scrollTop))
        .toBeGreaterThan(0);
    const previewScrollTop = await page.locator('#markdownPreview').evaluate(element => element.scrollTop);

    await page.locator('.editor-mode[data-editor-mode="edit"]').click();
    await expect(page.locator('.editor-workspace')).toHaveAttribute('data-editor-mode', 'edit');
    await expect.poll(() => page.locator('#noteContent').evaluate(element => element.scrollTop))
        .toBeGreaterThan(0);

    await page.locator('.editor-mode[data-editor-mode="preview"]').click();
    await chapter.scrollIntoViewIfNeeded();
    await page.locator('.editor-mode[data-editor-mode="split"]').click();
    await expect(page.locator('.editor-workspace')).toHaveAttribute('data-editor-mode', 'split');
    await expect.poll(() => page.locator('#noteContent').evaluate(element => element.scrollTop))
        .toBeGreaterThan(0);
    await expect.poll(() => page.locator('#markdownPreview').evaluate(element => element.scrollTop))
        .toBeGreaterThan(previewScrollTop / 2);
});

test('creates a note, autosaves, survives reload and is searchable', async ({ page }) => {
    const title = uniqueTitle('Nota E2E');
    const content = '# Título\n\nConteúdo persistido.';

    await page.addInitScript(() => {
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', event => {
            window.__cspViolations.push(event.violatedDirective);
        });
    });
    await page.goto('/');
    await page.locator('#newNote').click();
    await expect(page.locator('#editorView')).toBeVisible();
    await page.locator('#noteTitle').fill(title);
    await page.locator('#noteContent').fill(content);
    await expect(page.locator('#saveStatus')).toHaveText(/Salvo automaticamente/);
    await expect(page).toHaveURL(/note=\d+/);
    expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);

    await page.reload();
    await expect(page.locator('#noteTitle')).toHaveValue(title);
    await expect(page.locator('#noteContent')).toHaveValue(content);

    await page.locator('#homeButton').click();
    await page.locator('#searchInput').fill(title);
    await expect(page.locator('.note-card', { hasText: title })).toBeVisible();
});
