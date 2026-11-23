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
    if (v && (PROVIDERS.includes(v.provider) || v.provider === 'auto')) {
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
const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex' };

export function effectiveTarget(target, statuses) {
  const ready = readyProviders(statuses);
  // "Auto" as the tool: the app picks the chatbot and its level per message (main/chat-service.ts pickTool).
  if (target?.provider === 'auto') return ready.length ? { provider: 'auto', model: 'auto', effort: null, name: 'Auto', modelLabel: 'Auto' } : NO_TOOL;
  // Nothing chosen yet: Auto when both tools are connected, else the one that is, with Auto for its level.
  if (!target || !PROVIDERS.includes(target.provider)) {
    if (ready.length > 1) return effectiveTarget({ provider: 'auto' }, statuses);
    const first = ready[0];
    return first ? effectiveTarget({ provider: first.provider, model: 'auto', effort: null }, statuses) : NO_TOOL;
  }
  const status = readyProviders(statuses).find((s) => s.provider === target.provider);
  if (!status) return NO_TOOL;
  const models = status.models || [];
  // "Auto" (also when nothing was chosen): the main process picks a light or strong model per message.
  if (target.model === 'auto' || target.model === null || target.model === undefined) return { provider: status.provider, model: 'auto', effort: null, name: status.name, modelLabel: 'Auto' };
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
      // A request the user gave one agent directly is shown to the Manager as such, not as a request to it.
      // Attachments are sent once, with their message; later turns only say they were there.
      : { role: m.kind === 'user' ? 'user' : 'assistant', text: `${m.to ? `(To ${m.to}, not to you) ` : ''}${(m.kind === 'user' ? String(m.text) : parseRemember(m.text).text).slice(0, 20000)}${m.attachments?.length ? `\n[Attached earlier: ${m.attachments.map((a) => a.name).join(', ')}]` : ''}` }));
}

// A finished team run as the Manager sees it in its next turn: the outcome, and each task's return
// brief (summary, decisions, what was verified and by whom, what is still open). The briefs are
// short, so the Manager can use them in the next plan without the agents' transcripts.
export function teamRunText(run) {
  const title = run.direct ? `${run.direct.name} (asked directly)` : 'Team run';
  const status = run.undone ? `${run.status}, then the user undid its changes` : run.status;
  const lines = [`${title} (${status}): ${run.summary || ''} Files: ${(run.files || []).map((f) => f.path).join(', ') || 'none'}.`];
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
    id, kind: 'assistant', text: '', status: 'streaming', startedAt: Date.now(), ...(target.model === 'auto' ? { auto: true } : {}),
    provider: target.provider, providerName: target.name, model: target.model, effort: target.effort,
  };
}

