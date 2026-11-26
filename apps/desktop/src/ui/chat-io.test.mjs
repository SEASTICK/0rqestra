import { describe, expect, it } from 'vitest';
import { chatToMarkdown, exportFileName, exportMessages, MAX_IMPORT_CHATS, parseImport, toAppChats } from './chat-io.mjs';

const claudeExport = JSON.stringify([
  { uuid: 'a', name: 'Fotosyntes', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:05:00Z', chat_messages: [
    { sender: 'human', text: 'Vad är fotosyntes?', content: [{ type: 'text', text: 'Vad är fotosyntes?' }] },
    { sender: 'assistant', text: '', content: [{ type: 'text', text: 'Växter gör **socker** av ljus.' }, { type: 'tool_use', name: 'x' }] },
  ] },
  { uuid: 'b', name: '', created_at: '2026-11-01T10:00:00Z', chat_messages: [] },
]);

const gptExport = JSON.stringify([{ title: 'Matteprov', update_time: 1790000000, current_node: 'n4', mapping: {
  root: { id: 'root', message: null, parent: null, children: ['n1'] },
  n1: { id: 'n1', parent: 'root', children: ['n2'], message: { author: { role: 'system' }, content: { content_type: 'text', parts: ['hidden'] } } },
  n2: { id: 'n2', parent: 'n1', children: ['n3', 'x'], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Hjälp mig med derivator'] } } },
  x: { id: 'x', parent: 'n2', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['An older answer that was regenerated'] } } },
  n3: { id: 'n3', parent: 'n2', children: ['n4'], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Derivatan av x² är 2x.'] } } },
  n4: { id: 'n4', parent: 'n3', children: [], message: { author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: [{ asset_pointer: 'file' }, 'Och x³?'] } } },
} }]);

describe('Exporting a chat', () => {
  it('writes readable Markdown that 0rqestra reads back exactly', () => {
    const messages = exportMessages([
      { kind: 'user', text: 'Förklara fotosyntes', attachments: [{ name: 'bild.png' }] },
      { kind: 'assistant', status: 'done', text: '## Fotosyntes\n\nVäxter gör **socker**.\n\n## You\nnot a turn', providerName: 'Claude Code', model: 'sonnet' },
      { kind: 'assistant', status: 'streaming', text: 'half' },
      { kind: 'team', run: { goal: 'x' } },
    ], () => 'The team built x.');
    const md = chatToMarkdown('Förklara fotosyntes', messages, new Date('2026-11-24T12:00:00Z'));
    expect(md).toContain('# Förklara fotosyntes');
    expect(md).toContain('## Claude Code · sonnet');
    const back = parseImport(md, 'Förklara fotosyntes.md');
    expect(back.source).toBe('0rqestra');
    expect(back.chats[0].title).toBe('Förklara fotosyntes');
    expect(back.chats[0].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(back.chats[0].messages[1].text).toBe('## Fotosyntes\n\nVäxter gör **socker**.\n\n## You\nnot a turn');
    expect(back.chats[0].messages[0].text).toContain('_Attached: bild.png_');
    expect(exportFileName('Vad är 2/3 * x? <test>')).toBe('Vad är 2 3 x test.md');
    expect(exportFileName('')).toBe('Chat.md');
  });
});

describe('Importing chats', () => {
  it("reads Claude's data export, newest first, with only the text parts", () => {
    const r = parseImport(claudeExport, 'conversations.json');
    expect(r.source).toBe('Claude');
    expect(r.chats).toHaveLength(1);
    expect(r.chats[0].messages).toEqual([{ role: 'user', text: 'Vad är fotosyntes?' }, { role: 'assistant', text: 'Växter gör **socker** av ljus.', label: 'Claude' }]);
  });

  it("follows the shown branch of a ChatGPT conversation, without system messages or pictures", () => {
    const r = parseImport(gptExport, 'conversations.json');
    expect(r.source).toBe('ChatGPT');
    expect(r.chats[0].title).toBe('Matteprov');
    expect(r.chats[0].messages.map((m) => m.text)).toEqual(['Hjälp mig med derivator', 'Derivatan av x² är 2x.', 'Och x³?']);
  });

  it('reads plain Markdown with You and Assistant headings', () => {
    const r = parseImport('# Plugg\n\n## You\nVad är 2+2?\n\n## Assistant\n4.\n', 'plugg.md');
    expect(r.chats[0].messages).toEqual([{ role: 'user', text: 'Vad är 2+2?' }, { role: 'assistant', text: '4.', label: 'Assistant' }]);
  });

  it('says plainly when a file holds no chat, and keeps within the limits', () => {
    expect(() => parseImport('just some notes', 'notes.txt')).toThrow(/No chats found/);
    expect(() => parseImport('{"a":1}', 'x.json')).toThrow(/No chats found/);
    expect(() => parseImport('{oops', 'x.json')).toThrow(/not valid JSON/);
    const many = JSON.stringify(Array.from({ length: MAX_IMPORT_CHATS + 5 }, (_, i) => ({ name: `c${i}`, chat_messages: [{ sender: 'human', text: 'hej' }] })));
    const r = parseImport(many, 'conversations.json');
    expect(r.chats).toHaveLength(MAX_IMPORT_CHATS);
    expect(r.skipped).toBe(5);
  });

  it('makes read-only replies that the next message continues from', () => {
    let n = 0;
    const chats = toAppChats(parseImport(claudeExport, 'conversations.json'), () => `id${n++}`, 1000);
    expect(chats[0]).toMatchObject({ title: 'Fotosyntes', messages: [{ kind: 'user', text: 'Vad är fotosyntes?' }, { kind: 'assistant', status: 'done', readOnly: true, providerName: 'Claude (imported)' }] });
    expect(chats[0].id).toMatch(/^c[A-Za-z0-9_-]+$/);
  });
});
