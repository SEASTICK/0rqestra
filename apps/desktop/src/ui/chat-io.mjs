// Export and import of chats. Export writes a chat as Markdown that reads well anywhere (paste it into
// Claude or ChatGPT) and that 0rqestra reads back: each message starts with an invisible marker. Import
// also takes the data exports of Claude and ChatGPT (their conversations.json), so earlier chats can be
// continued here. Imported text is only ever text: it is shown as Markdown, never run.

export const MAX_IMPORT_CHATS = 100;
export const MAX_MESSAGES = 300;
export const MAX_MESSAGE_CHARS = 30_000;
// What fits in the window's storage next to everything else (characters of message text).
export const MAX_IMPORT_CHARS = 2_500_000;

const MARK = /^<!-- orqestra:(user|assistant)(?: (.*?))? -->$/;

const clean = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split(String.fromCharCode(0)).join('').trim();

export function exportFileName(title) {
  const base = [...clean(title)].map((c) => (c < ' ' || '\\/:*?"<>|'.includes(c) ? ' ' : c)).join('').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Chat';
  return `${base}.md`;
}

// messages: { role: 'user' | 'assistant', text, label? }[]
export function chatToMarkdown(title, messages, at = new Date()) {
  const lines = [`# ${clean(title) || 'Chat'}`, '', `_Exported from 0rqestra on ${at.toISOString().slice(0, 10)}._`, ''];
  for (const m of messages) {
    const label = m.role === 'user' ? 'You' : (clean(m.label) || 'Assistant');
    lines.push(`<!-- orqestra:${m.role}${m.label ? ` ${clean(m.label).replace(/-->/g, '')}` : ''} -->`, `## ${label}`, '', clean(m.text), '');
  }
  return `${lines.join('\n').trim()}\n`;
}

// The messages of one chat in the app, as export wants them: team runs as their summary, attachments named.
export function exportMessages(messages, teamText = () => '') {
  const out = [];
  for (const m of messages || []) {
    if (m.kind === 'user' && m.text) out.push({ role: 'user', text: `${m.to ? `(To ${m.to}) ` : ''}${m.text}${m.attachments?.length ? `\n\n_Attached: ${m.attachments.map((a) => a.name).join(', ')}_` : ''}` });
    else if (m.kind === 'assistant' && m.text && m.status !== 'streaming') out.push({ role: 'assistant', text: m.text, label: [m.providerName, m.model && m.model !== 'auto' && m.model !== 'default' ? m.model : null].filter(Boolean).join(' · ') || undefined });
    else if (m.kind === 'team' && m.run) out.push({ role: 'assistant', text: teamText(m.run), label: 'Team run' });
    else if ((m.kind === 'manager' || m.kind === 'teamInfo') && m.text) out.push({ role: 'assistant', text: m.text, label: m.kind === 'teamInfo' ? 'Team' : 'Manager' });
  }
  return out;
}