export function applyChatEvent(message, event) {
  switch (event && event.type) {
    case 'started': return { ...message, model: event.model || message.model };
    // Auto chose the chatbot and level for this message.
    case 'routed': return { ...message, routed: true, provider: event.provider, providerName: TOOL_NAMES[event.provider] || event.provider, model: event.model || message.model, routedReason: event.reason || null };
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

// The Manager (and only the Manager) can be set to Auto: 0rqestra then picks the chatbot and level for each
// message from the task, the same as the Auto choice in the chat.
export const isAutoManager = (node) => Boolean(node && node.role === 'Manager' && node.agent && node.agent.tool === 'auto');

export function isRealAgent(node) {
  return Boolean(node && node.agent && (node.agent.tool === 'claude' || node.agent.tool === 'codex')) || isAutoManager(node);
}

export function agentTarget(node) {
  if (isAutoManager(node)) return { provider: 'auto', model: 'auto', effort: null };
  return isRealAgent(node) ? { provider: node.agent.tool, model: node.agent.model ?? null, effort: node.agent.effort ?? null } : null;
}

// The fields a node gets for a chosen target. `status` is the tool's entry from AI accounts.
export function nodeFieldsFor(target, status, role) {
  if (target && target.provider === 'auto' && role === 'Manager') return { agent: { tool: 'auto', model: 'auto', effort: null }, provider: 'Auto', model: 'Picks the best for each task' };
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

// One question: 2 to 6 options, and the option the Manager would pick.
function readQuestion(value) {
  const question = text(value?.question, 300);
  const options = Array.isArray(value?.options) ? value.options : [];
  if (!question || options.length < 2 || options.length > 6) return null;
  const parsed = options.map((o) => ({ label: text(o?.label, 120), description: text(o?.description, 240) }));
  if (parsed.some((o) => !o.label)) return null;
  const recommended = Number.isInteger(value.recommended) && value.recommended >= 0 && value.recommended < parsed.length ? value.recommended : null;
  return { question, options: parsed, recommended };
}

export const MAX_QUESTIONS = 4;

// The Manager may ask one question, or a short form of up to four ({"questions": [...]}), like Lovable
// does before it builds. `question` is the first one, `questions` all of them.
export function parseQuestion(raw) {
  const source = String(raw ?? '');
  const match = QUESTION.exec(source);
  const none = { body: source, question: null, questions: [] };
  if (!match) return none;
  const body = source.slice(0, match.index).trimEnd();
  try {
    const value = JSON.parse(match[1]);
    const list = Array.isArray(value?.questions) ? value.questions : [value];
    if (list.length < 1 || list.length > MAX_QUESTIONS) return none;
    const questions = list.map(readQuestion);
    if (questions.some((q) => !q)) return none;
    return { body, question: questions[0], questions };
  } catch {
    return none;
  }
}

// While a reply is still being written, question and plan markup is hidden until it is complete.
const OPEN_TAGS = [OPEN_TAG, '<orqestra-plan>', '<orqestra-plan-request>', '<orqestra-remember>'];
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

// The answers to a form of questions, as one message. A skipped question is left to the Manager.
export function answersFor(questions, choices) {
  if (choices.every((c) => c.kind === 'skip')) return 'I skip these questions. Decide yourself and tell me briefly what you chose.';
  if (questions.length === 1) return answerFor(questions[0], choices[0]);
  return questions.map((q, i) => `${i + 1}. ${q.question}\n   ${choices[i].kind === 'skip' ? 'You decide.' : answerFor(q, choices[i])}`).join('\n');
}

// ---- Plans and team runs (phase 3) ------------------------------------------------------------
// The Manager ends a reply with <orqestra-plan>{json}</orqestra-plan> when work should be done. The
// window shows the plan; nothing runs until the user starts it. The main process validates the plan
// again (main/team/plan.ts) before anything happens.

const PLAN = /<orqestra-plan>\s*([\s\S]*?)\s*<\/orqestra-plan>\s*$/;

// The products a plan names (the main process checks them again before a run starts).
export function planProducts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map((p) => ({
    id: typeof p?.id === 'string' ? p.id.trim().toLowerCase() : '',
    name: text(p?.name, 60),
    folder: typeof p?.folder === 'string' && p.folder !== '.' ? p.folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '',
  })).filter((p) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(p.id) && p.name);
}

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
      ...(typeof t?.product === 'string' && t.product.trim() ? { product: t.product.trim().toLowerCase() } : {}),
      ...(text(t?.agent, 48) ? { agent: text(t.agent, 48) } : {}),
      ...(text(t?.why, 160) ? { why: text(t.why, 160) } : {}),
      ...(typeof t?.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(t.model) ? { model: t.model } : {}),
    }));
    if (parsed.some((t) => !t.id || !t.title || !t.role || !t.goal || !t.deliverables.length)) return { body: source, plan: null };
    const rules = Array.isArray(value?.rules) ? value.rules.filter((r) => typeof r === 'string') : [];
    return { body, plan: { goal, tasks: parsed, products: planProducts(value?.products), ...(rules.length ? { rules } : {}) } };
  } catch {
    return { body: source, plan: null };
  }
}

const byPriority = (a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0) || String(a.name).localeCompare(String(b.name));

// Who is in the team, as the Manager sees it.
// The models a tool offers (from its status), so the Manager can choose one per task.
const modelsOf = (tool, statuses) => ((Array.isArray(statuses) ? statuses : []).find((s) => s.provider === tool)?.models || []).map((m) => m.id).filter(Boolean).slice(0, 16);

// Skills (Capabilities): the agent's permanent key (its installed skills follow it to every
// project) and the project's skills that are on for it. The main process looks the skills up.
export function skillRefs(node, graph) {
  const off = new Set(node?.skillsOff || []);
  const projectSkills = (graph?.skills || []).filter((id) => !off.has(id));
  return { ...(node?.agentKey ? { agentKey: node.agentKey } : {}), ...(projectSkills.length ? { projectSkills } : {}) };
}

export function teamMembers(graph, statuses = []) {
  return (graph?.nodes || []).filter((n) => n.role !== 'Manager').map((n) => {
    if (!isRealAgent(n)) return { name: String(n.name).slice(0, 48), role: n.role, ready: false };
    const models = modelsOf(n.agent.tool, statuses);
    return { name: String(n.name).slice(0, 48), role: n.role, ready: true, tool: n.agent.tool, ...(n.agent.model ? { model: n.agent.model } : {}), ...(models.length ? { models } : {}), ...skillRefs(n, graph) };
  });
}

// The agents that can work, as the main process needs them.
export function teamAgents(graph, statuses = []) {
  return (graph?.nodes || []).filter((n) => n.role !== 'Manager' && isRealAgent(n)).map((n) => {
    const models = modelsOf(n.agent.tool, statuses);
    return {
      id: n.id, name: String(n.name).slice(0, 48), role: n.role, priority: Number(n.priority) || 0,
      tool: n.agent.tool, model: n.agent.model ?? null, effort: n.agent.effort ?? null, ...(models.length ? { models } : {}), ...skillRefs(n, graph),
    };
  });
}

