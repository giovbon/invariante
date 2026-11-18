import test from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR_HIGHLIGHT_MAX_LENGTH, diffLineRanges, ensureFrontmatterTags, extractMarkdownOutline, frontmatterLineOffset, highlightMarkdown, indentSelection, isMarkmapNote, MarkdownEditor, noteType, parseFrontmatter, planHighlightUpdate, renderMarkdownLines, setFrontmatterProperty, shouldRenderEditorHighlight, stripFrontmatter } from './markdown-editor.js';
import { formatISODate } from './snippets.js';

function createTextarea(value, start = 0, end = start) {
    return {
        value,
        selectionStart: start,
        selectionEnd: end,
        focus() {},
        setSelectionRange(nextStart, nextEnd) {
            this.selectionStart = nextStart;
            this.selectionEnd = nextEnd;
        }
    };
}

test('indents selected lines and preserves the selection', () => {
    const result = indentSelection('one\ntwo\nthree', 0, 7);
    assert.equal(result.value, '    one\n    two\nthree');
    assert.equal(result.start, 4);
    assert.equal(result.end, 15);
});

test('outdents selected lines without removing unselected lines', () => {
    const result = indentSelection('    one\n    two\nthree', 4, 15, true);
    assert.equal(result.value, 'one\ntwo\nthree');
});

test('Indents the whole line when the caret is inside it', () => {
    const result = indentSelection('- item', 6, 6);
    assert.equal(result.value, '    - item');
    assert.equal(result.start, 10);
});

test('keeps inserting spaces when the caret is on the leading indentation', () => {
    const result = indentSelection('item', 0, 0);
    assert.equal(result.value, '    item');
    assert.equal(result.start, 4);
});

