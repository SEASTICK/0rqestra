// The real chat in the window: which tool and model answer, the history sent with each message,
// and how streamed events change the reply. The main process does the work (main/chat-ipc.ts);
// this module only keeps the window's state, so it is unit-tested without Electron.

export const TARGET_KEY = 'orqestra-chat-target';
export const DEMO = { provider: 'demo', model: null, effort: null, name: 'Demo', modelLabel: '' };
const PROVIDERS = ['demo', 'claude', 'codex'];

export function readyProviders(statuses) {
  return (Array.isArray(statuses) ? statuses : []).filter((s) => s && s.installed && s.subscription);
}

export function readTarget(storage) {
  try {
    const v = JSON.parse(storage.getItem(TARGET_KEY));
    if (v && PROVIDERS.includes(v.provider)) {
      return { provider: v.provider, model: typeof v.model === 'string' ? v.model : null, effort: typeof v.effort === 'string' ? v.effort : null };
    }
  } catch {
    // Unreadable: the demo answers.
  }
  return { provider: 'demo', model: null, effort: null };
}

export function saveTarget(storage, target) {
  try {
    storage.setItem(TARGET_KEY, JSON.stringify({ provider: target.provider, model: target.model ?? null, effort: target.effort ?? null }));
  } catch {
    // Kept for this session only.
  }
}

// What will actually answer: the chosen tool if it is ready, with the chosen model if it still
// exists (otherwise the tool's default), and the chosen effort only if that model supports it.
export function effectiveTarget(target, statuses) {
  if (!target || target.provider === 'demo') return DEMO;
  const status = readyProviders(statuses).find((s) => s.provider === target.provider);
  if (!status) return DEMO;
  const models = status.models || [];
  const model = models.find((m) => m.id === target.model) || models.find((m) => m.isDefault) || models[0] || null;
  const effort = model && (model.efforts || []).includes(target.effort) ? target.effort : null;
  return { provider: status.provider, model: model ? model.id : null, effort, name: status.name, modelLabel: model ? model.label : 'Default' };
}

// Earlier turns sent with a new message: the user's messages and the finished real replies.
// Demo replies are left out, since no model wrote them.
export function historyFor(messages, max = 40) {
  return (messages || [])
    .filter((m) => m.kind === 'user' || (m.kind === 'assistant' && m.status === 'done' && m.text))
    .slice(-max)
    .map((m) => ({ role: m.kind === 'user' ? 'user' : 'assistant', text: String(m.text).slice(0, 20000) }));
}

export function newAssistant(id, target) {
  return {
    id, kind: 'assistant', text: '', status: 'streaming',
    provider: target.provider, providerName: target.name, model: target.model, effort: target.effort,
  };
}

export function applyChatEvent(message, event) {
  switch (event && event.type) {
    case 'started': return { ...message, model: event.model || message.model };
    case 'delta': return { ...message, text: message.text + event.text };
    case 'completed': return { ...message, text: event.text || message.text, status: 'done', usage: event.usage || null, limits: event.limits || [] };
    case 'cancelled': return { ...message, text: event.text || message.text, status: 'stopped' };
    case 'failed': return { ...message, text: event.text || message.text, status: 'failed', error: event.message, reason: event.reason };
    default: return message;
  }
}

// A reply that was still being written when the app closed cannot continue.
export function settleInterrupted(messages) {
  return (messages || []).map((m) => (m.kind === 'assistant' && m.status === 'streaming' ? { ...m, status: 'stopped' } : m));
}

export function usageLine(message) {
  const parts = [];
  const u = message.usage;
  if (u && (u.inputTokens || u.outputTokens)) parts.push(`${u.inputTokens ?? 0} in · ${u.outputTokens ?? 0} out tokens`);
  for (const limit of message.limits || []) parts.push(`${limit.label} ${Math.round(limit.usedPercent)}% used`);
  return parts.join(' · ');
}

export const FAILURE_HELP = {
  not_installed: 'Install the tool and sign in. AI accounts shows how.',
  not_signed_in: 'Sign in to the tool in a terminal, then try again. AI accounts shows how.',
  not_subscription: 'The tool is signed in with an API key. 0rqestra only uses subscriptions, so nothing was sent.',
  usage_limit: "Your plan's usage limit is reached. It resets after a while, or choose another tool below.",
  timeout: 'No answer in time. Try again.',
  provider_error: 'The tool could not answer. Try again.',
  crashed: 'The tool stopped unexpectedly. Try again.',
};