// Which agent each task will start with (the highest priority real agent with that role).
// The agent the Manager named for the task (when it has the task's role), else the role's first agent.
export function planAssignments(plan, graph, statuses = []) {
  const agents = teamAgents(graph, statuses);
  return plan.tasks.map((t) => {
    const named = typeof t.agent === 'string' ? agents.find((a) => a.role === t.role && a.name.toLowerCase() === t.agent.toLowerCase()) : null;
    const agent = named || agents.filter((a) => a.role === t.role).sort(byPriority)[0] || null;
    // The model this task runs on: the Manager's choice when the agent's tool offers it, else the agent's own.
    const runsOn = t.model && agent?.models?.includes(t.model) ? t.model : agent?.model || null;
    return { ...t, chosen: Boolean(named), agent, runsOn, modelChosen: Boolean(t.model && runsOn === t.model) };
  });
}

export const TOOL_LABEL = { claude: 'Claude', codex: 'ChatGPT', gemini: 'Gemini' };
// Which tools a plan uses, for the plan card ("Claude and ChatGPT work together").
export function planTools(assignments) {
  return [...new Set(assignments.map((a) => a.agent?.tool).filter(Boolean))].map((t) => TOOL_LABEL[t] || t);
}

// What planning this run cost (Stage 3): the Planner's call, or the Manager's reply that held the
// plan. Only numbers are kept.
export function planningUsage(message) {
  if (!message) return null;
  if (message.planning?.status === 'done') return { by: 'Planner', name: message.planning.plannerName || 'Planner', usage: message.planning.usage || null };
  return { by: 'Manager', name: message.providerName || 'Manager', usage: message.usage || null };
}

export function newTeamRun(id, plan, now = Date.now(), direct = null, planning = null) {
  return { id, status: 'running', planning, startedAt: now, log: [], ...(direct ? { direct } : {}), goal: plan.goal, products: plan.products || [], tasks: plan.tasks.map((t) => ({ id: t.id, title: t.title, role: t.role, deliverables: t.deliverables, ...(t.product ? { product: t.product } : {}), status: 'waiting', agentId: null, attempt: 0, note: null, review: null, files: [] })), summary: null, files: [], calls: 0, usage: null };
}

