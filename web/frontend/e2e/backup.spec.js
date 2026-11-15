import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test('exports notes in the folder hierarchy and attachments per note', async ({ page, request }) => {
    const folder = uniqueTitle('BackupPasta');
    const title = uniqueTitle('Backup');
    const note = await createNote(request, { title, content: 'marcador de backup', folder });

    const form = new FormData();
    form.append('file', new Blob(['anexo de backup'], { type: 'text/plain' }), 'anexo.txt');
    await request.post(`/api/notes/${note.id}/attachments`, { multipart: form });

    await page.goto('/');
    await page.locator('#settingsButton').click();
    await expect(page.locator('#panelTitle')).toHaveText('Configurações');

    await expect(page.locator('#exportBackup')).toBeVisible();
    await expect(page.locator('#importBackup')).toHaveCount(0);
    await expect(page.locator('#backupInput')).toHaveCount(0);

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#exportBackup').click();
    const download = await downloadPromise;
    const archivePath = await download.path();
    expect(archivePath).toBeTruthy();

    // Zip entry names live in the archive headers, so searching the raw file
    // is enough to assert the exported layout without an unzip dependency.
    const archive = readFileSync(archivePath);
    expect(archive.includes(`notes/${folder}/`)).toBe(true);
    expect(archive.includes(`${note.id} - ${title}.md`)).toBe(true);
    expect(archive.includes(`attachments/${note.id} - ${title}/`)).toBe(true);
});
