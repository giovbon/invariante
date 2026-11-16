import { test, expect } from '@playwright/test';

test('opens HELP.md from the top bar and closes the dialog', async ({ page }) => {
    await page.goto('/');

    await page.locator('#helpButton').click();
    await expect(page.locator('#helpDialog')).toBeVisible();
    await expect(page.locator('#helpContent h1')).toHaveText('Central de ajuda');
    await expect(page.locator('#helpContent')).toContainText('HELP.md');

    await page.locator('#closeHelp').click();
    await expect(page.locator('#helpDialog')).not.toBeVisible();
    await expect(page.locator('#helpButton')).toHaveAttribute('aria-expanded', 'false');
});