test('wraps the selection when typing a Markdown marker', () => {
    for (const [key, expected] of [['*', '*hello*'], ['_', '_hello_'], ['`', '`hello`']]) {
        const textarea = createTextarea('hello', 0, 5);
        const editor = new MarkdownEditor(textarea, () => {});
        let prevented = false;
        editor.handleKeydown({ key, ctrlKey: false, metaKey: false, altKey: false, preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        assert.equal(textarea.value, expected);
        assert.equal(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd), 'hello');
    }
});

test('wrapping twice with the same marker creates bold text', () => {
    const textarea = createTextarea('hello', 0, 5);
    const editor = new MarkdownEditor(textarea, () => {});
    const event = () => ({ key: '*', ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
    editor.handleKeydown(event());
    editor.handleKeydown(event());
    assert.equal(textarea.value, '**hello**');
});

test('Tab indents the whole list item and Shift+Tab outdents it', () => {
    const textarea = createTextarea('- item', 6);
    const editor = new MarkdownEditor(textarea, () => {});
    editor.handleKeydown({ key: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
    assert.equal(textarea.value, '    - item');
    assert.equal(textarea.selectionStart, 10);
    editor.handleKeydown({ key: 'Tab', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
    assert.equal(textarea.value, '- item');
    assert.equal(textarea.selectionStart, 6);
});

test('expands a date snippet while typing and keeps the undo working', () => {
    const textarea = createTextarea('', 0);
    const editor = new MarkdownEditor(textarea, () => {});
    textarea.value = ';hoje';
    textarea.setSelectionRange(5, 5);
    editor.handleInput();
    assert.equal(textarea.value, formatISODate(new Date()));
    assert.equal(textarea.selectionStart, textarea.value.length);
});

test('expands the table snippet with the typed dimensions', () => {
    const textarea = createTextarea('', 0);
    const changes = [];
    const editor = new MarkdownEditor(textarea, value => changes.push(value));
    textarea.value = ';tabela2x3';
    textarea.setSelectionRange(10, 10);
    editor.handleInput();
    assert.equal(textarea.value.split('\n').length, 5);
    assert.equal(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd), 'Coluna 1');
    assert.equal(changes.at(-1), textarea.value);
});

test('Tab expands a pending snippet instead of indenting the line', () => {
    const textarea = createTextarea('- item ;tabela2x3', 17);
    const editor = new MarkdownEditor(textarea, () => {});
    let prevented = false;
    editor.handleKeydown({ key: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.ok(textarea.value.startsWith('- item | Coluna 1 | Coluna 2 |'));
    assert.ok(!textarea.value.startsWith('    - item'));
});

test('keeps Tab indenting when there is no snippet to expand', () => {
    const textarea = createTextarea('- item', 6);
    const editor = new MarkdownEditor(textarea, () => {});
    editor.handleKeydown({ key: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
    assert.equal(textarea.value, '    - item');
});

test('formats a selection and supports undo/redo', () => {
    const textarea = createTextarea('hello', 0, 5);
    const changes = [];
    const editor = new MarkdownEditor(textarea, value => changes.push(value));
    editor.format('bold');
    assert.equal(textarea.value, '**hello**');
    editor.undo();
    assert.equal(textarea.value, 'hello');
    editor.redo();
    assert.equal(textarea.value, '**hello**');
    assert.deepEqual(changes, ['**hello**', 'hello', '**hello**']);
});

function keyEvent(key, overrides = {}) {
    return {
        key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault() {},
        ...overrides
    };
}

test('não indenta a linha seguinte quando a seleção termina no início dela', () => {
    // "one\ntwo\n" selecionado: o \n final pertence à seleção, "three" não.
    const result = indentSelection('one\ntwo\nthree', 0, 8);
    assert.equal(result.value, '    one\n    two\nthree');
    assert.equal(result.start, 4);
    assert.equal(result.end, 16);
});

test('mantém a linha seguinte intacta ao formatar seleção que termina em quebra de linha', () => {
    const textarea = createTextarea('one\ntwo\nthree', 0, 8);
    const editor = new MarkdownEditor(textarea, () => {});
    editor.format('unordered');
    assert.equal(textarea.value, '- one\n- two\nthree');
});

test('undo devolve a seleção e a rolagem do passo desfeito', () => {
    const textarea = createTextarea('hello', 0, 3);
    textarea.scrollTop = 40;
    textarea.scrollLeft = 2;
    const editor = new MarkdownEditor(textarea, () => {});
    textarea.value = 'hello world';
    textarea.setSelectionRange(8, 11);
    textarea.scrollTop = 120;
    editor.handleInput({ inputType: 'insertText' });

    editor.undo();
    assert.equal(textarea.value, 'hello');
    assert.equal(textarea.selectionStart, 0);
    assert.equal(textarea.selectionEnd, 3);
    assert.equal(textarea.scrollTop, 40);

    editor.redo();
    assert.equal(textarea.value, 'hello world');
    assert.equal(textarea.selectionStart, 8);
    assert.equal(textarea.selectionEnd, 11);
    assert.equal(textarea.scrollTop, 120);
});

test('colar cria um passo próprio de undo e não é engolido pela digitação seguinte', () => {
    const textarea = createTextarea('original', 0);
    const editor = new MarkdownEditor(textarea, () => {});
    textarea.value = 'original colado';
    textarea.setSelectionRange(15, 15);
    // Mesmo com um input recente, colar não pode se fundir com a digitação.
    editor.lastInputAt = Date.now();
    editor.lastInputKind = 'type';
    editor.handleInput({ inputType: 'insertFromPaste' });

    textarea.value = 'original colado!';
    textarea.setSelectionRange(17, 17);
    editor.handleInput({ inputType: 'insertText' });

    editor.undo();
    assert.equal(textarea.value, 'original colado');
    assert.equal(textarea.selectionStart, 15);
    editor.undo();
    assert.equal(textarea.value, 'original');
});

test('digitação rápida continua agrupada em um único passo de undo', () => {
    const textarea = createTextarea('', 0);
    const editor = new MarkdownEditor(textarea, () => {});
    for (const value of ['a', 'ab', 'abc']) {
        textarea.value = value;
        textarea.setSelectionRange(value.length, value.length);
        editor.handleInput({ inputType: 'insertText' });
    }
    assert.equal(editor.history.length, 2);
    editor.undo();
    assert.equal(textarea.value, '');
});

test('colar um atalho de snippet não o expande', () => {
    const textarea = createTextarea('', 0);
    const editor = new MarkdownEditor(textarea, () => {});
    textarea.value = ';hoje';
    textarea.setSelectionRange(5, 5);
    editor.handleInput({ inputType: 'insertFromPaste' });
    assert.equal(textarea.value, ';hoje');
});

test('composição de acentos registra um único passo e não expande snippets', () => {
    const textarea = createTextarea('', 0);
    const editor = new MarkdownEditor(textarea, () => {});
    editor.handleCompositionStart();
    textarea.value = 'a';
    textarea.setSelectionRange(1, 1);
    editor.handleInput({ inputType: 'insertCompositionText' });
    textarea.value = 'á';
    textarea.setSelectionRange(1, 1);
    editor.handleInput({ inputType: 'insertCompositionText' });
    assert.equal(editor.history.length, 1);

    editor.handleCompositionEnd();
    assert.equal(editor.history.length, 2);
    editor.undo();
    assert.equal(textarea.value, '');
});

test('fechar aspas já inseridas apenas atravessa o cursor', () => {
    const textarea = createTextarea('"abc"', 4);
    const editor = new MarkdownEditor(textarea, () => {});
    let prevented = false;
    editor.handleKeydown(keyEvent('"', { preventDefault() { prevented = true; } }));
    assert.equal(prevented, true);
    assert.equal(textarea.value, '"abc"');
    assert.equal(textarea.selectionStart, 5);
    assert.equal(textarea.selectionEnd, 5);
});

test('não insere par de aspas no meio de uma palavra', () => {
    const textarea = createTextarea('don', 3);
    const editor = new MarkdownEditor(textarea, () => {});
    let prevented = false;
    editor.handleKeydown(keyEvent("'", { preventDefault() { prevented = true; } }));
    assert.equal(prevented, false);
    assert.equal(textarea.value, 'don');
});

test('Backspace dentro de um par vazio remove os dois lados', () => {
    const textarea = createTextarea('a()b', 2);
    const editor = new MarkdownEditor(textarea, () => {});
    let prevented = false;
    editor.handleKeydown(keyEvent('Backspace', { preventDefault() { prevented = true; } }));
    assert.equal(prevented, true);
    assert.equal(textarea.value, 'ab');
    assert.equal(textarea.selectionStart, 1);
});

test('Shift+Enter não continua a lista', () => {
    const textarea = createTextarea('- item', 6);
    const editor = new MarkdownEditor(textarea, () => {});
    let prevented = false;
    editor.handleKeydown(keyEvent('Enter', { shiftKey: true, preventDefault() { prevented = true; } }));
    assert.equal(prevented, false);
    assert.equal(textarea.value, '- item');
});

test('ignora atalhos e auto-pares durante composição de IME', () => {
    const textarea = createTextarea('', 0);
    const editor = new MarkdownEditor(textarea, () => {});
    let prevented = false;
    editor.handleKeydown(keyEvent('(', { isComposing: true, preventDefault() { prevented = true; } }));
    assert.equal(prevented, false);
    assert.equal(textarea.value, '');
});

test('caps undo history for very large documents', () => {
    const block = 'x'.repeat(1_000_000);
    const textarea = createTextarea(block);
    const editor = new MarkdownEditor(textarea, () => {});
    for (let index = 0; index < 25; index++) {
        textarea.value = `${block}${index}`;
        editor.lastInputAt = 0;
        editor.handleInput();
    }
    assert.ok(editor.historyChars <= 16 * 1024 * 1024);
    assert.ok(editor.history.length <= 20);
    assert.equal(editor.history[editor.historyIndex].value, textarea.value);
    assert.ok(editor.historyIndex > 0);
    editor.undo();
    assert.notEqual(textarea.value, `${block}24`);
});

test('continues ordered lists with the next number', () => {
    const textarea = createTextarea('1. first', 8);
    const editor = new MarkdownEditor(textarea, () => {});
    assert.equal(editor.continueMarkdownList(), true);
    assert.equal(textarea.value, '1. first\n2. ');
});

test('inserts a Markdown link with Ctrl+K', () => {
    const textarea = createTextarea('selected text', 0, 13);
    const editor = new MarkdownEditor(textarea, () => {});
    let prevented = false;
    editor.handleKeydown({
        ctrlKey: true,
        metaKey: false,
        key: 'k',
        preventDefault() { prevented = true; }
    });
    assert.equal(prevented, true);
    assert.equal(textarea.value, '[selected text](url)');
});

test('detects an unfinished wikilink at the caret', () => {
    const textarea = createTextarea('before [[Tar', 12);
    const editor = new MarkdownEditor(textarea, () => {});
    assert.deepEqual(editor.getWikilinkToken(), {
        query: 'Tar',
        noteQuery: 'Tar',
        headingQuery: null,
        hasHeading: false,
        tokenStart: 9,
        caret: 12
    });
    textarea.value = '![[image';
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    assert.equal(editor.getWikilinkToken(), null);
});

test('splits a wikilink token into note and heading parts', () => {
    const textarea = createTextarea('Veja [[Pasta/Nota#Primeira', 26);
    const editor = new MarkdownEditor(textarea, () => {});
    assert.deepEqual(editor.getWikilinkToken(), {
        query: 'Pasta/Nota#Primeira',
        noteQuery: 'Pasta/Nota',
        headingQuery: 'Primeira',
        hasHeading: true,
        tokenStart: 7,
        caret: 26
    });
    textarea.value = '[[#Introdução';
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    assert.deepEqual(editor.getWikilinkToken(), {
        query: '#Introdução',
        noteQuery: '',
        headingQuery: 'Introdução',
        hasHeading: true,
        tokenStart: 2,
        caret: 13
    });
});

test('accepts a wikilink suggestion and preserves existing closing brackets', () => {
    const textarea = createTextarea('[[Tar]] after', 5);
    const editor = new MarkdownEditor(textarea, () => {});
    assert.equal(editor.acceptWikilink('Target'), true);
    assert.equal(textarea.value, '[[Target]] after');
    assert.equal(textarea.selectionStart, 10);
    editor.undo();
    assert.equal(textarea.value, '[[Tar]] after');
});

test('accepts a wikilink suggestion when closing brackets are not typed yet', () => {
    const textarea = createTextarea('[[Tar and more', 5);
    const editor = new MarkdownEditor(textarea, () => {});
    assert.equal(editor.acceptWikilink('Target'), true);
    assert.equal(textarea.value, '[[Target]] and more');
});

test('Ctrl+Alt+T inserts a table on its own Markdown lines', () => {
    const textarea = createTextarea('before after', 7, 7);
    const editor = new MarkdownEditor(textarea, () => {});
    let prevented = false;
    editor.handleKeydown({
        ctrlKey: true,
        metaKey: false,
        altKey: true,
        key: 't',
        preventDefault() { prevented = true; }
    });
    assert.equal(prevented, true);
    assert.equal(textarea.value, 'before\n\n| Coluna 1 | Coluna 2 |\n| --- | --- |\n| Célula | Célula |\n\nafter');
    assert.equal(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd), 'Célula');
});

test('inserts and selects a Markdown table cell', () => {
    const textarea = createTextarea('', 0, 0);
    const editor = new MarkdownEditor(textarea, () => {});
    editor.insertTable();
    assert.equal(textarea.value, '| Coluna 1 | Coluna 2 |\n| --- | --- |\n| Célula | Célula |');
    assert.equal(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd), 'Célula');
});

test('adds legacy tags to Markdown frontmatter without a separate tags field', () => {
    const markdown = ensureFrontmatterTags('# Note\n\nBody', ['sei-la']);
    assert.equal(markdown, '---\ntags: sei-la\n---\n\n# Note\n\nBody');
});

test('preserves existing frontmatter tags', () => {
    const markdown = '---\ntags: [existing]\n---\n\n# Note';
    assert.equal(ensureFrontmatterTags(markdown, ['legacy']), markdown);
});

test('adds and replaces frontmatter properties without touching the body', () => {
    const content = '---\nstatus: ativo\n---\n\nCorpo';
    assert.equal(
        setFrontmatterProperty(content, 'status', 'arquivado'),
        '---\nstatus: arquivado\n---\n\nCorpo'
    );
    assert.equal(
        setFrontmatterProperty(content, 'autor', 'Ana'),
        '---\nstatus: ativo\nautor: Ana\n---\n\nCorpo'
    );
    assert.equal(
        setFrontmatterProperty('# Note\n\nCorpo', 'status', 'ativo'),
        '---\nstatus: ativo\n---\n\n# Note\n\nCorpo'
    );
    assert.equal(
        setFrontmatterProperty('---\nstatus: ativo\n---\nCorpo', 'situação', 'ok'),
        '---\nstatus: ativo\nsituação: ok\n---\nCorpo'
    );
    assert.equal(
        setFrontmatterProperty('---\n"meu campo": antigo\n---\nCorpo', 'meu campo', 'novo'),
        '---\nmeu campo: novo\n---\nCorpo'
    );
    assert.equal(
        setFrontmatterProperty('---\nstatus: ativo\n---\nCorpo', 'prioridade.max', 3),
        '---\nstatus: ativo\nprioridade.max: 3\n---\nCorpo'
    );
});

test('writes frontmatter lists for tags and replaces existing lists', () => {
    const content = '---\ntags:\n  - antiga\nstatus: ativo\n---\n\nCorpo';
    assert.equal(
        setFrontmatterProperty(content, 'tags', ['task', 'oasis']),
        '---\ntags:\n  - task\n  - oasis\nstatus: ativo\n---\n\nCorpo'
    );
    assert.equal(
        setFrontmatterProperty('---\ntags: [antiga]\n---\nCorpo', 'tags', ['task']),
        '---\ntags: task\n---\nCorpo'
    );
});

test('removes frontmatter properties and empty frontmatter blocks', () => {
    assert.equal(
        setFrontmatterProperty('---\nstatus: ativo\nautor: Ana\n---\n\nCorpo', 'status', null),
        '---\nautor: Ana\n---\n\nCorpo'
    );
    assert.equal(
        setFrontmatterProperty('---\nstatus: ativo\n---\n\nCorpo', 'status', null),
        'Corpo'
    );
    assert.equal(
        setFrontmatterProperty('---\nstatus: ativo\n---\n\nCorpo', 'tags', []),
        '---\nstatus: ativo\n---\n\nCorpo'
    );
});

test('quotes frontmatter scalars that need escaping', () => {
    assert.equal(
        setFrontmatterProperty('---\nstatus: ativo\n---\nCorpo', 'status', 'em revisão'),
        '---\nstatus: "em revisão"\n---\nCorpo'
    );
});

test('omits metadata frontmatter from the rendered Markdown body', () => {
    assert.equal(stripFrontmatter('---\ntags: pkm\n---\n\n# Note'), '# Note');
});

test('counts the lines removed with the frontmatter so body lines map back to the editor', () => {
    assert.equal(frontmatterLineOffset('---\ntags: pkm\n---\n\n# Note'), 4);
    assert.equal(frontmatterLineOffset('---\ntags:\n  - pkm\n  - notes\n---\n\n\nBody'), 7);
    assert.equal(frontmatterLineOffset('# Note\n\nBody'), 0);
});

test('parses scalar and list frontmatter properties for the collapsible preview', () => {
    assert.deepEqual(parseFrontmatter('---\ntitle: "Example"\ntags:\n  - notes\n  - pkm\nstatus: true\npriority: 2\n---\nBody'), {
        title: 'Example',
        tags: ['notes', 'pkm'],
        status: true,
        priority: 2
    });
});

test('does not expose malformed or absent frontmatter as properties', () => {
    assert.equal(parseFrontmatter('# Note\n---\ntags: pkm'), null);
    assert.equal(parseFrontmatter('---\ntags: pkm\n# Note'), null);
    assert.equal(parseFrontmatter('---\n---\n# Note'), null);
});

test('reads the note type from frontmatter and opts into markmap', () => {
    assert.equal(noteType('---\nnote-type: markmap\n---\n# Map'), 'markmap');
    assert.equal(noteType('---\nnote-type: "MarkMap"\n---\n# Map'), 'markmap');
    assert.equal(noteType('---\nnote-type:\n  - markmap\n---\n# Map'), 'markmap');
    assert.equal(noteType('---\nnote-type: table\n---\n# Note'), 'table');
    assert.equal(noteType('---\ntags: pkm\n---\n# Note'), '');
    assert.equal(noteType('# Note'), '');
});

test('detects markmap notes only when note-type is markmap', () => {
    assert.equal(isMarkmapNote('---\nnote-type: markmap\n---\n# Map'), true);
    assert.equal(isMarkmapNote('---\nnote-type: markmapish\n---\n# Map'), false);
    assert.equal(isMarkmapNote('---\nnote-type: markdown\n---\n# Map'), false);
    assert.equal(isMarkmapNote('# Map'), false);
});

test('extracts nested headings, skips frontmatter and fenced code, and tracks preview lines', () => {
    assert.deepEqual(extractMarkdownOutline('---\ntags: pkm\n---\n\n# First\n\n## Second\n\n```md\n# Not a heading\n```\n\nThird\n---'), [
        { level: 1, text: 'First', line: 4, bodyLine: 0 },
        { level: 2, text: 'Second', line: 6, bodyLine: 2 },
        { level: 2, text: 'Third', line: 12, bodyLine: 8 }
    ]);
});

test('highlights wikilinks in the Markdown editor', () => {
    assert.equal(
        highlightMarkdown('[[Target]] <unsafe>'),
        '<span class="md-wikilink">[[Target]]</span> &lt;unsafe&gt;'
    );
});

test('highlights configured task markers as standalone words', () => {
    assert.equal(
        highlightMarkdown('TODO: revisar', ['TODO']),
        '<span class="md-task-marker" data-marker="TODO">TODO</span>: revisar'
    );
    assert.equal(
        highlightMarkdown('todo: revisar', ['todo']),
        'todo: revisar'
    );
    assert.equal(highlightMarkdown('TODOLIST', ['TODO']), 'TODOLIST');
    assert.equal(
        highlightMarkdown('`TODO` e TODO', ['TODO']),
        '<span class="md-code">`<span class="md-task-marker" data-marker="TODO">TODO</span>`</span> e ' +
        '<span class="md-task-marker" data-marker="TODO">TODO</span>'
    );
});

test('highlights Markdown structures and identifies fenced code languages', () => {
    const original = globalThis.hljs;
    globalThis.hljs = {
        getLanguage: language => language === 'js',
        highlight: source => ({
            value: source.replace('const', '<span class="hljs-keyword">const</span>')
                .replace('42', '<span class="hljs-number">42</span>')
        })
    };
    try {
        const highlighted = highlightMarkdown('# Título\n- **forte**\n```js\nconst answer = 42;\n```');
        assert.match(highlighted, /class="md-heading"/);
        assert.match(highlighted, /class="md-list"/);
        assert.match(highlighted, /class="md-strong"/);
        assert.match(highlighted, /class="md-code-language">js<\/span>/);
        assert.match(highlighted, /class="hljs-keyword">const<\/span>/);
        assert.match(highlighted, /class="hljs-number">42<\/span>/);
        assert.equal(highlightMarkdown('**forte**'), '<span class="md-strong">**forte**</span>');
    } finally {
        if (original === undefined) delete globalThis.hljs;
        else globalThis.hljs = original;
    }
});

test('decide quando o overlay de sintaxe deve sair de cena em notas enormes', () => {
    assert.equal(shouldRenderEditorHighlight(1_000), true);
    assert.equal(shouldRenderEditorHighlight(60_001), true);
    assert.equal(shouldRenderEditorHighlight(EDITOR_HIGHLIGHT_MAX_LENGTH), true);
    assert.equal(shouldRenderEditorHighlight(EDITOR_HIGHLIGHT_MAX_LENGTH + 1), false);
    // O modo de edição mantém a cor enquanto digita em notas grandes.
    assert.equal(shouldRenderEditorHighlight(200_000), true);
});

test('renderiza linhas isoladas com o mesmo HTML do documento inteiro', () => {
    const lines = [
        '# Título',
        '',
        '```js',
        'const a = 1;',
        '// comentário',
        '```',
        '',
        '**forte** e TODO'
    ];
    const perLine = renderMarkdownLines(lines);
    assert.equal(perLine.join('\n'), highlightMarkdown(lines.join('\n')));
    // Um recorte no meio de um bloco cercado ainda usa o bloco inteiro.
    const slice = renderMarkdownLines(lines, undefined, { start: 3, end: 4 });
    assert.equal(slice[3], perLine[3]);
    assert.equal(slice[0], undefined);
});

test('calcula o menor intervalo de linhas alterado', () => {
    assert.deepEqual(diffLineRanges(['a', 'b', 'c'], ['a', 'b', 'c']), {
        start: 3, oldEnd: 3, newEnd: 3, changed: false
    });
    assert.deepEqual(diffLineRanges(['a', 'b', 'c'], ['a', 'B', 'c']), {
        start: 1, oldEnd: 2, newEnd: 2, changed: true
    });
    assert.deepEqual(diffLineRanges(['a', 'b'], ['a', 'x', 'b']), {
        start: 1, oldEnd: 1, newEnd: 2, changed: true
    });
    assert.deepEqual(diffLineRanges(['a', 'x', 'b'], ['a', 'b']), {
        start: 1, oldEnd: 2, newEnd: 1, changed: true
    });
});

test('planeja atualização incremental respeitando blocos cercados', () => {
    const base = ['texto', '```js', 'const a = 1;', 'const b = 2;', '```', 'fim'];
    // Editar dentro do bloco reconstrói o bloco inteiro (Highlight.js).
    assert.deepEqual(
        planHighlightUpdate(base, ['texto', '```js', 'const a = 1;', 'const b = 3;', '```', 'fim']),
        { start: 1, oldEnd: 5, newEnd: 5 }
    );
    // Inserir uma linha no bloco também cobre o bloco inteiro.
    assert.deepEqual(
        planHighlightUpdate(base, ['texto', '```js', 'const a = 1;', 'const c = 3;', 'const b = 2;', '```', 'fim']),
        { start: 1, oldEnd: 5, newEnd: 6 }
    );
    // Mexer na cerca muda o bloco de todas as linhas seguintes.
    assert.deepEqual(
        planHighlightUpdate(base, ['texto', '````js', 'const a = 1;', 'const b = 2;', '```', 'fim']),
        { start: 1, oldEnd: 6, newEnd: 6 }
    );
    // Linha de texto comum atualiza só ela mesma.
    assert.deepEqual(
        planHighlightUpdate(base, ['texto', '```js', 'const a = 1;', 'const b = 2;', '```', 'FIM']),
        { start: 5, oldEnd: 6, newEnd: 6 }
    );
    assert.equal(planHighlightUpdate(base, base), null);
});

test('o realce preserva o texto exato para manter seleção e cursor alinhados', () => {
    const source = [
        '# Título com TODO',
        '',
        '```javascript',
        'const answer = 42; // FIXME depois',
        '```',
        '',
        'Texto **forte**, *ênfase*, `código`, [[link]] e < > & fim.'
    ].join('\n');
    const plain = highlightMarkdown(source)
        .replace(/<[^>]+>/g, '')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
    assert.equal(plain, source);
});
