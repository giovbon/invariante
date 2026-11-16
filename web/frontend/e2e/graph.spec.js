import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test('opens the graph and renders linked notes', async ({ page, request }) => {
    const suffix = uniqueTitle('Grafo');
    const source = await createNote(request, {
        title: `${suffix} A`,
        content: `Link para [[${suffix} B]]`
    });
    const target = await createNote(request, {
        title: `${suffix} B`,
        content: 'Destino do link'
    });

    await page.goto('/');
    await page.locator('#graphButton').click();
    await expect(page.locator('#graphView')).toBeVisible();
    await expect(page.locator('#graphSummary')).toContainText('notas');
    await expect(page.locator(`#noteGraph [data-node-id="${source.id}"]`)).toBeVisible();
    await expect(page.locator(`#noteGraph [data-node-id="${target.id}"]`)).toBeVisible();
    await expect(page.locator('#noteGraph .graph-edge')).not.toHaveCount(0);

    await page.locator('#graphSearch').fill(`${suffix} A`);
    await expect(page.locator(`#noteGraph [data-node-id="${source.id}"]`)).not.toHaveClass(/is-dimmed/);

    await page.locator('#closeGraph').click();
    await expect(page.locator('#searchView')).toBeVisible();
});

test('loads the module worker used for large graph layouts', async ({ page }) => {
    await page.goto('/');
    const layout = await page.evaluate(async () => {
        const worker = new Worker('/src/lib/graph-layout-worker.js', { type: 'module' });
        try {
            return await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('worker timeout')), 5000);
                worker.addEventListener('message', event => {
                    clearTimeout(timeout);
                    resolve(event.data.layout);
                }, { once: true });
                worker.addEventListener('error', event => {
                    clearTimeout(timeout);
                    reject(new Error(event.message || 'worker error'));
                }, { once: true });
                worker.postMessage({
                    id: 1,
                    nodes: [
                        { id: 1, title: 'A', folder: '' },
                        { id: 2, title: 'B', folder: '' }
                    ],
                    edges: [{ source: 1, target: 2, type: 'wikilink' }],
                    width: 600,
                    height: 400
                });
            });
        } finally {
            worker.terminate();
        }
    });
    expect(layout.nodes).toHaveLength(2);
    expect(Number.isFinite(layout.nodes[0].x)).toBeTruthy();
    expect(layout.edges).toHaveLength(1);
});
