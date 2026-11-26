// "Get started" in a new project's chat: four steps from opening 0rqestra to a first finished task.
// Every step is read from the app's real state (granted folders, AI accounts, the team tree, runs),
// never from which buttons were clicked. The only stored choices are the project's own: that the
// user builds in 0rqestra's workspace instead of a folder, and that the checklist was dismissed.

import { isRealAgent, parsePlan, readyProviders } from './live-chat.mjs';

// New projects get the checklist; existing ones and "Ask anything" never do unless reopened.
export const NEW_PROJECT_ONBOARDING = { show: true, dismissed: false, workspace: false };

export function showsChecklist(project, general = false) {
  return !general && Boolean(project?.onboarding?.show) && !project.onboarding.dismissed;
}

export function dismissed(project) {
  return { ...project, onboarding: { ...(project.onboarding || {}), show: true, dismissed: true } };
}

export function reopened(project) {
  return { ...project, onboarding: { ...(project.onboarding || {}), show: true, dismissed: false } };
}

export function withWorkspace(project) {
  return { ...project, onboarding: { ...(project.onboarding || {}), show: true, workspace: true } };
}

// The editable starter request offered for the first task.
export function starterRequest(project) {
  const name = String(project?.name || 'my project').trim();
  return `Build a simple one-page website for "${name}" in index.html: a heading, a short introduction and a contact line. Keep it to plain HTML and CSS.`;
}

// Agents that cannot work yet, and why: no tool, or a model the tool does not offer.
export function agentProblems(graph, providers) {
  const problems = [];
  for (const n of graph?.nodes || []) {
    if (n.role === 'Manager') continue;
    if (!isRealAgent(n)) { problems.push({ id: n.id, name: n.name, role: n.role, problem: 'needs a provider (Claude Code or Codex)' }); continue; }
    const status = (providers || []).find((s) => s.provider === n.agent.tool);
    if (!status || !status.installed || !status.subscription) { problems.push({ id: n.id, name: n.name, role: n.role, problem: `runs on ${status?.name || n.agent.tool}, which is not signed in` }); continue; }
    if (n.agent.model && Array.isArray(status.models) && status.models.length && !status.models.some((m) => m.id === n.agent.model)) {
      problems.push({ id: n.id, name: n.name, role: n.role, problem: `uses the model ${n.agent.model}, which ${status.name} does not offer` });
    }
  }
  return problems;
}

const WORKING = (n) => n.role !== 'Manager' && isRealAgent(n);

// The first run's outcome, read from the project's team runs. A run "meets its checks" when every
// task finished and was reviewed; "Done, not reviewed" is reported as such, not as complete.
export function firstRunState(messages, runChanges = {}) {
  const runs = (messages || []).filter((m) => m.kind === 'team' && m.run).map((m) => m.run);
  const passed = runs.find((r) => r.status === 'done' && r.tasks.length > 0 && r.tasks.every((t) => t.status === 'done'));
  if (passed) {
    const pending = runChanges[passed.id]?.pending || 0;
    return { state: 'done', run: passed, pending };
  }
  const latest = runs.at(-1);
  if (!latest) {
    // A plan the Manager made that waits for Start.
    const waiting = [...(messages || [])].reverse().find((m) => m.kind === 'assistant' && !m.planStarted && ((m.planning?.status === 'done' && m.planning.plan) || (m.status === 'done' && parsePlan(m.text).plan)));
    return waiting ? { state: 'plan', messageId: waiting.id } : { state: 'none' };
  }
  if (latest.status === 'running') return { state: 'running', run: latest };
  if (latest.status === 'done') return { state: 'unverified', run: latest, pending: runChanges[latest.id]?.pending || 0 };
  return { state: latest.status === 'stopped' ? 'stopped' : 'failed', run: latest };
}

