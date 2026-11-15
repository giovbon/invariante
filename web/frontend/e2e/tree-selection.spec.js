import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test.describe('Folder tree selection', () => {
    test('shift-click selects a range of notes', async ({ page, request }) => {
        const folder = uniqueTitle('Selecao');
        const first = await createNote(request, {
            title: uniqueTitle('A nota'),
            folder,
            content: 'Primeira nota.'
        });
        const second = await createNote(request, {
            title: uniqueTitle('B nota'),
            folder,
            content: 'Segunda nota.'
        });

        await page.goto('/');
        await page.locator(`[data-toggle-folder="${folder}"]`).click();

        const firstNote = page.locator(`[data-tree-note="${first.id}"]`);
        const secondNote = page.locator(`[data-tree-note="${second.id}"]`);
        await expect(firstNote).toBeVisible();
        await expect(secondNote).toBeVisible();

        await firstNote.click();
        await secondNote.click({ modifiers: ['Shift'] });

        await expect(page.locator('.tree-note.is-selected')).toHaveCount(2);
        await expect(firstNote).toHaveAttribute('aria-pressed', 'true');
        await expect(secondNote).toHaveAttribute('aria-pressed', 'true');
    });

    test('dragging a selection moves every selected note', async ({ page, request }) => {
        const folder = uniqueTitle('Origem');
        const destination = uniqueTitle('Destino');
        const first = await createNote(request, {
            title: uniqueTitle('A nota'),
            folder,
            content: 'Primeira nota.'
        });
        const second = await createNote(request, {
            title: uniqueTitle('B nota'),
            folder,
            content: 'Segunda nota.'
        });

        await page.goto('/');
        await page.locator(`[data-toggle-folder="${folder}"]`).click();

        const firstNote = page.locator(`[data-tree-note="${first.id}"]`);
        const secondNote = page.locator(`[data-tree-note="${second.id}"]`);
        await expect(firstNote).toBeVisible();
        await expect(secondNote).toBeVisible();

        await firstNote.click();
        await secondNote.click({ modifiers: ['Shift'] });
        await expect(page.locator('.tree-note.is-selected')).toHaveCount(2);

        // Create the destination folder by moving a temporary note into it,
        // then drop the selection onto that folder row.
        await createNote(request, {
            title: uniqueTitle('Nota destino'),
            folder: destination,
            content: 'Destino.'
        });
        const destinationRow = page.locator(`[data-drop-folder="${destination}"]`).first();
        await expect(destinationRow).toBeVisible();

        await firstNote.dragTo(destinationRow);
        await expect(page.locator('.toast')).toContainText('2 notas movidas');

        for (const note of [first, second]) {
            const response = await request.get(`/api/notes/${note.id}`);
            expect((await response.json()).folder).toBe(destination);
        }
    });
});
