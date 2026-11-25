import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test('creates, renames and deletes a folder from the explorer', async ({ page }) => {
    const name = uniqueTitle('Pasta E2E');
    const renamed = `${name} renomeada`;
    await page.goto('/');

    page.once('dialog', dialog => dialog.accept(name));
    await page.locator('#workspacePanel [data-create-folder]').click({ force: true });
    const folderButton = page.locator(`#workspacePanel [data-folder="${name}"]`);
    await expect(folderButton).toBeVisible();

    page.once('dialog', dialog => dialog.accept(renamed));
    await folderButton.hover();
    await page.locator(`#workspacePanel [data-rename-folder="${name}"]`).click({ force: true });
    const renamedButton = page.locator(`#workspacePanel [data-folder="${renamed}"]`);
    await expect(renamedButton).toBeVisible();

    page.once('dialog', dialog => dialog.accept());
    await renamedButton.hover();
    await page.locator(`#workspacePanel [data-delete-folder="${renamed}"]`).click({ force: true });
    await expect(page.locator(`#workspacePanel [data-folder="${renamed}"]`)).toHaveCount(0);
});

test('expands and collapses folders in place', async ({ page, request }) => {
    const firstFolder = uniqueTitle('Pasta A');
    const secondFolder = uniqueTitle('Pasta B');
    const firstNote = await createNote(request, {
        title: uniqueTitle('Nota A'),
        folder: firstFolder,
        content: 'Primeira.'
    });
    const secondNote = await createNote(request, {
        title: uniqueTitle('Nota B'),
        folder: secondFolder,
        content: 'Segunda.'
    });

    await page.goto('/');
    const firstToggle = page.locator(`[data-toggle-folder="${firstFolder}"]`);
    const secondToggle = page.locator(`[data-toggle-folder="${secondFolder}"]`);
    await firstToggle.click();
    await secondToggle.click();

    const firstRow = page.locator(`[data-tree-note="${firstNote.id}"]`);
    const secondRow = page.locator(`[data-tree-note="${secondNote.id}"]`);
    await expect(firstRow).toBeVisible();
    await expect(secondRow).toBeVisible();

    await firstToggle.click();
    await expect(firstRow).toHaveCount(0);
    await expect(secondRow).toBeVisible();

    await firstToggle.click();
    await expect(firstRow).toBeVisible();
    await expect(secondRow).toBeVisible();
});