// The steps, each { id, status: 'done'|'todo'|'blocked'|'warn'|'active', title, detail, action },
// and the one next action. `access` is Computer access's view of the project (null while loading).
export function checklist({ project, graph, providers, access, runChanges = {} }) {
  const onboarding = project?.onboarding || {};
  const ready = readyProviders(providers);
  const folders = access?.folders || [];
  const folder = folders.find((f) => f.available) || folders[0] || null;
  const steps = [];

  // 1. Where the work lands.
  if (folder) {
    steps.push({ id: 'folder', status: folder.available ? 'done' : 'warn', title: 'Choose a project folder', detail: folder.available ? `${folder.path}${folder.write ? '' : ' · agents may read it; allow changes in Computer access to apply reviewed files there'}` : `${folder.path} · ${folder.problem || 'not available'}`, action: folder.write ? null : { kind: 'access', label: 'Computer access' } });
  } else if (onboarding.workspace) {
    steps.push({ id: 'folder', status: 'done', title: 'Choose a project folder', detail: `Building something new in 0rqestra's workspace${access?.workspace ? `: ${access.workspace}` : ''}.`, action: { kind: 'pick-folder', label: 'Use a folder instead' } });
  } else {
    steps.push({ id: 'folder', status: 'todo', title: 'Choose a project folder', detail: 'Pick the folder you work in, or build something new in 0rqestra’s own workspace.', action: { kind: 'pick-folder', label: 'Choose folder' }, alt: { kind: 'workspace', label: 'Build something new' } });
  }

  // 2. A tool that answers.
  if (ready.length) {
    steps.push({ id: 'provider', status: 'done', title: 'Connect Claude Code or Codex', detail: `${ready.map((s) => s.name).join(' and ')} ${ready.length === 1 ? 'is' : 'are'} ready.` });
  } else {
    const known = (providers || []).find((s) => s.installed) || (providers || [])[0];
    steps.push({ id: 'provider', status: 'todo', title: 'Connect Claude Code or Codex', detail: known ? `${known.name}: ${known.installed ? (known.signedIn ? 'not signed in with a subscription' : 'signed out') : 'not installed'}.` : 'Nothing is connected yet.', action: { kind: 'accounts', label: 'Open AI accounts', provider: known?.provider || null } });
  }

  // 3. The team (optional when the user only chats with the Manager).
  const others = (graph?.nodes || []).filter((n) => n.role !== 'Manager');
  const problems = agentProblems(graph, providers);
  // Agents that can work now: on a signed-in tool, with a model it offers.
  const stuck = new Set(problems.map((p) => p.id));
  const working = (graph?.nodes || []).filter((n) => WORKING(n) && !stuck.has(n.id)).length;
  if (!others.length) {
    steps.push({ id: 'team', status: ready.length ? 'todo' : 'blocked', optional: true, title: 'Set up the team', detail: ready.length ? 'Add a Planner, Builders and a Reviewer in one step. Skip this if you only want to chat with the Manager.' : 'Connect a tool first; the team runs on it.', action: ready.length ? { kind: 'create-team', label: 'Create the team' } : null });
  } else if (!problems.length) {
    const reviewer = (graph?.nodes || []).some((n) => WORKING(n) && /Reviewer/.test(n.role));
    steps.push({ id: 'team', status: reviewer ? 'done' : 'warn', optional: true, title: 'Set up the team', detail: `${working} agent${working === 1 ? '' : 's'} ready${reviewer ? ', including a reviewer' : '; add a Code Reviewer so finished work is checked'}.`, action: reviewer ? { kind: 'tree', label: 'Open team tree' } : { kind: 'tree', label: 'Add a reviewer' } });
  } else {
    const first = problems[0];
    const fixable = problems.some((p) => p.problem.startsWith('needs a provider')) && ready.length;
    steps.push({ id: 'team', status: working ? 'warn' : 'todo', optional: true, title: 'Set up the team', detail: problems.map((p) => `${p.name} (${p.role}) ${p.problem}`).join('; '), problems, action: fixable ? { kind: 'setup-team', label: 'Set up the team' } : { kind: 'configure', label: `Configure ${first.name}`, agentId: first.id } });
  }

  // 4. A first real task, through the normal plan and Start.
  const run = firstRunState(project?.messages, runChanges);
  const canRun = ready.length > 0 && working > 0;
  const task = { id: 'task', title: 'Run a first task' };
  // Files wait to be applied only when there is a folder to apply them to; in 0rqestra's workspace they already are where they belong.
  const toApply = folder ? run.pending : 0;
  if (run.state === 'done') Object.assign(task, { status: 'done', detail: `“${run.run.goal}” finished and passed review.${toApply ? ` ${toApply === 1 ? '1 file waits' : `${toApply} files wait`} to be applied to your folder.` : folder ? '' : ' Its files are in the project workspace (Open folder in the project menu).'}`, action: toApply ? { kind: 'review', label: 'Review changes', runId: run.run.id } : null });
  else if (run.state === 'running') Object.assign(task, { status: 'active', detail: `The team is working on “${run.run.goal}”.`, action: null });
  else if (run.state === 'plan') Object.assign(task, { status: 'active', detail: 'The Manager made a plan. Check it, then click Start on the plan.', action: { kind: 'scroll', label: 'Show the plan', messageId: run.messageId } });
  else if (run.state === 'unverified') Object.assign(task, { status: 'warn', detail: `“${run.run.goal}” finished, but not every task was reviewed. Add a Code Reviewer to the team and run it again to have it checked.`, action: { kind: 'tree', label: 'Add a reviewer' } });
  else if (run.state === 'failed' || run.state === 'stopped') Object.assign(task, { status: 'warn', detail: `“${run.run.goal}” ${run.state === 'stopped' ? 'was stopped' : 'did not finish'}. The run card says what happened and how to retry.`, action: { kind: 'scroll-run', label: 'Show the run', runId: run.run.id } });
  else if (!canRun) Object.assign(task, { status: 'blocked', detail: !ready.length ? 'Connect Claude Code or Codex first.' : 'At least one agent needs a working provider before the team can build. Set up the team first.', action: !ready.length ? { kind: 'accounts', label: 'Open AI accounts' } : steps[2].action });
  else Object.assign(task, { status: 'todo', detail: 'Tell the Manager what to build. It makes a plan, and nothing starts until you click Start.', action: { kind: 'compose', label: 'Describe your first task' }, alt: { kind: 'starter', label: 'Use a starter request' } });
  steps.push(task);

  // The next action: the first step that is not done, in order (the team step only when the task
  // needs it, since chatting with the Manager works without a team).
  const next = steps.find((s) => s.status !== 'done' && !(s.optional && canRun)) || null;
  return { steps, next: next?.id ?? null, complete: steps.every((s) => s.status === 'done' || (s.optional && s.status === 'warn' && task.status === 'done')) };
}
