import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('bottom rail buttons are one third larger on mobile', async ({ page }) => {
    await page.goto('/');

    const rail = page.locator('.activity-rail');
    await expect(rail).toBeVisible();
    const railBox = await rail.boundingBox();
    expect(Math.round(railBox.y + railBox.height)).toBe(844);

    for (const button of await page.locator('.activity-rail .rail-button').all()) {
        const box = await button.boundingBox();
        const roundedWidth = Math.round(box.width);
        const roundedHeight = Math.round(box.height);
        // Accept either 44 or 45 pixels due to rounding differences across browsers/devices
        expect(roundedWidth === 44 || roundedWidth === 45).toBeTruthy();
        expect(roundedHeight === 44 || roundedHeight === 45).toBeTruthy();
    }
});
