import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline, safeLink } from './markdown.mjs';

const types = (text) => parseBlocks(text).map((b) => b.type);

describe('markdown in the chat', () => {
  it('reads headings, paragraphs, lists, quotes, rules and tables', () => {
    const blocks = parseBlocks('# Plan\n\nFörst detta.\nSamma stycke.\n\n- ett\n- två\n  - inne\n\n1. a\n2. b\n\n> citat\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'rule', 'table']);
    expect(blocks[0]).toMatchObject({ level: 1, inline: [{ t: 'text', v: 'Plan' }] });
    expect(blocks[1].inline).toEqual([{ t: 'text', v: 'Först detta.\nSamma stycke.' }]);
    expect(blocks[2].items).toHaveLength(2);
    expect(blocks[2].items[1].map((b) => b.type)).toEqual(['paragraph', 'list']);
    expect(blocks[3]).toMatchObject({ ordered: true, start: 1 });
    expect(blocks[6].head.map((c) => c[0].v)).toEqual(['A', 'B']);
    expect(blocks[6].rows).toHaveLength(1);
  });

  it('keeps code blocks exactly, also while a reply is still being written', () => {
    const code = 'const items = list.filter(e =>\n  e.meal === key);\n\n**not bold**';
    expect(parseBlocks('Här:\n```js\n' + code + '\n```\nKlart.')).toEqual([
      { type: 'paragraph', inline: [{ t: 'text', v: 'Här:' }] },
      { type: 'code', lang: 'js', text: code, closed: true },
      { type: 'paragraph', inline: [{ t: 'text', v: 'Klart.' }] },
    ]);
    expect(parseBlocks('```html\n<div class="x">')[0]).toEqual({ type: 'code', lang: 'html', text: '<div class="x">', closed: false });
    expect(types('$$\nx^2\n$$')).toEqual(['math']);
  });

  it('reads inline formatting', () => {
    expect(parseInline('**fet** och *kursiv* och `kod` och ~~bort~~')).toEqual([
      { t: 'bold', c: [{ t: 'text', v: 'fet' }] }, { t: 'text', v: ' och ' },
      { t: 'italic', c: [{ t: 'text', v: 'kursiv' }] }, { t: 'text', v: ' och ' },
      { t: 'code', v: 'kod' }, { t: 'text', v: ' och ' },
      { t: 'strike', c: [{ t: 'text', v: 'bort' }] },
    ]);
    expect(parseInline('se [sidan](https://example.com) eller https://a.se/x.')).toEqual([
      { t: 'text', v: 'se ' }, { t: 'link', c: [{ t: 'text', v: 'sidan' }], href: 'https://example.com' },
      { t: 'text', v: ' eller ' }, { t: 'link', c: [{ t: 'text', v: 'https://a.se/x' }], href: 'https://a.se/x' }, { t: 'text', v: '.' },
    ]);
    expect(parseInline('snake_case_name och 2*3*4')).toEqual([{ t: 'text', v: 'snake_case_name och 2*3*4' }]);
    expect(parseInline('kostar $5 och $10')).toEqual([{ t: 'text', v: 'kostar $5 och $10' }]);
    expect(parseInline('formeln $E = mc^2$')).toEqual([{ t: 'text', v: 'formeln ' }, { t: 'math', v: 'E = mc^2' }]);
    expect(parseInline('\\*inte kursiv\\*')).toEqual([{ t: 'text', v: '*inte kursiv*' }]);
  });

  it('never makes markup of what it reads', () => {
    const blocks = parseBlocks('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(blocks).toEqual([
      { type: 'paragraph', inline: [{ t: 'text', v: '<script>alert(1)</script>' }] },
      { type: 'paragraph', inline: [{ t: 'text', v: '<img src=x onerror=alert(1)>' }] },
    ]);
  });

  it('opens only web addresses', () => {
    expect(safeLink('https://example.com/a')).toBe('https://example.com/a');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('file:///etc/passwd')).toBeNull();
    expect(safeLink('nope')).toBeNull();
  });
});
