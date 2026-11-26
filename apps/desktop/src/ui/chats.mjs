// Several conversations per project, and "Ask anything" (a workspace for questions that belong to no
// project). The conversation open now keeps its messages in `project.messages`, as before, so the rest
// of the window is unchanged; the others wait in `project.chats`. Team, memory and files are the
// project's, shared by all its conversations.

export const GENERAL_ID = 'general';

export function chatTitle(messages, fallback = 'New chat') {
  const first = (messages || []).find((m) => m.kind === 'user' && typeof m.text === 'string' && m.text.trim());
  if (!first) return fallback;
  const text = first.text.replace(/\s+/g, ' ').trim();
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

export function withChats(project, now = Date.now()) {
  if (Array.isArray(project.chats) && project.chatId) return project;
  return { ...project, chatId: 'c0', chats: [{ id: 'c0', title: chatTitle(project.messages, 'Chat'), updatedAt: now }] };
}

// The current conversation, put away with its messages and title.
function putAway(p, now) {
  return p.chats.map((c) => (c.id === p.chatId ? { ...c, title: c.named ? c.title : chatTitle(p.messages, c.title), messages: p.messages, updatedAt: p.messages.length ? now : c.updatedAt } : c));
}

export function switchChat(project, chatId, now = Date.now()) {
  const p = withChats(project, now);
  if (chatId === p.chatId) return p;
  const target = p.chats.find((c) => c.id === chatId);
  if (!target) return p;
  // An empty open conversation is not kept when moving to another one.
  const chats = (p.messages.length ? putAway(p, now) : p.chats.filter((c) => c.id !== p.chatId)).map((c) => (c.id === chatId ? { id: c.id, title: c.title, updatedAt: c.updatedAt, ...(c.named ? { named: true } : {}) } : c));
  return { ...p, chats, chatId, messages: target.messages || [] };
}

// A new, empty conversation (the current one is kept). An empty current conversation is reused.
export function startChat(project, chatId, now = Date.now()) {
  const p = withChats(project, now);
  if (!p.messages.length) return p;
  return { ...p, chats: [{ id: chatId, title: 'New chat', updatedAt: now }, ...putAway(p, now)], chatId, messages: [] };
}

export function removeChat(project, chatId, newId, now = Date.now()) {
  const p = withChats(project, now);
  if (chatId !== p.chatId) return { ...p, chats: p.chats.filter((c) => c.id !== chatId) };
  const rest = p.chats.filter((c) => c.id !== chatId).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!rest.length) return { ...p, chats: [{ id: newId, title: 'New chat', updatedAt: now }], chatId: newId, messages: [] };
  const next = rest[0];
  return { ...p, chats: rest.map((c) => (c.id === next.id ? { id: c.id, title: c.title, updatedAt: c.updatedAt, ...(c.named ? { named: true } : {}) } : c)), chatId: next.id, messages: next.messages || [] };
}

// The conversations to list, the open one first, then the most recent.
export function chatList(project) {
  const p = withChats(project, 0);
  return p.chats
    // An empty open conversation is not listed; "New chat" stands for it.
    .filter((c) => c.id !== p.chatId || p.messages.length > 0)
    .map((c) => (c.id === p.chatId ? { id: c.id, title: c.named ? c.title : chatTitle(p.messages, c.title === 'Chat' || c.title === 'New chat' ? 'New chat' : c.title), current: true, updatedAt: Infinity } : { id: c.id, title: c.title, current: false, updatedAt: c.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// "Ask anything" exists once, first, with only its Manager: no team, so it answers rather than plans.
export function ensureGeneral(projects) {
  if ((projects || []).some((p) => p.id === GENERAL_ID)) return projects;
  const general = { id: GENERAL_ID, name: 'Ask anything', kind: 'general', graph: { nodes: [{ id: 'manager', name: 'Manager', role: 'Manager', priority: 1, x: 410, y: 75, agent: null }], edges: [] }, messages: [] };
  return [general, ...(projects || [])];
}

export const isGeneral = (project) => project?.id === GENERAL_ID || project?.kind === 'general';

// Chats brought in from a file (chat-io.mjs), kept beside the open one.
export function addChats(project, chats, now = Date.now()) {
  const p = withChats(project, now);
  return { ...p, chats: [...p.chats, ...chats] };
}
