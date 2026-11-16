import { test, expect } from '@playwright/test';
import { uniqueTitle } from './helpers.js';

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