function applyTeamEventCore(run, event) {
  const patch = (taskId, fn) => ({ ...run, tasks: run.tasks.map((t) => (t.id === taskId ? fn(t) : t)) });
  switch (event && event.type) {
    case 'run-started': return { ...run, tasks: run.tasks.map((t) => { const a = event.tasks.find((x) => x.id === t.id); return a ? { ...t, plannedAgentId: a.agentId, plannedAgentName: a.agentName } : t; }) };
    case 'task': return patch(event.taskId, (t) => ({ ...t, status: event.status, agentId: event.agentId ?? t.agentId, attempt: event.attempt || t.attempt, note: event.note ?? null }));
    case 'review': return patch(event.taskId, (t) => ({ ...t, review: { reviewerId: event.reviewerId, approved: event.approved, problems: event.problems } }));
    case 'files': return patch(event.taskId, (t) => ({ ...t, files: event.files }));
    case 'brief': return patch(event.taskId, (t) => ({ ...t, brief: event.brief }));
    case 'skills': return patch(event.taskId, (t) => ({ ...t, skills: [...(t.skills || []).filter((s) => !(s.agentId === event.agentId && s.kind === event.kind)), { agentId: event.agentId, kind: event.kind, loaded: event.loaded || [], refused: event.refused || [] }] }));
    case 'usage': return { ...run, usageEntries: [...(run.usageEntries || []).filter((e) => e.seq !== event.entry.seq), event.entry] };
    case 'run-finished': return { ...run, status: event.status, summary: event.summary, files: event.files, calls: event.calls, usage: event.usage, totals: event.totals || null };
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
  return { ...run, outputs: (run.outputs || []).map((o) => (o.done ? o : { ...o, done: true, failed: 'The app closed while this agent was writing.' })), status: 'stopped', summary: 'The app closed while the team was working. Files already written stay in the project folder.', tasks: run.tasks.map((t) => (['waiting', 'working', 'waiting_context', 'reviewing'].includes(t.status) ? { ...t, status: 'stopped' } : t)) };
}

// ---- Setting up the team in one step -----------------------------------------------------------
// Connects the agents that have no tool yet to the tools that are signed in with a subscription.
// Builders and the Manager go on the first tool; reviewers go on another tool when there is one, so
// work is checked by a different provider. Agents the user already set to a real tool are kept.

const TOOL_ORDER = ['codex', 'claude', 'gemini'];
// Which tool each role starts on when both are connected (the Manager still picks per task).
export const PREFERRED_TOOL = { Manager: 'claude', Planner: 'claude', Designer: 'claude', Writer: 'claude', 'Code Reviewer': 'claude', Reviewer: 'claude', 'Security Reviewer': 'codex', Builder: 'codex', Tester: 'codex', Debugger: 'codex' };

export function firstModel(status) {
  const models = status?.models || [];
  return (models.find((m) => m.isDefault) || models[0] || null)?.id ?? null;
}

// The tool for the n-th agent of a role: the role's preferred tool first, then the other, in turn, so a
// role with several agents has some on each tool and the Manager can pick per task.
function toolFor(role, ready, nth) {
  const preferred = ready.find((t) => t.provider === PREFERRED_TOOL[role]) || ready[0];
  const others = ready.filter((t) => t !== preferred);
  return nth % 2 === 0 || !others.length ? preferred : others[(Math.floor(nth / 2)) % others.length];
}

export function autoTeam(graph, statuses) {
  const ready = readyProviders(statuses).sort((a, b) => TOOL_ORDER.indexOf(a.provider) - TOOL_ORDER.indexOf(b.provider));
  if (!ready.length) return { graph, changed: [] };
  const changed = [];
  const seen = {};
  const nodes = [...(graph?.nodes || [])].sort(byPriority).map((n) => {
    const nth = n.role === 'Manager' ? 0 : (seen[n.role] = (seen[n.role] ?? -1) + 1);
    if (isRealAgent(n)) return n;
    const status = toolFor(n.role, ready, nth);
    changed.push({ id: n.id, name: n.name, tool: status.name });
    return { ...n, ...nodeFieldsFor({ provider: status.provider, model: firstModel(status), effort: null }, status) };
  });
  const order = new Map((graph?.nodes || []).map((n, i) => [n.id, i]));
  return { graph: { ...graph, nodes: nodes.sort((a, b) => order.get(a.id) - order.get(b.id)) }, changed: changed.sort((a, b) => order.get(a.id) - order.get(b.id)) };
}

// When both tools are connected but every agent runs on the same one: move the roles that suit the other
// tool there (Builder and Tester to Codex, Planner, Designer and reviews to Claude), so they work together.
export function usesOneTool(graph, statuses) {
  const ready = readyProviders(statuses);
  const tools = new Set((graph?.nodes || []).filter((n) => n.role !== 'Manager' && isRealAgent(n)).map((n) => n.agent.tool));
  return ready.length > 1 && tools.size === 1;
}

export function mixTeam(graph, statuses) {
  const ready = readyProviders(statuses).sort((a, b) => TOOL_ORDER.indexOf(a.provider) - TOOL_ORDER.indexOf(b.provider));
  if (ready.length < 2) return { graph, changed: [] };
  const changed = [];
  const seen = {};
  const want = new Map();
  for (const n of [...(graph?.nodes || [])].sort(byPriority)) {
    if (n.role === 'Manager' || !isRealAgent(n)) continue;
    want.set(n.id, toolFor(n.role, ready, (seen[n.role] = (seen[n.role] ?? -1) + 1)));
  }
  const nodes = (graph?.nodes || []).map((n) => {
    const target = want.get(n.id);
    if (!target || target.provider === n.agent.tool) return n;
    changed.push({ id: n.id, name: n.name, tool: target.name });
    return { ...n, ...nodeFieldsFor({ provider: target.provider, model: firstModel(target), effort: null }, target) };
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
      const named = t.product && (product.plannedIds || []).includes(t.product);
      if (!named && !files.some((f) => inProduct(f, product))) continue;
      for (const id of [t.agentId || t.plannedAgentId, t.review?.reviewerId]) if (id && known.has(id) && !agents.includes(id)) agents.push(id);
      if (m.run.status === 'running' && ACTIVE.includes(t.status)) building = true;
    }
  }
  return { agents, building };
}

const NODE = { w: 224, h: 159 };
const overlaps = (a, b) => Math.abs(a.x - b.x) < NODE.w + 20 && Math.abs(a.y - b.y) < NODE.h + 30;

export function placeProducts(products, messages, graph, positions = {}) {
  const nodes = graph?.nodes || [];
  const placed = [];
  const bottom = nodes.length ? Math.max(...nodes.map((n) => n.y)) : 0;
  const left = nodes.length ? Math.min(...nodes.map((n) => n.x)) : 0;
  for (const product of products || []) {
    const links = productLinks(product, messages, graph);
    const linked = nodes.filter((n) => links.agents.includes(n.id));
    const saved = positions?.[product.id];
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      placed.push({ ...product, x: saved.x, y: saved.y, agents: links.agents, building: links.building });
      continue;
    }
    // Under the lowest of its agents (the last to work on it), one row down.
    const lowest = linked.length ? Math.max(...linked.map((n) => n.y)) : 0;
    const under = linked.filter((n) => n.y >= lowest - NODE.h / 2);
    const spot = linked.length
      ? { x: Math.round(under.reduce((s, n) => s + n.x, 0) / under.length), y: lowest + NODE.h + 56 }
      : { x: left, y: bottom + NODE.h + 56 };
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

// ---- Usage in a run's details (Stage 3) -----------------------------------------------------------
// Numbers only, from the runner's ledger and the planning call. A call the tool reported no usage for
// is "Unavailable"; totals that leave such calls out are "Partial".

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const tokens = (u) => (u && u.inputTokens != null && u.outputTokens != null
  ? `${fmt(u.inputTokens)} in${u.cachedInputTokens ? ` (${fmt(u.cachedInputTokens)} cached)` : ''} · ${fmt(u.outputTokens)} out`
  : 'Unavailable');

export function runUsage(run) {
  if (!run) return null;
  const entries = run.usageEntries || [];
  const byAgent = new Map();
  for (const e of entries) {
    const a = byAgent.get(e.agentId) || { name: e.agentName, role: e.role, calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, unavailable: 0, kinds: {} };
    a.calls += 1;
    a.kinds[e.kind] = (a.kinds[e.kind] || 0) + 1;
    if (e.inputTokens == null || e.outputTokens == null) a.unavailable += 1;
    a.inputTokens += e.inputTokens || 0;
    a.cachedInputTokens += e.cachedInputTokens || 0;
    a.outputTokens += e.outputTokens || 0;
    byAgent.set(e.agentId, a);
  }
  const plan = run.planning;
  const planKnown = Boolean(plan?.usage && plan.usage.inputTokens != null && plan.usage.outputTokens != null);
  const rows = [];
  if (plan) rows.push({ label: `Planning · ${plan.name} (${plan.by})`, calls: 1, text: tokens(plan.usage) });
  for (const a of byAgent.values()) {
    const kinds = Object.entries(a.kinds).map(([k, n]) => `${n} ${k === 'worker' ? 'work' : k}`).join(', ');
    rows.push({ label: `${a.name} (${a.role})`, calls: a.calls, kinds, text: a.unavailable === a.calls ? 'Unavailable' : `${tokens(a)}${a.unavailable ? ' · Partial' : ''}` });
  }
  const unavailable = [...byAgent.values()].reduce((n, a) => n + a.unavailable, 0) + (plan && !planKnown ? 1 : 0);
  const sum = (k) => [...byAgent.values()].reduce((n, a) => n + a[k], 0) + (planKnown ? plan.usage[k] || 0 : 0);
  const calls = entries.length + (plan ? 1 : 0);
  const t = run.totals || {};
  return {
    rows,
    calls,
    retries: t.retries || 0,
    contextRequests: t.contextRequests || 0,
    total: calls === 0 ? 'No model calls yet' : unavailable === calls ? 'Unavailable' : `${tokens({ inputTokens: sum('inputTokens'), cachedInputTokens: sum('cachedInputTokens'), outputTokens: sum('outputTokens') })}${unavailable ? ' · Partial' : ''}`,
    partial: unavailable > 0,
  };
}

// Problems a previewed page showed (main/preview/problems.ts), per project. The same problem is kept once.
export const MAX_PROBLEMS = 20;
const KINDS = ['error', 'missing', 'blocked'];
const shortText = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function readProblem(raw) {
  if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.kind)) return null;
  const message = shortText(raw.message, 400);
  if (!message) return null;
  return { kind: raw.kind, message, page: shortText(raw.page, 200), source: shortText(raw.source, 200), line: Number.isInteger(raw.line) && raw.line > 0 ? raw.line : null };
}

