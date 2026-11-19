// The real chat in the window: which tool and model answer, the history sent with each message,
// and how streamed events change the reply. The main process does the work (main/chat-ipc.ts);
// this module only keeps the window's state, so it is unit-tested without Electron.

export const TARGET_KEY = 'orqestra-chat-target';
// No tool chosen or connected: nothing answers, and the window shows how to set one up.
export const NO_TOOL = { provider: 'none', model: null, effort: null, name: '', modelLabel: '' };
const PROVIDERS = ['claude', 'codex'];

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
    // Unreadable: no tool chosen.
  }
  return { provider: 'none', model: null, effort: null };
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
  if (!target || !PROVIDERS.includes(target.provider)) return NO_TOOL;
  const status = readyProviders(statuses).find((s) => s.provider === target.provider);
  if (!status) return NO_TOOL;
  const models = status.models || [];
  const model = models.find((m) => m.id === target.model) || models.find((m) => m.isDefault) || models[0] || null;
  const effort = model && (model.efforts || []).includes(target.effort) ? target.effort : null;
  return { provider: status.provider, model: model ? model.id : null, effort, name: status.name, modelLabel: model ? model.label : 'Default' };
}

// Earlier turns sent with a new message: the user's messages and the finished real replies.
// Old preview replies (kind 'manager', from before Demo mode was removed) are left out, since no
// model wrote them.
export function historyFor(messages, max = 40) {
  return (messages || [])
    .filter((m) => m.kind === 'user' || (m.kind === 'assistant' && m.status === 'done' && m.text) || (m.kind === 'team' && m.run && m.run.status !== 'running'))
    .slice(-max)
    .map((m) => (m.kind === 'team'
      ? { role: 'assistant', text: teamRunText(m.run) }
      : { role: m.kind === 'user' ? 'user' : 'assistant', text: String(m.text).slice(0, 20000) }));
}

