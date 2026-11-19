import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test.describe('Tabulator table mode', () => {
    test('tree expansion shows attachments with open/download actions', async ({ page, request }) => {
        const folder = uniqueTitle('AnexosTable');
        const title = uniqueTitle('Nota com anexos');
        const note = await createNote(request, {
            title,
            folder,
            content: 'Esta nota tem anexos.'
        });

        const form1 = new FormData();
        form1.append('file', new Blob(['conteúdo png'], { type: 'image/png' }), 'diagrama.png');
        await request.post(`/api/notes/${note.id}/attachments`, { multipart: form1 });

        const form2 = new FormData();
        form2.append('file', new Blob(['conteúdo pdf'], { type: 'application/pdf' }), 'relatorio.pdf');
        await request.post(`/api/notes/${note.id}/attachments`, { multipart: form2 });

        await page.goto('/');
        await page.locator('.mode-button[data-mode="table"]').click();
        await page.waitForSelector('.tabulator-row.is-note-row', { timeout: 10000 });

        const noteRow = page.locator('.tabulator-row.is-note-row', { hasText: title });
        await expect(noteRow).toBeVisible();

        const expandButton = noteRow.locator('.tabulator-data-tree-control');
        await expandButton.click();
        await page.waitForTimeout(200);

        const attachmentRows = page.locator('.tabulator-row.is-attachment-row');
        await expect(attachmentRows).toHaveCount(2);

        await expect(attachmentRows.nth(0).locator('.table-file-name')).toContainText('diagrama.png');
        await expect(attachmentRows.nth(0).locator('.table-file-type')).toContainText('PNG');
        await expect(attachmentRows.nth(1).locator('.table-file-name')).toContainText('relatorio.pdf');
        await expect(attachmentRows.nth(1).locator('.table-file-type')).toContainText('PDF');

        await expect(attachmentRows.nth(0).locator('.table-action[title="Abrir anexo"]')).toBeVisible();
        await expect(attachmentRows.nth(0).locator('.table-action[title="Baixar anexo"]')).toBeVisible();
    });

    test('allows hiding frontmatter columns', async ({ page, request }) => {
        const folder = uniqueTitle('ColunasTable');
        await createNote(request, {
            title: uniqueTitle('Nota com propriedades'),
            folder,
            content: '---\nstatus: ativo\nautor: Ana\n---\n\nConteúdo.'
        });
        await request.put('/api/table-columns', { data: { hidden: [] } });

        await page.goto('/');
        await page.locator(`[data-folder="${folder}"]`).click();
        await page.locator('.mode-button[data-mode="table"]').click();
        await page.waitForSelector('.tabulator-row.is-note-row', { timeout: 10000 });

        const statusColumn = page.locator('.tabulator-col-title', { hasText: /^status$/ });
        await expect(statusColumn).toBeVisible();

        await page.locator('.table-columns-toggle').click();
        const statusToggle = page.locator('#tableColumnsList input[data-table-column="status"]');
        await expect(statusToggle).toBeChecked();
        await statusToggle.uncheck();

        await expect(statusColumn).toHaveCount(0);
        await expect(page.locator('.tabulator-col-title', { hasText: /^autor$/ })).toBeVisible();
        await expect.poll(async () => {
            const response = await request.get('/api/table-columns');
            return (await response.json()).hidden;
        }).toEqual(['status']);

        // The selection lives on the server, so a fresh browser session keeps
        // the hidden column instead of showing the whole frontmatter again.
        await page.reload();
        await page.locator(`[data-folder="${folder}"]`).click();
        await page.locator('.mode-button[data-mode="table"]').click();
        await page.waitForSelector('.tabulator-row.is-note-row', { timeout: 10000 });
        await expect(page.locator('.tabulator-col-title', { hasText: /^status$/ })).toHaveCount(0);
        await expect(page.locator('.tabulator-col-title', { hasText: /^autor$/ })).toBeVisible();

        await page.locator('.table-columns-toggle').click();
        await page.locator('#tableColumnsAll').click();
        await expect(page.locator('.tabulator-col-title', { hasText: /^status$/ })).toBeVisible();
        await expect.poll(async () => {
            const response = await request.get('/api/table-columns');
            return (await response.json()).hidden;
        }).toEqual([]);
    });

    test('edits tags and frontmatter properties directly in the table', async ({ page, request }) => {
        const folder = uniqueTitle('EdicaoTable');
        const title = uniqueTitle('Nota editável');
        const note = await createNote(request, {
            title,
            folder,
            tags: ['inicial'],
            content: '---\nstatus: ativo\n---\n\nConteúdo.'
        });

        await page.goto('/');
        await page.locator(`[data-folder="${folder}"]`).click();
        await page.locator('.mode-button[data-mode="table"]').click();
        await page.waitForSelector('.tabulator-row.is-note-row', { timeout: 10000 });

        const row = page.locator('.tabulator-row.is-note-row', { hasText: title }).first();
        await expect(row).toBeVisible();

        const tagsCell = row.locator('.tabulator-cell[tabulator-field="tags"]');
        await expect(tagsCell).toContainText('inicial');

        await tagsCell.dblclick();
        const tagsEditor = page.locator('.table-cell-editor');
        await expect(tagsEditor).toBeVisible();
        await tagsEditor.fill('task, oasis');
        const tagsSaved = page.waitForResponse(response =>
            response.url().endsWith(`/api/notes/${note.id}`) &&
            response.request().method() === 'PUT'
        );
        await tagsEditor.press('Enter');
        await tagsSaved;

        await expect(tagsCell).toContainText('task');
        await expect(tagsCell).toContainText('oasis');

        let saved = await (await request.get(`/api/notes/${note.id}`)).json();
        expect(saved.content).toContain('tags:');
        expect(saved.content).toContain('task');
        expect(saved.content).toContain('oasis');
        expect(saved.tags).toEqual(expect.arrayContaining(['task', 'oasis']));

        // Removing a tag rewrites the frontmatter list.
        await tagsCell.dblclick();
        await page.locator('.table-cell-editor').fill('task');
        const tagsRemoved = page.waitForResponse(response =>
            response.url().endsWith(`/api/notes/${note.id}`) &&
            response.request().method() === 'PUT'
        );
        await page.locator('.table-cell-editor').press('Enter');
        await tagsRemoved;

        saved = await (await request.get(`/api/notes/${note.id}`)).json();
        expect(saved.tags).toEqual(['task']);

        const statusCell = row.locator('.tabulator-cell[tabulator-field="property:status"]');
        await expect(statusCell).toContainText('ativo');
        await statusCell.dblclick();
        await page.locator('.table-cell-editor').fill('concluido');
        const statusSaved = page.waitForResponse(response =>
            response.url().endsWith(`/api/notes/${note.id}`) &&
            response.request().method() === 'PUT'
        );
        await page.locator('.table-cell-editor').press('Enter');
        await statusSaved;

        await expect(statusCell).toContainText('concluido');
        saved = await (await request.get(`/api/notes/${note.id}`)).json();
        expect(saved.content).toContain('status: concluido');
    });

    test('editing a frontmatter property preserves tags stored only in the database', async ({ page, request }) => {
        const folder = uniqueTitle('TagsPreservadas');
        const title = uniqueTitle('Nota com tag no banco');
        const note = await createNote(request, {
            title,
            folder,
            tags: ['preservada'],
            content: '---\nstatus: ativo\n---\n\nConteúdo.'
        });

        await page.goto('/');
        await page.locator(`[data-folder="${folder}"]`).click();
        await page.locator('.mode-button[data-mode="table"]').click();
        await page.waitForSelector('.tabulator-row.is-note-row', { timeout: 10000 });

        const row = page.locator('.tabulator-row.is-note-row', { hasText: title }).first();
        const statusCell = row.locator('.tabulator-cell[tabulator-field="property:status"]');
        await statusCell.dblclick();
        await page.locator('.table-cell-editor').fill('concluido');
        const saved = page.waitForResponse(response =>
            response.url().endsWith(`/api/notes/${note.id}`) &&
            response.request().method() === 'PUT'
        );
        await page.locator('.table-cell-editor').press('Enter');
        await saved;

        const updated = await (await request.get(`/api/notes/${note.id}`)).json();
        expect(updated.content).toContain('status: concluido');
        expect(updated.tags).toEqual(['preservada']);
    });

    test('shows the column picker even without frontmatter properties', async ({ page, request }) => {
        const folder = uniqueTitle('SemFrontmatter');
        await createNote(request, {
            title: uniqueTitle('Nota simples'),
            folder,
            content: 'Sem metadados no frontmatter.'
        });

        await page.goto('/');
        await page.locator(`[data-folder="${folder}"]`).click();
        await page.locator('.mode-button[data-mode="table"]').click();
        await page.waitForSelector('.tabulator-row.is-note-row', { timeout: 10000 });

        await expect(page.locator('.table-columns-toggle')).toBeVisible();
        await page.locator('.table-columns-toggle').click();
        await expect(page.locator('#tableColumnsEmpty')).toBeVisible();
        await expect(page.locator('#tableColumnsAll')).toBeDisabled();
    });

    test('shows table with note rows', async ({ page, request }) => {
        const folder = uniqueTitle('ProjetosTable');
        await createNote(request, {
            title: uniqueTitle('Projeto A'),
            folder,
            content: 'Conteúdo.'
        });

        await page.goto('/');
        await page.locator('.mode-button[data-mode="table"]').click();
        await expect(page.locator('.mode-button[data-mode="table"]')).toHaveClass(/is-active/);
        await expect(page.locator('#tableView')).toBeVisible();

        await page.waitForSelector('.tabulator-row.is-note-row', { timeout: 10000 });

        // At least one note row visible
        const visibleRows = page.locator('.tabulator-row.is-note-row');
        await expect(visibleRows.first()).toBeVisible();
    });
});