function fromMarkdown(text, fileName) {
  const lines = clean(text).split('\n');
  const title = (lines.find((l) => /^# /.test(l)) || '').slice(2).trim() || fileName.replace(/\.(md|markdown|txt)$/i, '');
  const messages = [];
  let current = null;
  const push = () => { if (current) { const body = current.lines.join('\n').trim(); if (body) messages.push({ role: current.role, text: body, ...(current.label ? { label: current.label } : {}) }); } };
  const marked = lines.some((l) => MARK.test(l.trim()));
  for (const raw of lines) {
    const line = raw.trim();
    const mark = marked ? MARK.exec(line) : null;
    // Without markers: "## You" / "## User" start the user's turns, "## Assistant", "## Claude", "## ChatGPT" the replies.
    const heading = !marked ? /^#{2,3}\s+(You|User|Me|Human|Assistant|Claude|ChatGPT|Manager|AI)\s*:?$/i.exec(line) : null;
    if (mark || heading) {
      push();
      const role = mark ? mark[1] : /^(you|user|me|human)$/i.test(heading[1]) ? 'user' : 'assistant';
      current = { role, label: mark ? mark[2] : role === 'assistant' ? heading[1] : undefined, lines: [], skipHeading: Boolean(mark) };
      continue;
    }
    if (!current) continue;
    if (current.skipHeading && /^## /.test(line) && !current.lines.length) { current.skipHeading = false; continue; }
    current.lines.push(raw);
  }
  push();
  return messages.length ? [{ title, messages }] : [];
}

const textOf = (v) => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('\n\n');
  if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
  return '';
};

// Claude's data export: [{ name, created_at, chat_messages: [{ sender: 'human' | 'assistant', text, content }] }].
function fromClaude(list) {
  return list.filter((c) => Array.isArray(c?.chat_messages)).map((c) => ({
    title: clean(c.name) || 'Chat from Claude',
    at: Date.parse(c.updated_at || c.created_at) || null,
    messages: c.chat_messages.map((m) => ({ role: m.sender === 'human' ? 'user' : 'assistant', text: clean(m.text || textOf((m.content || []).filter((p) => !p?.type || p.type === 'text'))), ...(m.sender === 'human' ? {} : { label: 'Claude' }) })).filter((m) => m.text),
  }));
}

// ChatGPT's data export: [{ title, update_time, mapping: { id: { message, parent } }, current_node }]. The
// shown conversation is the path from current_node back to the start.
function fromChatGPT(list) {
  return list.filter((c) => c && typeof c.mapping === 'object' && c.mapping).map((c) => {
    const order = [];
    const seen = new Set();
    let id = c.current_node || Object.keys(c.mapping).find((k) => !(c.mapping[k]?.children || []).length);
    while (id && c.mapping[id] && !seen.has(id) && order.length < 5000) { seen.add(id); order.unshift(c.mapping[id]); id = c.mapping[id].parent; }
    const messages = order.map((n) => n.message).filter((m) => m && (m.author?.role === 'user' || m.author?.role === 'assistant') && m.metadata?.is_visually_hidden_from_conversation !== true)
      .map((m) => ({ role: m.author.role, text: clean((m.content?.parts || []).filter((p) => typeof p === 'string').join('\n\n')), ...(m.author.role === 'assistant' ? { label: 'ChatGPT' } : {}) }))
      .filter((m) => m.text);
    return { title: clean(c.title) || 'Chat from ChatGPT', at: c.update_time ? c.update_time * 1000 : null, messages };
  });
}

// Reads a file the user chose. Returns the chats found (newest first for exports with many), what was
// left out, and where they came from; throws with a plain message when nothing could be read.
export function parseImport(text, fileName = 'chat.md') {
  const raw = String(text ?? '');
  let chats;
  let source;
  if (/\.json$/i.test(fileName) || /^\s*[[{]/.test(raw)) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('This file is not valid JSON.');
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.conversations) ? data.conversations : [data];
    if (list.some((c) => Array.isArray(c?.chat_messages))) { chats = fromClaude(list); source = 'Claude'; }
    else if (list.some((c) => c && typeof c.mapping === 'object')) { chats = fromChatGPT(list); source = 'ChatGPT'; }
    else throw new Error('No chats found. Choose a chat exported from 0rqestra (.md), or conversations.json from a Claude or ChatGPT data export.');
  } else {
    chats = fromMarkdown(raw, fileName);
    source = raw.includes('<!-- orqestra:') ? '0rqestra' : 'markdown';
  }
  chats = chats.filter((c) => c.messages.length).sort((a, b) => (b.at || 0) - (a.at || 0));
  if (!chats.length) throw new Error('No chats found in this file. A chat needs messages marked as yours and as replies.');
  let left = MAX_IMPORT_CHARS;
  const kept = [];
  let skipped = 0;
  for (const c of chats) {
    const messages = c.messages.slice(-MAX_MESSAGES).map((m) => ({ ...m, text: m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)}\n\n[… cut to fit]` : m.text }));
    const size = messages.reduce((n, m) => n + m.text.length, 0);
    if (kept.length >= MAX_IMPORT_CHATS || size > left) { skipped += 1; continue; }
    left -= size;
    kept.push({ title: c.title.slice(0, 80), at: c.at || null, messages });
  }
  return { chats: kept, skipped, source };
}

// The imported chats as the app keeps them (chats.mjs): replies are read-only (no plan or question in an
// imported reply is offered again), and the next message continues the chat with them as history.
export function toAppChats(parsed, makeId, now = Date.now()) {
  return parsed.chats.map((c, i) => ({
    id: `c${makeId()}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40),
    title: c.title,
    named: true,
    updatedAt: c.at || now - i,
    messages: c.messages.map((m) => (m.role === 'user'
      ? { id: makeId(), kind: 'user', text: m.text }
      : { id: makeId(), kind: 'assistant', status: 'done', text: m.text, readOnly: true, providerName: `${m.label || parsed.source} (imported)`, model: null })),
  }));
}