// A finished team run as the Manager sees it in its next turn: the outcome, and each task's return
// brief (summary, decisions, what was verified and by whom, what is still open). The briefs are
// short, so the Manager can use them in the next plan without the agents' transcripts.
export function teamRunText(run) {
  const lines = [`Team run (${run.status}): ${run.summary || ''} Files: ${(run.files || []).map((f) => f.path).join(', ') || 'none'}.`];
  for (const t of run.tasks || []) {
    const b = t.brief;
    if (!b) continue;
    const parts = [`- ${t.id} ${t.title} (${t.role}, ${t.status}): ${b.summary}`];
    if (b.decisions?.length) parts.push(`  Decisions: ${b.decisions.slice(0, 5).join('; ')}`);
    if (b.findings?.length) parts.push(`  Findings: ${b.findings.slice(0, 6).map((f) => `${f.id} ${f.title}`).join('; ')}`);
    if (b.verified?.length) parts.push(`  Verified: ${b.verified.slice(0, 5).map((v) => `${v.text} [${v.source === 'runner' ? 'checked by the app' : 'agent-reported'}]`).join('; ')}`);
    if (b.unresolved?.length) parts.push(`  Unresolved: ${b.unresolved.slice(0, 5).join('; ')}`);
    lines.push(parts.join('\n'));
  }
  return lines.join('\n');
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
  return (messages || []).map((m) => (m.kind === 'assistant' && m.status === 'streaming' ? { ...m, status: 'stopped' }
    : m.kind === 'team' && m.run ? { ...m, run: settleTeamRun(m.run) }
      : m.planning && m.planning.status === 'running' ? { ...m, planning: { ...m.planning, status: 'failed', error: 'The app closed while the Planner was working.' } } : m));
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

// ---- Agents in the tree (phase 2) -------------------------------------------------------------
// A node runs on a tool when it has `agent: { tool, model, effort }`. A node without it has no tool
// yet: it keeps its role and place in the tree, and cannot work until one is chosen. `provider` and
// `model` on a node are display text for the chosen tool.

export function isRealAgent(node) {
  return Boolean(node && node.agent && (node.agent.tool === 'claude' || node.agent.tool === 'codex'));
}

export function agentTarget(node) {
  return isRealAgent(node) ? { provider: node.agent.tool, model: node.agent.model ?? null, effort: node.agent.effort ?? null } : null;
}

// The fields a node gets for a chosen target. `status` is the tool's entry from AI accounts.
export function nodeFieldsFor(target, status) {
  if (!target || !PROVIDERS.includes(target.provider) || !status) return { agent: null, provider: undefined, model: undefined };
  const model = (status.models || []).find((m) => m.id === target.model);
  return {
    agent: { tool: status.provider, model: target.model ?? null, effort: target.effort ?? null },
    provider: status.name,
    model: model ? model.label : 'Default',
  };
}

export function agentBadge(node) {
  if (!isRealAgent(node)) return null;
  return [node.provider, node.model, node.agent.effort].filter(Boolean).join(' · ');
}

export const TEST_PROMPT = 'Reply with one short sentence: say which model you are and that this is a test of a 0rqestra agent.';

export const isTerminal = (event) => Boolean(event) && ['completed', 'cancelled', 'failed'].includes(event.type);

// State of a "Try this agent" run, built from the same events as a chat reply.
export function testState(state, event) {
  const next = applyChatEvent({ text: state.text, status: state.status, model: state.model }, event);
  return { ...state, text: next.text, status: next.status === 'streaming' ? 'running' : next.status, model: next.model ?? state.model, error: next.error ?? null, reason: next.reason ?? null, usage: next.usage ?? null, limits: next.limits ?? [] };
}

// ---- Questions from the Manager ---------------------------------------------------------------
// The Manager ends a reply with <orqestra-question>{json}</orqestra-question> when it needs a
// decision (main/providers/history.ts tells it how). The window shows it as a card with options.

const OPEN_TAG = '<orqestra-question>';
const QUESTION = /<orqestra-question>\s*([\s\S]*?)\s*<\/orqestra-question>\s*$/;

const text = (value, max) => (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null);

export function parseQuestion(raw) {
  const source = String(raw ?? '');
  const match = QUESTION.exec(source);
  if (!match) return { body: source, question: null };
  const body = source.slice(0, match.index).trimEnd();
  try {
    const value = JSON.parse(match[1]);
    const question = text(value?.question, 300);
    const options = Array.isArray(value?.options) ? value.options : [];
    if (!question || options.length < 2 || options.length > 6) return { body: source, question: null };
    const parsed = options.map((o) => ({ label: text(o?.label, 120), description: text(o?.description, 240) }));
    if (parsed.some((o) => !o.label)) return { body: source, question: null };
    const recommended = Number.isInteger(value.recommended) && value.recommended >= 0 && value.recommended < parsed.length ? value.recommended : null;
    return { body, question: { question, options: parsed, recommended } };
  } catch {
    return { body: source, question: null };
  }
}

// While a reply is still being written, question and plan markup is hidden until it is complete.
const OPEN_TAGS = [OPEN_TAG, '<orqestra-plan>', '<orqestra-plan-request>'];
export function visibleText(raw) {
  const source = String(raw ?? '');
  const starts = OPEN_TAGS.map((tag) => source.indexOf(tag)).filter((i) => i >= 0);
  if (starts.length) return source.slice(0, Math.min(...starts)).trimEnd();
  for (const tag of OPEN_TAGS) {
    for (let n = tag.length - 1; n > 0; n -= 1) {
      if (source.endsWith(tag.slice(0, n))) return source.slice(0, source.length - n);
    }
  }
  return source;
}

export function answerFor(question, choice) {
  if (choice.kind === 'skip') return 'I skip this question. Decide yourself and tell me briefly what you chose.';
  if (choice.kind === 'own') return choice.text.trim();
  const option = question.options[choice.index];
  return option.description ? `${option.label} (${option.description})` : option.label;
}

// ---- Plans and team runs (phase 3) ------------------------------------------------------------
// The Manager ends a reply with <orqestra-plan>{json}</orqestra-plan> when work should be done. The
// window shows the plan; nothing runs until the user starts it. The main process validates the plan
// again (main/team/plan.ts) before anything happens.

const PLAN = /<orqestra-plan>\s*([\s\S]*?)\s*<\/orqestra-plan>\s*$/;

export function parsePlan(raw) {
  const source = String(raw ?? '');
  const match = PLAN.exec(source);
  if (!match) return { body: source, plan: null };
  const body = source.slice(0, match.index).trimEnd();
  try {
    const value = JSON.parse(match[1]);
    const goal = text(value?.goal, 1000);
    const tasks = Array.isArray(value?.tasks) ? value.tasks : [];
    if (!goal || tasks.length < 1 || tasks.length > 8) return { body: source, plan: null };
    const parsed = tasks.map((t) => ({
      id: typeof t?.id === 'string' ? t.id : '', title: text(t?.title, 160), role: text(t?.role, 40), goal: text(t?.goal, 3000),
      dependsOn: Array.isArray(t?.dependsOn) ? t.dependsOn.filter((d) => typeof d === 'string') : [],
      deliverables: Array.isArray(t?.deliverables) ? t.deliverables.filter((d) => typeof d === 'string') : [],
      // The task's handoff goes to the main process as written; it is validated there.
      ...(t?.handoff && typeof t.handoff === 'object' && !Array.isArray(t.handoff) ? { handoff: t.handoff } : {}),
    }));
    if (parsed.some((t) => !t.id || !t.title || !t.role || !t.goal || !t.deliverables.length)) return { body: source, plan: null };
    const rules = Array.isArray(value?.rules) ? value.rules.filter((r) => typeof r === 'string') : [];
    return { body, plan: { goal, tasks: parsed, ...(rules.length ? { rules } : {}) } };
  } catch {
    return { body: source, plan: null };
  }
}

const byPriority = (a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0) || String(a.name).localeCompare(String(b.name));

// Who is in the team, as the Manager sees it.
export function teamMembers(graph) {
  return (graph?.nodes || []).filter((n) => n.role !== 'Manager').map((n) => ({ name: String(n.name).slice(0, 48), role: n.role, ready: isRealAgent(n) }));
}

// The agents that can work, as the main process needs them.
export function teamAgents(graph) {
  return (graph?.nodes || []).filter((n) => n.role !== 'Manager' && isRealAgent(n)).map((n) => ({
    id: n.id, name: String(n.name).slice(0, 48), role: n.role, priority: Number(n.priority) || 0,
    tool: n.agent.tool, model: n.agent.model ?? null, effort: n.agent.effort ?? null,
  }));
}

// Which agent each task will start with (the highest priority real agent with that role).
export function planAssignments(plan, graph) {
  const agents = teamAgents(graph);
  return plan.tasks.map((t) => ({ ...t, agent: agents.filter((a) => a.role === t.role).sort(byPriority)[0] || null }));
}

export function newTeamRun(id, plan) {
  return { id, status: 'running', goal: plan.goal, tasks: plan.tasks.map((t) => ({ id: t.id, title: t.title, role: t.role, deliverables: t.deliverables, status: 'waiting', agentId: null, attempt: 0, note: null, review: null, files: [] })), summary: null, files: [], calls: 0, usage: null };
}

export function applyTeamEvent(run, event) {
  const patch = (taskId, fn) => ({ ...run, tasks: run.tasks.map((t) => (t.id === taskId ? fn(t) : t)) });
  switch (event && event.type) {
    case 'run-started': return { ...run, tasks: run.tasks.map((t) => { const a = event.tasks.find((x) => x.id === t.id); return a ? { ...t, plannedAgentId: a.agentId, plannedAgentName: a.agentName } : t; }) };
    case 'task': return patch(event.taskId, (t) => ({ ...t, status: event.status, agentId: event.agentId ?? t.agentId, attempt: event.attempt || t.attempt, note: event.note ?? null }));
    case 'review': return patch(event.taskId, (t) => ({ ...t, review: { reviewerId: event.reviewerId, approved: event.approved, problems: event.problems } }));
    case 'files': return patch(event.taskId, (t) => ({ ...t, files: event.files }));
    case 'brief': return patch(event.taskId, (t) => ({ ...t, brief: event.brief }));
    case 'run-finished': return { ...run, status: event.status, summary: event.summary, files: event.files, calls: event.calls, usage: event.usage };
    default: return run;
  }
}

// What each agent in the tree is doing in a run, using the tree's own status names.
const TREE_STATE = { working: 'working', waiting_context: 'working', reviewing: 'reviewing', waiting: 'queued', done: 'completed', unverified: 'completed', failed: 'blocked', blocked: 'blocked', stopped: 'interrupted' };
const RANK = ['working', 'reviewing', 'queued', 'blocked', 'interrupted', 'completed'];
export function nodeStates(run) {
  const states = {};
  if (!run) return states;
  for (const t of run.tasks) {
    const node = t.agentId || t.plannedAgentId;
    if (!node) continue;
    const next = TREE_STATE[t.status];
    if (!next) continue;
    if (!states[node] || RANK.indexOf(next) < RANK.indexOf(states[node])) states[node] = next;
  }
  return states;
}

// A run that was going on when the app closed cannot continue.
export function settleTeamRun(run) {
  if (!run || run.status !== 'running') return run;
  return { ...run, status: 'stopped', summary: 'The app closed while the team was working. Files already written stay in the project folder.', tasks: run.tasks.map((t) => (['waiting', 'working', 'waiting_context', 'reviewing'].includes(t.status) ? { ...t, status: 'stopped' } : t)) };
}

// ---- Setting up the team in one step -----------------------------------------------------------
// Connects the agents that have no tool yet to the tools that are signed in with a subscription.
// Builders and the Manager go on the first tool; reviewers go on another tool when there is one, so
// work is checked by a different provider. Agents the user already set to a real tool are kept.

const TOOL_ORDER = ['codex', 'claude', 'gemini'];
const CHECKING_ROLES = ['Code Reviewer', 'Security Reviewer', 'Reviewer', 'Tester'];

export function firstModel(status) {
  const models = status?.models || [];
  return (models.find((m) => m.isDefault) || models[0] || null)?.id ?? null;
}

export function autoTeam(graph, statuses) {
  const ready = readyProviders(statuses).sort((a, b) => TOOL_ORDER.indexOf(a.provider) - TOOL_ORDER.indexOf(b.provider));
  if (!ready.length) return { graph, changed: [] };
  const main = ready[0];
  const other = ready[1] || ready[0];
  const changed = [];
  const nodes = (graph?.nodes || []).map((n) => {
    if (isRealAgent(n)) return n;
    const status = n.role !== 'Manager' && CHECKING_ROLES.includes(n.role) ? other : n.role === 'Manager' ? (ready.find((t) => t.provider === 'claude') || main) : main;
    changed.push({ id: n.id, name: n.name, tool: status.name });
    return { ...n, ...nodeFieldsFor({ provider: status.provider, model: firstModel(status), effort: null }, status) };
  });
  return { graph: { ...graph, nodes }, changed };
}

// True when the Manager could answer but no agent in the tree can work yet.
export function teamNeedsSetup(graph, statuses) {
  return readyProviders(statuses).length > 0 && (graph?.nodes || []).some((n) => n.role !== 'Manager') && teamAgents(graph).length === 0;
}

// ---- The Planner (decision A6) and re-planning ------------------------------------------------
// With a working Planner, the Manager ends a build request with a brief instead of a plan:
// <orqestra-plan-request>{"brief": "..."}</orqestra-plan-request>. The window then asks the Planner.

const PLAN_REQUEST = /<orqestra-plan-request>\s*([\s\S]*?)\s*<\/orqestra-plan-request>\s*$/;

export function parsePlanRequest(raw) {
  const source = String(raw ?? '');
  const match = PLAN_REQUEST.exec(source);
  if (!match) return { body: source, brief: null };
  try {
    const brief = text(JSON.parse(match[1])?.brief, 6000);
    return brief ? { body: source.slice(0, match.index).trimEnd(), brief } : { body: source, brief: null };
  } catch {
    return { body: source, brief: null };
  }
}

// The Planner that makes the plans: the highest priority Planner that runs on a real tool.
export function plannerOf(graph) {
  return teamAgents(graph).filter((a) => a.role === 'Planner').sort(byPriority)[0] || null;
}

// The message that asks the Manager to fix a run that did not finish. It says what happened and
// which files exist, so the next plan can build on them.
export function replanMessage(run) {
  const tasks = run.tasks.map((t) => `- ${t.title} (${t.role}): ${t.status}${t.note ? ` — ${t.note}` : ''}${t.review && !t.review.approved ? `; review: ${t.review.problems.slice(0, 3).join('; ')}` : ''}${t.brief?.unresolved?.length ? `; unresolved: ${t.brief.unresolved.slice(0, 3).join('; ')}` : ''}`);
  const files = [...new Set([...(run.files || []), ...run.tasks.flatMap((t) => t.files || [])].map((f) => f.path))];
  return [
    `The team run "${run.goal}" did not finish. ${run.summary || ''}`.trim(),
    'Tasks:', ...tasks,
    `Files already in the project folder: ${files.length ? files.join(', ') : 'none'}.`,
    'Make a new plan for what is left. Build on the files that exist, and change them only where needed. Reply in the language I used earlier in this conversation.',
  ].join('\n');
}

// Products (web pages the team built) in the tree. The main process finds them in the project's folder;
// here they are linked to the agents that wrote or reviewed their files, and placed under those agents.
const ACTIVE = ['waiting', 'working', 'waiting_context', 'reviewing'];
const inProduct = (file, product) => product.files.includes(file) || (product.folder !== '' && file.startsWith(`${product.folder}/`));

export function productLinks(product, messages, graph) {
  const known = new Set((graph?.nodes || []).map((n) => n.id));
  const agents = [];
  let building = false;
  for (const m of messages || []) {
    if (m.kind !== 'team' || !m.run) continue;
    for (const t of m.run.tasks || []) {
      const files = [...(t.deliverables || []), ...(t.files || []).map((f) => f.path)];
      if (!files.some((f) => inProduct(f, product))) continue;
      for (const id of [t.agentId || t.plannedAgentId, t.review?.reviewerId]) if (id && known.has(id) && !agents.includes(id)) agents.push(id);
      if (m.run.status === 'running' && ACTIVE.includes(t.status)) building = true;
    }
  }
  return { agents, building };
}

const NODE = { w: 224, h: 159 };
const overlaps = (a, b) => Math.abs(a.x - b.x) < NODE.w + 20 && Math.abs(a.y - b.y) < NODE.h + 30;

export function placeProducts(products, messages, graph) {
  const nodes = graph?.nodes || [];
  const placed = [];
  const bottom = nodes.length ? Math.max(...nodes.map((n) => n.y)) : 0;
  const left = nodes.length ? Math.min(...nodes.map((n) => n.x)) : 0;
  for (const product of products || []) {
    const links = productLinks(product, messages, graph);
    const linked = nodes.filter((n) => links.agents.includes(n.id));
    const spot = linked.length
      ? { x: Math.round(linked.reduce((s, n) => s + n.x, 0) / linked.length), y: Math.max(...linked.map((n) => n.y)) + 240 }
      : { x: left, y: bottom + 240 };
    while ([...nodes, ...placed].some((other) => overlaps(spot, other))) spot.x += NODE.w + 30;
    placed.push({ ...product, ...spot, agents: links.agents, building: links.building });
  }
  return placed;
}

// The preview address of a product: its own host, its entry page, and a version so it reloads after changes.
export function previewUrl(host, product, version = 0) {
  if (!host || !product) return null;
  return `orqestra-preview://${host}/${product.entry.split('/').map(encodeURIComponent).join('/')}?v=${version}`;
}