export function addProblem(list, problem) {
  if (!problem) return list || [];
  const same = (p) => p.kind === problem.kind && p.message === problem.message && p.source === problem.source && p.line === problem.line;
  if ((list || []).some(same)) return list;
  return [...(list || []), problem].slice(-MAX_PROBLEMS);
}

const underProduct = (file, product) => Boolean(file) && (product.folder === '' || file.startsWith(`${product.folder}/`) || product.files.includes(file));
export function problemsFor(product, list) {
  if (!product) return [];
  return (list || []).filter((p) => underProduct(p.page, product) || (!p.page && underProduct(p.source, product)));
}

const KIND_LABEL = { error: 'Script error', missing: 'Missing file', blocked: 'Blocked' };
export function problemLine(p) {
  const where = p.source && p.kind !== 'missing' ? ` (${p.source}${p.line ? `, line ${p.line}` : ''})` : '';
  return `${KIND_LABEL[p.kind]}: ${p.message}${where}`;
}

// The message that asks the Manager to fix what the preview showed.
export function fixMessage(product, problems) {
  return [
    `The preview of "${product.name}" (${product.entry}) shows ${problems.length === 1 ? 'this problem' : 'these problems'}:`,
    ...problems.slice(0, 10).map((p) => `- ${problemLine(p)}`),
    `Files of this product: ${product.files.slice(0, 40).join(', ')}.`,
    'Make a plan that fixes this. Change only the files that need it, and keep everything that already works. Reply in the language I used earlier in this conversation.',
  ].join('\n');
}

