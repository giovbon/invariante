import { test, expect } from '@playwright/test';
import { createNote, uniqueTitle } from './helpers.js';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

// Estes testes cobrem apenas o modo de edição do editor (o textarea sobre o
// realce de sintaxe). O ponto crítico é que o overlay e o textarea tenham
// exatamente a mesma geometria: seleção e cursor são desenhados pelo textarea,
// enquanto o texto visível vem do overlay.
async function openInEditMode(page, request, content) {
    const note = await createNote(request, { title: uniqueTitle('Editor'), content });
    await page.addInitScript(() => localStorage.setItem('editorMode', 'edit'));
    await page.goto(`/?note=${note.id}`);
    await expect(page.locator('.editor-workspace')).toHaveAttribute('data-editor-mode', 'edit');
    await expect(page.locator('#noteContent')).toHaveValue(content);
    return note;
}

async function setClipboard(page, text) {
    await page.evaluate(value => navigator.clipboard.writeText(value), text);
}

test('o realce mantém a geometria do textarea com marcadores e blocos de código', async ({ page, request }) => {
    const content = [
        'TODO: revisar isso aqui e mais um texto comprido para a linha quebrar em algum ponto previsível do editor',
        'FIXME: outro marcador no meio da linha, seguido de **forte**, *ênfase*, `código` e [[um link]]',
        '',
        '```javascript',
        '// FIXME: comentário longo dentro do bloco de código que também quebra de linha no editor inteiro',
        'const answer = 42;',
        '```',
        '',
        'Texto normal no final.'
    ].join('\n');
    await openInEditMode(page, request, content);
    await page.waitForTimeout(400);

    const mismatches = await page.evaluate(() => {
        const ta = document.querySelector('#noteContent');
        const hl = document.querySelector('#noteContentHighlight');
        const computed = getComputedStyle(ta);
        const mirror = document.createElement('div');
        const style = mirror.style;
        for (const property of [
            'direction', 'fontFamily', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch',
            'fontSize', 'fontSizeAdjust', 'lineHeight', 'letterSpacing', 'wordSpacing',
            'tabSize', 'textIndent', 'textAlign', 'textTransform', 'textDecoration'
        ]) style[property] = computed[property];
        const paddingLeft = parseFloat(computed.paddingLeft) || 0;
        const paddingRight = parseFloat(computed.paddingRight) || 0;
        style.boxSizing = 'content-box';
        style.width = `${ta.clientWidth - paddingLeft - paddingRight}px`;
        style.padding = computed.padding;
        style.border = '0';
        style.height = 'auto';
        style.overflow = 'hidden';
        style.position = 'absolute';
        style.left = '-100000px';
        style.top = '0';
        style.visibility = 'hidden';
        style.whiteSpace = 'pre-wrap';
        style.wordWrap = 'break-word';
        style.overflowWrap = 'break-word';
        mirror.textContent = ta.value;
        document.body.append(mirror);

        const textNodes = root => {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            const nodes = [];
            let offset = 0;
            let node;
            while ((node = walker.nextNode())) {
                nodes.push({ node, start: offset });
                offset += node.data.length;
            }
            return nodes;
        };
        const rectAt = (nodes, offset, hostRect) => {
            for (const entry of nodes) {
                if (offset < entry.start || offset >= entry.start + entry.node.data.length) continue;
                const range = document.createRange();
                range.setStart(entry.node, offset - entry.start);
                range.setEnd(entry.node, offset - entry.start + 1);
                const rect = range.getClientRects()[0];
                if (!rect) return null;
                return { x: rect.left - hostRect.left, y: rect.top - hostRect.top };
            }
            return null;
        };

        const mirrorNodes = textNodes(mirror);
        const highlightNodes = textNodes(hl);
        const mirrorRect = mirror.getBoundingClientRect();
        const highlightRect = hl.getBoundingClientRect();
        const differences = [];
        for (let offset = 0; offset < ta.value.length; offset++) {
            const expected = rectAt(mirrorNodes, offset, mirrorRect);
            const actual = rectAt(highlightNodes, offset, highlightRect);
            if (!expected || !actual) continue;
            if (Math.abs(expected.x - actual.x) > 1 || Math.abs(expected.y - actual.y) > 1) {
                differences.push({
                    offset,
                    char: ta.value[offset],
                    dx: Math.round(actual.x - expected.x),
                    dy: Math.round(actual.y - expected.y)
                });
            }
        }
        mirror.remove();
        return differences;
    });

    expect(mismatches).toEqual([]);
});

