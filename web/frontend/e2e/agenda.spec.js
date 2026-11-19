import { test, expect } from '@playwright/test';
import { uniqueTitle } from './helpers.js';

test('cria, conclui e exclui um apontamento agrupado por semana', async ({ page }) => {
    const title = uniqueTitle('Dentista');
    await page.goto('/');
    await page.locator('#agendaButton').click();

    const input = page.locator('#agendaInput');
    await expect(input).toBeVisible();
    await input.fill(`${title} sexta 15h`);
    await expect(page.locator('.agenda-preview')).toContainText('15:00');
    await page.locator('.agenda-submit').click();

    const item = page.locator('.agenda-item', { hasText: title });
    await expect(item).toHaveCount(1);
    await expect(item.locator('.agenda-item-date')).toContainText('15:00');
    await expect(page.locator('.agenda-group-title').first()).toContainText('semana');

    await item.locator('.agenda-check').check();
    await expect(page.locator('.agenda-item.is-done', { hasText: title })).toHaveCount(1);

    page.once('dialog', dialog => dialog.accept());
    await page.locator('.agenda-item', { hasText: title }).locator('.agenda-delete').click();
    await expect(page.locator('.agenda-item', { hasText: title })).toHaveCount(0);
});

test('abre as configurações de aviso da agenda', async ({ page }) => {
    await page.goto('/');
    await page.locator('#settingsButton').click();
    await expect(page.getByText('Agenda e avisos')).toBeVisible();
    await expect(page.locator('#agendaNtfyServer')).toHaveCount(0);
    await expect(page.locator('#agendaNtfyTopic')).toHaveCount(0);
    await expect(page.locator('#agendaReminderHours')).toHaveValue('24');
    await expect(page.locator('.agenda-settings-status')).toContainText('AGENDA_NTFY_TOPIC');
    await expect(page.getByRole('button', { name: 'Salvar agenda' })).toBeEnabled();
});