// The products in the tree: what the main process found in the folder, plus what the latest plans named.
// A named product takes the found one with the same folder (and its name); one with no files yet is shown
// as planned, so the user sees it in the tree from the moment the run starts.
const productKey = (folder) => folder || 'root';
export function mergeProducts(found, messages) {
  const out = (found || []).map((p) => ({ ...p, plannedIds: [] }));
  const runs = (messages || []).filter((m) => m.kind === 'team' && m.run).map((m) => m.run);
  const latest = runs.at(-1);
  for (const run of runs) {
    for (const planned of run.products || []) {
      const match = out.find((p) => p.folder.toLowerCase() === planned.folder.toLowerCase());
      if (match) {
        if (!match.plannedIds.includes(planned.id)) match.plannedIds.push(planned.id);
        match.name = planned.name;
      } else if (run === latest) {
        out.push({ id: productKey(planned.folder), folder: planned.folder, entry: planned.folder ? `${planned.folder}/index.html` : 'index.html', name: planned.name, kind: 'web', files: [], updatedAt: 0, planned: true, plannedIds: [planned.id] });
      }
    }
  }
  return out;
}

// "Select" in the preview: what the page said was clicked (main/preview/picker.ts). It comes from the
// page, so it is cut short and only ever used as quoted text.
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
export function readPicked(data) {
  if (!data || typeof data !== 'object' || data.type !== 'orqestra-picked') return null;
  const tag = oneLine(data.tag, 30).toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;
  return { tag, path: oneLine(data.path, 200), text: oneLine(data.text, 200), html: typeof data.html === 'string' ? data.html.slice(0, 600) : '' };
}

export function pickedLabel(picked) {
  const text = picked.text ? ` “${picked.text.length > 60 ? `${picked.text.slice(0, 60)}…` : picked.text}”` : '';
  return `<${picked.tag}>${text}`;
}

// The message that asks the Manager to change one part of a product.
export function editMessage(product, picked, request) {
  return [
    `Change one part of "${product.name}" (${product.entry}).`,
    `The part I selected in the preview: the <${picked.tag}> element${picked.path ? ` at ${picked.path}` : ''}${picked.text ? `, with the text "${picked.text}"` : ''}.`,
    picked.html ? `Its HTML starts like this:\n${picked.html}` : null,
    `What I want: ${request.trim()}`,
    `Files of this product: ${product.files.slice(0, 40).join(', ')}.`,
    'Make a plan that changes only this, and keeps everything else as it is. Reply in the language I used earlier in this conversation.',
  ].filter(Boolean).join('\n');
}

// ---- What the team did, step by step, like Claude's activity lines ----------------------------
export const MAX_LOG = 200;
function logEntry(event) {
  switch (event && event.type) {
    case 'run-started': return { type: 'run-started', count: (event.tasks || []).length };
    case 'task': return { type: 'task', taskId: event.taskId, status: event.status, agentId: event.agentId ?? null, attempt: event.attempt || 1, note: event.note ? String(event.note).slice(0, 300) : null };
    case 'review': return { type: 'review', taskId: event.taskId, reviewerId: event.reviewerId, approved: Boolean(event.approved), problems: (event.problems || []).slice(0, 2).map((p) => String(p).slice(0, 200)) };
    case 'files': return { type: 'files', taskId: event.taskId, files: (event.files || []).slice(0, 12).map((f) => ({ path: String(f.path), bytes: Number(f.bytes) || 0 })) };
    case 'run-finished': return { type: 'run-finished', status: event.status, summary: event.summary ? String(event.summary).slice(0, 300) : null };
    default: return null;
  }
}

export function applyTeamEvent(run, event, now = Date.now()) {
  if (event && event.type === 'output') return { ...run, outputs: addOutput(run.outputs, event, now) };
  const next = applyTeamEventCore(run, event);
  const entry = logEntry(event);
  if (!entry) return next;
  return { ...next, startedAt: run.startedAt ?? now, ...(entry.type === 'run-finished' ? { endedAt: now } : {}), log: [...(run.log || []), { at: now, ...entry }].slice(-MAX_LOG) };
}