test('digitando aspas, apóstrofos e parênteses o cursor não duplica fechamentos', async ({ page, request }) => {
    await openInEditMode(page, request, '');
    const textarea = page.locator('#noteContent');
    await textarea.click();

    await page.keyboard.type('"abc"');
    await expect(textarea).toHaveValue('"abc"');
    expect(await textarea.evaluate(el => el.selectionStart)).toBe(5);

    await page.keyboard.press('Control+A');
    await page.keyboard.type("don't");
    await expect(textarea).toHaveValue("don't");

    await page.keyboard.press('Control+A');
    await page.keyboard.type('(x)');
    await expect(textarea).toHaveValue('(x)');

    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('a()');
    await expect(textarea).toHaveValue('a()');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Backspace');
    await expect(textarea).toHaveValue('a');
});

test('colar conteúdo pode ser desfeito em um passo próprio, restaurando cursor e seleção', async ({ page, request }) => {
    await openInEditMode(page, request, 'original');
    const textarea = page.locator('#noteContent');
    await textarea.click();
    await page.keyboard.press('Control+A');
    await setClipboard(page, 'primeira linha\nsegunda linha\nterceira linha');
    await page.keyboard.press('Control+V');
    const pasted = 'primeira linha\nsegunda linha\nterceira linha';
    await expect(textarea).toHaveValue(pasted);
    expect(await textarea.evaluate(el => el.selectionStart)).toBe(pasted.length);

    // Volta para o meio e digita imediatamente depois do paste.
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await expect(textarea).toHaveValue('primeira linha\nsegunda linha!\nterceira linha');

    await page.keyboard.press('Control+Z');
    await expect(textarea).toHaveValue(pasted);
    expect(await textarea.evaluate(el => el.selectionStart)).toBe(pasted.length);

    await page.keyboard.press('Control+Z');
    await expect(textarea).toHaveValue('original');
    expect(await textarea.evaluate(el => el.selectionStart)).toBe(8);

    await page.keyboard.press('Control+Y');
    await expect(textarea).toHaveValue(pasted);
});

test('colar um atalho não expande o snippet', async ({ page, request }) => {
    await openInEditMode(page, request, 'antes ');
    const textarea = page.locator('#noteContent');
    await textarea.click();
    await page.keyboard.press('End');
    await setClipboard(page, ';hoje');
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(300);
    await expect(textarea).toHaveValue('antes ;hoje');
});

test('nota grande usa o texto nativo durante a digitação e recupera o realce depois', async ({ page, request }) => {
    const line = 'Linha com **negrito**, TODO: marcador e `código` para a nota ficar grande.';
    const content = Array.from({ length: 900 }, () => line).join('\n');
    expect(content.length).toBeGreaterThan(60_000);
    await openInEditMode(page, request, content);

    const textarea = page.locator('#noteContent');
    const sourceEditor = page.locator('.source-editor');
    await textarea.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('X');

    await expect(sourceEditor).toHaveClass(/is-plain-text/);
    await expect(textarea).toHaveValue(`${content}X`);
    expect(await textarea.evaluate(el => el.selectionStart)).toBe(content.length + 1);

    await expect(sourceEditor).not.toHaveClass(/is-plain-text/);
    await expect(page.locator('#noteContentHighlight')).not.toBeEmpty();
});
