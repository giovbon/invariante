import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test('renders note-type markmap as a mind map without CSP violations', async ({ page, request }) => {
    const title = uniqueTitle('Mapa mental');
    const content = [
        '---',
        'note-type: markmap',
        '---',
        '# Projeto',
        '',
        '## Backend',
        '- API',
        '- Banco',
        '',
        '## Frontend',
        '- Editor',
        '- Mapa'
    ].join('\n');
    const note = await createNote(request, { title, content });

    await page.addInitScript(() => {
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', event => {
            window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
        });
    });
    await page.goto(`/?note=${note.id}`);

    await expect(page.locator('#noteTitle')).toHaveValue(title);
    await expect(page.locator('#markdownPreview')).toHaveClass(/is-markmap/);
    await expect(page.locator('#markdownPreview svg.markmap')).toBeVisible();
    const nodes = page.locator('#markdownPreview .markmap-node');
    await expect(nodes.first()).toBeVisible();
    expect(await nodes.count()).toBeGreaterThan(1);
    await expect(page.locator('#markdownPreview .markmap-foreign', { hasText: 'Projeto' }))
        .toBeVisible();
    await expect(page.locator('#markdownPreview .frontmatter-properties')).toBeVisible();

    expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);

    // Editing the Markdown re-renders the map, and removing the frontmatter
    // property goes back to the regular Markdown preview.
    await page.locator('#noteContent').fill(`${content}\n\n## Novo ramo\n- Item novo`);
    await expect(page.locator('#markdownPreview .markmap-foreign', { hasText: 'Novo ramo' }))
        .toBeVisible();
    await page.locator('#noteContent').fill('---\nnote-type: markdown\n---\n# Título\n\nCorpo.');
    await expect(page.locator('#markdownPreview.is-markmap')).toHaveCount(0);
    await expect(page.locator('#markdownPreview h1')).toHaveText('Título');

    const plain = await createNote(request, {
        title: uniqueTitle('Nota normal'),
        content: '# Título\n\nCorpo renderizado.'
    });
    await page.goto(`/?note=${plain.id}`);
    await expect(page.locator('#markdownPreview.is-markmap')).toHaveCount(0);
    await expect(page.locator('#markdownPreview h1')).toHaveText('Título');
});
