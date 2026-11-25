import { describe, expect, it } from 'vitest';
import { chatList, chatTitle, ensureGeneral, GENERAL_ID, isGeneral, removeChat, startChat, switchChat, withChats } from './chats.mjs';

const user = (text) => ({ id: text, kind: 'user', text });
const base = { id: 'p1', name: 'P', graph: { nodes: [], edges: [] }, messages: [user('Bygg en träningslogg'), { id: 'a', kind: 'assistant', text: 'Ok' }] };

describe('conversations in a project', () => {
  it('names a conversation after its first question', () => {
    expect(chatTitle([user('  Hur  räknar jag kalorier? ')])).toBe('Hur räknar jag kalorier?');
    expect(chatTitle([user('x'.repeat(80))])).toHaveLength(48);
    expect(chatTitle([])).toBe('New chat');
  });

  it('turns the old single chat into the first conversation', () => {
    const p = withChats(base, 5);
    expect(p).toMatchObject({ chatId: 'c0', chats: [{ id: 'c0', title: 'Bygg en träningslogg', updatedAt: 5 }] });
    expect(p.messages).toBe(base.messages);
    expect(withChats(p)).toBe(p);
  });

  it('starts a new conversation and keeps the old one, then switches back', () => {
    let p = startChat(base, 'c1', 10);
    expect(p.chatId).toBe('c1');
    expect(p.messages).toEqual([]);
    expect(p.chats.find((c) => c.id === 'c0').messages).toEqual(base.messages);
    expect(startChat(p, 'c2', 11)).toBe(p);
    p = { ...p, messages: [user('Vad är 2+2?')] };
    expect(chatList(p).map((c) => [c.title, c.current])).toEqual([['Vad är 2+2?', true], ['Bygg en träningslogg', false]]);
    p = switchChat(p, 'c0', 20);
    expect(p.messages).toEqual(base.messages);
    expect(p.chats.find((c) => c.id === 'c1')).toMatchObject({ title: 'Vad är 2+2?', messages: [user('Vad är 2+2?')] });
    expect(p.chats.find((c) => c.id === 'c0').messages).toBeUndefined();
    expect(switchChat(p, 'nope')).toBe(p);
  });

  it('removes a conversation, and opens another (or a new one) when it was the open one', () => {
    let p = startChat(base, 'c1', 10);
    p = { ...p, messages: [user('Hej')] };
    const removed = removeChat(p, 'c1', 'c9', 30);
    expect(removed.chatId).toBe('c0');
    expect(removed.messages).toEqual(base.messages);
    expect(removed.chats.map((c) => c.id)).toEqual(['c0']);
    expect(chatList({ ...withChats(base), messages: [] })).toEqual([]);
    const last = removeChat(withChats(base), 'c0', 'c9', 30);
    expect(last).toMatchObject({ chatId: 'c9', messages: [], chats: [{ id: 'c9' }] });
    expect(removeChat(p, 'c0', 'x').chats.map((c) => c.id)).toEqual(['c1']);
  });
});

describe('Ask anything', () => {
  it('exists once, first, with only a Manager', () => {
    const projects = ensureGeneral([base]);
    expect(projects.map((p) => p.id)).toEqual([GENERAL_ID, 'p1']);
    expect(projects[0].graph.nodes.map((n) => n.role)).toEqual(['Manager']);
    expect(ensureGeneral(projects)).toBe(projects);
    expect(isGeneral(projects[0])).toBe(true);
    expect(isGeneral(base)).toBe(false);
  });
});

import { addChats } from './chats.mjs';
describe('Imported chats keep their names', () => {
  it('keeps the title from the file while open and after switching away', () => {
    let p = { id: 'general', messages: [{ kind: 'user', text: 'hej' }], chats: [{ id: 'c0', title: 'Chat', updatedAt: 1 }], chatId: 'c0' };
    p = addChats(p, [{ id: 'c9', title: 'Matteprov', named: true, updatedAt: 5, messages: [{ kind: 'user', text: 'Hjälp mig med derivator' }] }]);
    p = switchChat(p, 'c9', 10);
    expect(chatList(p).find((c) => c.id === 'c9').title).toBe('Matteprov');
    p = switchChat(p, 'c0', 20);
    expect(chatList(p).find((c) => c.id === 'c9').title).toBe('Matteprov');
    expect(chatList(p).find((c) => c.id === 'c0').title).toBe('hej');
  });
});

describe('Leaving an empty chat', () => {
  it('does not keep an empty conversation when switching to another', () => {
    let p = { id: 'general', messages: [], chats: [{ id: 'c0', title: 'Chat', updatedAt: 1 }, { id: 'c1', title: 'Fotosyntes', updatedAt: 2, messages: [{ kind: 'user', text: 'hej' }] }], chatId: 'c0' };
    p = switchChat(p, 'c1', 10);
    expect(p.chats.map((c) => c.id)).toEqual(['c1']);
    expect(p.chatId).toBe('c1');
  });
});