const size = (bytes) => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${bytes} B`);
const STEP = { working: 'started', reviewing: 'is reviewing', done: 'finished', unverified: 'finished (not reviewed)', failed: 'could not finish', blocked: 'is blocked on', stopped: 'stopped' };
// One activity line: what kind of step it is (for the icon) and its text.
export function logLine(entry, run, nameOf) {
  const task = run.tasks.find((t) => t.id === entry.taskId);
  const title = task ? `“${task.title}”` : 'a task';
  const who = (id) => (id ? nameOf(id) : 'The team');
  switch (entry.type) {
    case 'run-started': return { kind: 'start', text: `The team started ${entry.count} task${entry.count === 1 ? '' : 's'}` };
    case 'task':
      if (entry.status === 'waiting') return null;
      if (entry.status === 'working' && entry.attempt > 1) return { kind: 'retry', text: `${who(entry.agentId)} tries ${title} again (attempt ${entry.attempt})${entry.note ? ` — ${entry.note}` : ''}` };
      return { kind: entry.status, text: `${who(entry.agentId)} ${STEP[entry.status] || entry.status} ${title}${['failed', 'blocked'].includes(entry.status) && entry.note ? ` — ${entry.note}` : ''}` };
    case 'review': return entry.approved
      ? { kind: 'approved', text: `${who(entry.reviewerId)} approved ${title}` }
      : { kind: 'changes', text: `${who(entry.reviewerId)} asked for changes to ${title}${entry.problems.length ? `: ${entry.problems.join('; ')}` : ''}` };
    case 'files': return { kind: 'files', text: `${task?.agentId ? nameOf(task.agentId) : 'An agent'} wrote ${entry.files.map((f) => `${f.path} (${size(f.bytes)})`).join(', ')}` };
    case 'run-finished': return { kind: entry.status === 'done' ? 'finished' : 'failed', text: entry.status === 'done' ? 'The team finished' : entry.status === 'stopped' ? 'The run was stopped' : `The run did not finish${entry.summary ? ` — ${entry.summary}` : ''}` };
    default: return null;
  }
}

// "12s", "3m 05s", "1h 02m": how long something has been going on.
export function elapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// ---- How much of each subscription is left (the sidebar) ----------------------------------------
const WINDOW_NAME = (l) => (l.windowMinutes === 300 ? '5 hours' : l.windowMinutes >= 7 * 1440 - 60 && l.windowMinutes <= 7 * 1440 + 60 ? 'Week' : l.label);
const TOOL_NAME = { claude: 'Claude', codex: 'ChatGPT' };
export function usageRows(statuses, now = Date.now()) {
  return (statuses || []).filter((s) => s.installed && s.signedIn && s.subscription).map((s) => ({
    provider: s.provider,
    name: TOOL_NAME[s.provider] || s.name,
    at: s.limitsAt || null,
    windows: (s.limits || []).map((l) => {
      const left = Math.max(0, Math.min(100, Math.round(100 - Number(l.usedPercent))));
      const resets = typeof l.resetsAt === 'number' && l.resetsAt * 1000 > now ? l.resetsAt * 1000 : null;
      return { name: WINDOW_NAME(l), left, resets };
    }).sort((a, b) => (a.name === '5 hours' ? -1 : b.name === '5 hours' ? 1 : 0)),
  }));
}

// ---- What each agent wrote (main/team/runner.ts "output" events), for the agent's panel ----------
export const MAX_OUTPUTS = 16;
export const OUTPUT_KEEP = 6000;
export function addOutput(list, event, now = Date.now()) {
  const text = typeof event.text === 'string' ? event.text : '';
  const entry = {
    taskId: String(event.taskId), agentId: String(event.agentId), kind: event.kind === 'review' ? 'review' : 'work', attempt: Number(event.attempt) || 1,
    text: event.done ? text.slice(0, OUTPUT_KEEP) : text.slice(-OUTPUT_KEEP), done: Boolean(event.done),
    ...(event.failed ? { failed: String(event.failed).slice(0, 500) } : {}), at: now,
  };
  const same = (o) => o.taskId === entry.taskId && o.agentId === entry.agentId && o.kind === entry.kind && o.attempt === entry.attempt;
  const old = (list || []).find(same);
  const rest = (list || []).filter((o) => !same(o));
  const next = [...rest, { ...entry, startedAt: old?.startedAt ?? now }];
  while (next.length > MAX_OUTPUTS) next.splice(next.findIndex((o) => o.done) >= 0 ? next.findIndex((o) => o.done) : 0, 1);
  return next;
}

// Everything one agent did in the project's team runs: what it is writing now, earlier answers (newest
// first) with their task, and the files it wrote.
export function agentWork(messages, agentId) {
  const runs = (messages || []).filter((m) => m.kind === 'team' && m.run).map((m) => m.run);
  const history = [];
  const files = new Map();
  let live = null;
  for (const run of runs) {
    for (const o of run.outputs || []) {
      if (o.agentId !== agentId) continue;
      const task = run.tasks.find((t) => t.id === o.taskId);
      const item = { ...o, taskTitle: task ? task.title : 'A task', goal: run.goal, running: run.status === 'running' };
      if (!o.done && run.status === 'running') live = item;
      else history.push(item);
    }
    for (const t of run.tasks) if (t.agentId === agentId) for (const f of t.files || []) files.set(f.path, f);
  }
  history.sort((a, b) => b.at - a.at);
  return { live, history, files: [...files.values()] };
}

// An agent's answer split into readable parts: text, the files it delivered (shown as one line each,
// also while a file is still being written), and a review's verdict.
export function textParts(text) {
  const parts = [];
  const source = String(text ?? '');
  const tag = /<orqestra-file path="([^"]{1,200})">\r?\n?([\s\S]*?)(<\/orqestra-file>|$)|<orqestra-review>([\s\S]*?)(<\/orqestra-review>|$)/g;
  let at = 0;
  for (const m of source.matchAll(tag)) {
    const before = source.slice(at, m.index).trim();
    if (before) parts.push({ type: 'text', text: before });
    if (m[1] !== undefined) {
      const body = (m[2] || '').replace(/\r?\n$/, '');
      parts.push({ type: 'file', path: m[1], lines: body ? body.split('\n').length : 0, done: Boolean(m[3]) });
    } else {
      let verdict;
      try { verdict = JSON.parse(m[4]); } catch { verdict = null; }
      parts.push(verdict && typeof verdict.approved === 'boolean'
        ? { type: 'review', approved: verdict.approved, problems: Array.isArray(verdict.problems) ? verdict.problems.map(String).slice(0, 10) : [] }
        : { type: 'text', text: m[0] });
    }
    at = m.index + m[0].length;
  }
  const after = source.slice(at).trim();
  if (after) parts.push({ type: 'text', text: after });
  return parts;
}

// A request the user gives one agent directly (from its panel). The same one-task plan the main
// process builds (main/team/plan.ts directPlan), so the run card can show it at once.
export function directPlanFor(request, agent) {
  const text = String(request ?? '').trim();
  const short = text.replace(/\s+/g, ' ');
  return {
    goal: short.length > 160 ? `${short.slice(0, 157)}…` : short,
    tasks: [{ id: 't1', title: short.length > 80 ? `${short.slice(0, 77)}…` : short, role: agent.role, goal: text, dependsOn: [], deliverables: [], open: true, agentId: agent.id }],
    products: [],
  };
}

// The agent's own words in a direct run, for the run card (its last finished answer).
export function directReply(run) {
  if (!run?.direct) return null;
  const answers = (run.outputs || []).filter((o) => o.kind === 'work' && o.done && !o.failed && o.agentId === run.direct.agentId);
  return answers.length ? answers[answers.length - 1].text : null;
}

// Undo: only the newest finished run that wrote files can be undone (then the one before it, and so on),
// so a later change is never lost by undoing an earlier one. The main process checks the same.
const wroteFiles = (run) => (run.files || []).length > 0 || (run.tasks || []).some((t) => (t.files || []).length > 0);
export function undoableRunId(messages) {
  const runs = (messages || []).filter((m) => m.kind === 'team' && m.run).map((m) => m.run);
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run.status === 'running') return null;
    if (run.undone || !wroteFiles(run)) continue;
    return run.id;
  }
  return null;
}

// ---- Project memory: facts the Manager saves with <orqestra-remember>…</orqestra-remember> ------------
export const MAX_MEMORY = 40;
const REMEMBER = /<orqestra-remember>([\s\S]*?)<\/orqestra-remember>/g;
export function parseRemember(raw) {
  const source = String(raw ?? '');
  const facts = [...source.matchAll(REMEMBER)].map((m) => m[1].replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean);
  return { text: source.replace(REMEMBER, '').replace(/\n{3,}/g, '\n\n').trim(), facts };
}

// Adds facts to a project's memory: no duplicates (ignoring case), the newest kept when it is full.
export function addMemory(memory, facts, now = Date.now()) {
  const list = [...(memory || [])];
  for (const fact of facts) {
    if (list.some((m) => m.text.toLowerCase() === fact.toLowerCase())) continue;
    list.push({ id: `m${now.toString(36)}${list.length}`, text: fact, at: now });
  }
  return list.slice(-MAX_MEMORY);
}

// A project with only its Manager gets a starting team in one click: a Planner, two Builders and a
// reviewer, each on the tool that suits it (autoTeam spreads the Builders over both tools when both are
// connected). Connected to the Manager; the window then arranges them.
export const STARTER_TEAM = [
  { id: 'planner', name: 'The architect', role: 'Planner' },
  { id: 'builder', name: 'Code builder', role: 'Builder' },
  { id: 'builder-2', name: 'Interface builder', role: 'Builder' },
  { id: 'reviewer', name: 'Fresh eyes', role: 'Code Reviewer' },
];

export function onlyManager(graph) {
  return (graph?.nodes || []).every((n) => n.role === 'Manager');
}

export function starterTeam(graph, statuses) {
  if (!onlyManager(graph) || !readyProviders(statuses).length) return { graph, changed: [] };
  const manager = (graph.nodes || []).find((n) => n.role === 'Manager');
  const added = STARTER_TEAM.map((a, i) => ({ ...a, priority: a.id === 'builder-2' ? 2 : 1, x: 100 + i * 280, y: 300, agent: null }));
  const edges = [...(graph.edges || []), ...(manager ? added.map((a) => ({ id: `e-${a.id}`, from: manager.id, to: a.id })) : [])];
  const { graph: next } = autoTeam({ ...graph, nodes: [...graph.nodes, ...added], edges }, statuses);
  // The Manager is left as it was: the chat's own choice (Auto, or a model picked by hand) stays in force.
  const nodes = next.nodes.map((n) => (n.role === 'Manager' ? graph.nodes.find((m) => m.id === n.id) || n : n));
  return { graph: { ...next, nodes }, changed: added.map((a) => a.id) };
}
