import { describe, expect, it } from 'vitest';
import { applyChatEvent, NO_TOOL, effectiveTarget, historyFor, newAssistant, readTarget, readyProviders, saveTarget, settleInterrupted, TARGET_KEY, usageLine } from './live-chat.mjs';

const memory = (entries = {}) => ({ data: new Map(Object.entries(entries)), getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }, setItem(k, v) { this.data.set(k, v); } });
const claude = { provider: 'claude', name: 'Claude Code', installed: true, subscription: true, models: [{ id: 'default', label: 'Default', efforts: [], isDefault: true }, { id: 'opus', label: 'Opus', efforts: [], isDefault: false }] };
const codex = { provider: 'codex', name: 'Codex', installed: true, subscription: true, models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['low', 'high'], isDefault: true }, { id: 'gpt-6-luna', label: 'Luna', efforts: ['low'], isDefault: false }] };

describe('chat target', () => {
  it('only offers tools that are installed and signed in with a subscription', () => {
    expect(readyProviders([claude, { ...codex, subscription: false }, null])).toEqual([claude]);
    expect(readyProviders(undefined)).toEqual([]);
  });

  it('has no tool (never a simulated answer) when the chosen tool is not ready, or was the old Demo', () => {
    expect(effectiveTarget({ provider: 'codex', model: 'gpt-6.1-sol' }, [claude])).toBe(NO_TOOL);
    expect(effectiveTarget({ provider: 'demo' }, [claude])).toBe(NO_TOOL);
  });

  it('keeps a model and effort that exist, and replaces ones that do not', () => {
    expect(effectiveTarget({ provider: 'codex', model: 'gpt-6-luna', effort: 'low' }, [codex])).toMatchObject({ model: 'gpt-6-luna', effort: 'low', name: 'Codex' });
    expect(effectiveTarget({ provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, [codex])).toMatchObject({ model: 'gpt-6-luna', effort: null });
    expect(effectiveTarget({ provider: 'codex', model: 'gone', effort: 'high' }, [codex])).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
    expect(effectiveTarget({ provider: 'claude', model: 'opus' }, [claude])).toMatchObject({ model: 'opus', modelLabel: 'Opus' });
  });

  it('remembers the choice and survives bad storage', () => {
    const storage = memory();
    saveTarget(storage, { provider: 'codex', model: 'gpt-6-luna', effort: 'low', name: 'x' });
    expect(readTarget(storage)).toEqual({ provider: 'codex', model: 'gpt-6-luna', effort: 'low' });
    expect(readTarget(memory({ [TARGET_KEY]: '{"provider":"bash"}' }))).toEqual({ provider: 'none', model: null, effort: null });
    expect(readTarget(memory({ [TARGET_KEY]: '{"provider":"demo"}' })).provider).toBe('none');
    expect(readTarget(memory({ [TARGET_KEY]: 'not json' })).provider).toBe('none');
  });
});

describe('chat messages', () => {
  it('sends the user turns and finished real replies, not old preview replies', () => {
    const messages = [
      { kind: 'user', text: 'q1' }, { kind: 'manager', text: 'demo reply' },
      { kind: 'assistant', status: 'done', text: 'a1' }, { kind: 'assistant', status: 'failed', text: 'partial' }, { kind: 'user', text: 'q2' },
    ];
    expect(historyFor(messages)).toEqual([{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }, { role: 'user', text: 'q2' }]);
    expect(historyFor(Array(50).fill({ kind: 'user', text: 'x' })).length).toBe(40);
  });

  it('builds the reply from streamed events', () => {
    let m = newAssistant('m1', { provider: 'codex', name: 'Codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(m).toMatchObject({ kind: 'assistant', status: 'streaming', text: '', providerName: 'Codex' });
    m = applyChatEvent(m, { type: 'started', model: 'gpt-6.1-sol-2026' });
    m = applyChatEvent(m, { type: 'delta', text: 'Hel' });
    m = applyChatEvent(m, { type: 'delta', text: 'lo' });
    expect(m.text).toBe('Hello');
    const done = applyChatEvent(m, { type: 'completed', text: 'Hello', usage: { inputTokens: 10, outputTokens: 2 }, limits: [{ label: '5-hour limit', usedPercent: 18.6 }] });
    expect(done).toMatchObject({ status: 'done', model: 'gpt-6.1-sol-2026' });
    expect(usageLine(done)).toBe('10 in · 2 out tokens · 5-hour limit 19% used');
    expect(applyChatEvent(m, { type: 'cancelled', text: '' })).toMatchObject({ status: 'stopped', text: 'Hello' });
    expect(applyChatEvent(m, { type: 'failed', reason: 'usage_limit', message: 'limit', text: '' })).toMatchObject({ status: 'failed', reason: 'usage_limit', error: 'limit' });
    expect(applyChatEvent(m, { type: 'unknown' })).toBe(m);
  });

  it('marks a reply that was interrupted by closing the app as stopped', () => {
    expect(settleInterrupted([{ kind: 'assistant', status: 'streaming' }, { kind: 'user' }])).toEqual([{ kind: 'assistant', status: 'stopped' }, { kind: 'user' }]);
  });
});

import { agentBadge, agentTarget, isRealAgent, isTerminal, nodeFieldsFor, testState } from './live-chat.mjs';

describe('agents in the tree', () => {
  const real = { provider: 'Codex', model: 'GPT-6.1 Sol', agent: { tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' } };

  it('tells agents with a tool from agents without one', () => {
    expect(isRealAgent(real)).toBe(true);
    expect(isRealAgent({ provider: 'OpenAI', model: 'Codex (demo)' })).toBe(false);
    expect(isRealAgent({ agent: { tool: 'bash' } })).toBe(false);
    expect(isRealAgent(null)).toBe(false);
    expect(agentTarget(real)).toEqual({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(agentTarget({})).toBeNull();
  });

  it('builds the node fields for a chosen tool, model and effort', () => {
    expect(nodeFieldsFor({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, codex)).toEqual({
      agent: { tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, provider: 'Codex', model: 'GPT-6.1 Sol',
    });
    expect(nodeFieldsFor({ provider: 'claude', model: 'default', effort: null }, claude)).toMatchObject({ model: 'Default', agent: { tool: 'claude', effort: null } });
    expect(nodeFieldsFor({ provider: 'none' }, null)).toEqual({ agent: null, provider: undefined, model: undefined });
    expect(nodeFieldsFor({ provider: 'codex', model: 'x' }, undefined)).toEqual({ agent: null });
  });

  it('shows what a real agent runs on', () => {
    expect(agentBadge(real)).toBe('Codex · GPT-6.1 Sol · high');
    expect(agentBadge({ provider: 'OpenAI' })).toBeNull();
  });

  it('follows a test run from streamed events', () => {
    let s = { status: 'running', text: '', model: null };
    s = testState(s, { type: 'started', model: 'gpt-6.1-sol' });
    s = testState(s, { type: 'delta', text: 'I am ' });
    s = testState(s, { type: 'delta', text: 'a model.' });
    expect(s).toMatchObject({ status: 'running', text: 'I am a model.', model: 'gpt-6.1-sol' });
    s = testState(s, { type: 'completed', text: 'I am a model.', usage: { inputTokens: 9, outputTokens: 4 }, limits: [] });
    expect(s).toMatchObject({ status: 'done', usage: { inputTokens: 9, outputTokens: 4 } });
    expect(testState({ status: 'running', text: '', model: null }, { type: 'failed', reason: 'usage_limit', message: 'limit', text: '' })).toMatchObject({ status: 'failed', reason: 'usage_limit', error: 'limit' });
    expect(isTerminal({ type: 'delta' })).toBe(false);
    expect(isTerminal({ type: 'cancelled' })).toBe(true);
    expect(isTerminal(undefined)).toBe(false);
  });
});

import { answerFor, parseQuestion, visibleText } from './live-chat.mjs';

describe('questions from the Manager', () => {
  const block = (json) => `Kul! Ett val först.\n<orqestra-question>\n${json}\n</orqestra-question>\n`;
  const good = JSON.stringify({ question: 'Vad ska appen främst hjälpa dig med?', options: [
    { label: 'Logga gympass', description: 'Övningar, set, reps och vikt.' }, { label: 'Träningsprogram', description: 'Färdiga scheman.' }, { label: 'Löpning' },
  ], recommended: 0 });

  it('reads a question at the end of a reply and keeps the text before it', () => {
    const { body, question } = parseQuestion(block(good));
    expect(body).toBe('Kul! Ett val först.');
    expect(question).toEqual({ question: 'Vad ska appen främst hjälpa dig med?', recommended: 0, options: [
      { label: 'Logga gympass', description: 'Övningar, set, reps och vikt.' }, { label: 'Träningsprogram', description: 'Färdiga scheman.' }, { label: 'Löpning', description: null },
    ] });
  });

  it('shows the reply as plain text when the question is malformed', () => {
    for (const bad of ['not json', '{"question":"x","options":[{"label":"only one"}]}', '{"question":"","options":[{"label":"a"},{"label":"b"}]}',
      '{"question":"x","options":[{"label":"a"},{}]}', JSON.stringify({ question: 'x', options: Array(7).fill({ label: 'a' }) })]) {
      expect(parseQuestion(block(bad)).question, bad).toBeNull();
    }
    expect(parseQuestion('Just an answer.')).toEqual({ body: 'Just an answer.', question: null, questions: [] });
    expect(parseQuestion(`${block(good)} and more text after`).question).toBeNull();
  });

  it('drops a recommendation that does not point at an option', () => {
    expect(parseQuestion(block(JSON.stringify({ question: 'q', options: [{ label: 'a' }, { label: 'b' }], recommended: 5 }))).question.recommended).toBeNull();
  });

  it('hides the question markup while the reply is being written', () => {
    expect(visibleText('Kul! <orqestra-question>{"quest')).toBe('Kul!');
    expect(visibleText('Kul! <orqes')).toBe('Kul! ');
    expect(visibleText('a < b')).toBe('a < b');
  });

  it('turns the choice into the next message', () => {
    const { question } = parseQuestion(block(good));
    expect(answerFor(question, { kind: 'option', index: 0 })).toBe('Logga gympass (Övningar, set, reps och vikt.)');
    expect(answerFor(question, { kind: 'option', index: 2 })).toBe('Löpning');
    expect(answerFor(question, { kind: 'own', text: '  Yoga  ' })).toBe('Yoga');
    expect(answerFor(question, { kind: 'skip' })).toMatch(/Decide yourself/);
  });
});

import { applyTeamEvent, newTeamRun, nodeStates, parsePlan, planAssignments, settleTeamRun, teamAgents, teamMembers } from './live-chat.mjs';

describe('plans and team runs', () => {
  const planJson = { goal: 'A workout log', tasks: [
    { id: 't1', title: 'Page', role: 'Builder', goal: 'Write it', dependsOn: [], deliverables: ['index.html'] },
    { id: 't2', title: 'Style', role: 'Builder', goal: 'Style it', dependsOn: ['t1'], deliverables: ['style.css'] },
  ] };
  const reply = `Here is the plan.\n<orqestra-plan>\n${JSON.stringify(planJson)}\n</orqestra-plan>`;
  const graph = { nodes: [
    { id: 'm', name: 'Manager', role: 'Manager', agent: { tool: 'claude', model: 'opus' } },
    { id: 'b2', name: 'Backup builder', role: 'Builder', priority: 2, provider: 'Claude Code', model: 'Opus', agent: { tool: 'claude', model: 'opus', effort: null } },
    { id: 'b1', name: 'Code builder', role: 'Builder', priority: 1, provider: 'Codex', model: 'Sol', agent: { tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' } },
    { id: 'r1', name: 'Reviewer', role: 'Code Reviewer', priority: 1, provider: 'Google', model: 'Gemini (demo)' },
  ] };

  it('reads a plan and hides its markup while it is written', () => {
    const { body, plan } = parsePlan(reply);
    expect(body).toBe('Here is the plan.');
    expect(plan.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(parsePlan('<orqestra-plan>{"goal":"x","tasks":[]}</orqestra-plan>').plan).toBeNull();
    expect(parsePlan('<orqestra-plan>nope</orqestra-plan>').plan).toBeNull();
    expect(visibleText('Plan coming <orqestra-plan>{"goal"')).toBe('Plan coming');
  });

  it('lists the team for the Manager and the working agents for a run', () => {
    expect(teamMembers(graph)).toEqual([{ name: 'Backup builder', role: 'Builder', ready: true }, { name: 'Code builder', role: 'Builder', ready: true }, { name: 'Reviewer', role: 'Code Reviewer', ready: false }]);
    expect(teamAgents(graph).map((a) => [a.id, a.tool, a.model])).toEqual([['b2', 'claude', 'opus'], ['b1', 'codex', 'gpt-6.1-sol']]);
    expect(planAssignments(parsePlan(reply).plan, graph).map((t) => t.agent?.id)).toEqual(['b1', 'b1']);
  });

  it('follows a run and shows it in the tree', () => {
    let run = newTeamRun('run-1', parsePlan(reply).plan);
    run = applyTeamEvent(run, { type: 'run-started', tasks: [{ id: 't1', agentId: 'b1', agentName: 'Code builder' }, { id: 't2', agentId: 'b1', agentName: 'Code builder' }] });
    run = applyTeamEvent(run, { type: 'task', taskId: 't1', status: 'working', agentId: 'b1', attempt: 1 });
    expect(nodeStates(run)).toEqual({ b1: 'working' });
    run = applyTeamEvent(run, { type: 'files', taskId: 't1', files: [{ path: 'index.html', bytes: 10 }] });
    run = applyTeamEvent(run, { type: 'task', taskId: 't1', status: 'reviewing', agentId: 'r9', attempt: 1 });
    run = applyTeamEvent(run, { type: 'review', taskId: 't1', reviewerId: 'r9', approved: true, problems: [] });
    expect(nodeStates(run)).toEqual({ r9: 'reviewing', b1: 'queued' });
    run = applyTeamEvent(run, { type: 'task', taskId: 't1', status: 'done', agentId: 'b1', attempt: 1, note: 'Approved' });
    run = applyTeamEvent(run, { type: 'run-finished', status: 'done', summary: '2 of 2', files: [{ path: 'index.html', bytes: 10 }], calls: 4, usage: { inputTokens: 1, outputTokens: 2 } });
    expect(run).toMatchObject({ status: 'done', calls: 4, tasks: [{ status: 'done', review: { approved: true }, files: [{ path: 'index.html' }] }, { status: 'waiting' }] });
    expect(settleTeamRun(run)).toBe(run);
    expect(settleTeamRun({ ...run, status: 'running' })).toMatchObject({ status: 'stopped', tasks: [{ status: 'done' }, { status: 'stopped' }] });
  });
});

import { autoTeam, teamNeedsSetup } from './live-chat.mjs';

describe('setting up the team', () => {
  const demoGraph = { nodes: [
    { id: 'm', name: 'Project manager', role: 'Manager', provider: 'OpenAI', model: 'Codex (demo)' },
    { id: 'p', name: 'The architect', role: 'Planner', provider: 'Anthropic', model: 'Claude (demo)' },
    { id: 'b', name: 'Code builder', role: 'Builder', provider: 'OpenAI', model: 'Codex (demo)' },
    { id: 'r', name: 'A fresh pair of eyes', role: 'Code Reviewer', provider: 'Google', model: 'Gemini (demo)' },
  ], edges: [] };

  it('puts builders on one tool and reviewers on the other, and the Manager on Claude Code', () => {
    const { graph, changed } = autoTeam(demoGraph, [claude, codex]);
    const tool = (id) => graph.nodes.find((n) => n.id === id).agent.tool;
    expect([tool('m'), tool('p'), tool('b'), tool('r')]).toEqual(['claude', 'codex', 'codex', 'claude']);
    expect(graph.nodes.find((n) => n.id === 'b')).toMatchObject({ provider: 'Codex', model: 'GPT-6.1 Sol', agent: { model: 'gpt-6.1-sol', effort: null } });
    expect(changed.map((c) => c.id)).toEqual(['m', 'p', 'b', 'r']);
  });

  it('uses the one tool for everyone when only one is connected', () => {
    const { graph } = autoTeam(demoGraph, [codex]);
    expect(graph.nodes.every((n) => n.agent.tool === 'codex')).toBe(true);
  });

  it('keeps agents the user already set, and does nothing without a connected tool', () => {
    const custom = { ...demoGraph, nodes: demoGraph.nodes.map((n) => (n.id === 'b' ? { ...n, provider: 'Claude Code', model: 'Opus', agent: { tool: 'claude', model: 'opus', effort: null } } : n)) };
    const { graph, changed } = autoTeam(custom, [claude, codex]);
    expect(graph.nodes.find((n) => n.id === 'b').agent).toEqual({ tool: 'claude', model: 'opus', effort: null });
    expect(changed.map((c) => c.id)).not.toContain('b');
    expect(autoTeam(demoGraph, [])).toEqual({ graph: demoGraph, changed: [] });
  });

  it('asks for setup only when tools are connected and no agent can work', () => {
    expect(teamNeedsSetup(demoGraph, [codex])).toBe(true);
    expect(teamNeedsSetup(demoGraph, [])).toBe(false);
    expect(teamNeedsSetup(autoTeam(demoGraph, [codex]).graph, [codex])).toBe(false);
  });
});

import { parsePlanRequest, plannerOf, replanMessage } from './live-chat.mjs';

describe('the Planner and re-planning', () => {
  it('reads the brief for the Planner and hides it while it is written', () => {
    expect(parsePlanRequest('Jag ber planeraren.\n<orqestra-plan-request>\n{"brief": "En träningslogg"}\n</orqestra-plan-request>')).toEqual({ body: 'Jag ber planeraren.', brief: 'En träningslogg' });
    expect(parsePlanRequest('<orqestra-plan-request>{"brief": ""}</orqestra-plan-request>').brief).toBeNull();
    expect(parsePlanRequest('<orqestra-plan-request>nope</orqestra-plan-request>').brief).toBeNull();
    expect(visibleText('Jag ber planeraren. <orqestra-plan-req')).toBe('Jag ber planeraren. ');
    expect(visibleText('Jag ber planeraren. <orqestra-plan-request>{"br')).toBe('Jag ber planeraren.');
  });

  it('picks the highest priority working Planner', () => {
    const graph = { nodes: [
      { id: 'p2', name: 'Second', role: 'Planner', priority: 2, agent: { tool: 'codex', model: 'x' } },
      { id: 'p1', name: 'First', role: 'Planner', priority: 1, agent: { tool: 'claude', model: 'opus' } },
      { id: 'p0', name: 'Demo', role: 'Planner', priority: 0 },
    ] };
    expect(plannerOf(graph).id).toBe('p1');
    expect(plannerOf({ nodes: [{ id: 'p0', role: 'Planner', priority: 1 }] })).toBeNull();
  });

  it('describes a failed run so the Manager can plan what is left', () => {
    const text = replanMessage({ goal: 'Log', summary: '1 of 2 tasks finished.', files: [{ path: 'index.html' }], tasks: [
      { title: 'Page', role: 'Builder', status: 'done', note: 'Approved', files: [{ path: 'index.html' }] },
      { title: 'Script', role: 'Builder', status: 'failed', note: 'Not approved', review: { approved: false, problems: ['Saving does not work'] }, files: [] },
    ] });
    expect(text).toContain('did not finish. 1 of 2 tasks finished.');
    expect(text).toContain('- Script (Builder): failed — Not approved; review: Saving does not work');
    expect(text).toContain('Files already in the project folder: index.html.');
  });
});

import { placeProducts, previewUrl, productLinks } from './live-chat.mjs';

describe('products in the tree', () => {
  const graph = { nodes: [{ id: 'm', x: 300, y: 0 }, { id: 'b', x: 100, y: 230 }, { id: 'r', x: 500, y: 230 }, { id: 'p', x: 300, y: 230 }] };
  const run = (status, tasks) => ({ kind: 'team', run: { status, tasks } });
  const web = { id: 'web', folder: 'web', entry: 'web/index.html', name: 'Web', files: ['web/index.html', 'web/app.js'] };
  const root = { id: 'root', folder: '', entry: 'index.html', name: 'Site', files: ['index.html'] };

  it('links a product to the agents that wrote or reviewed its files', () => {
    const messages = [
      run('done', [{ deliverables: ['web/index.html'], agentId: 'b', review: { reviewerId: 'r' }, status: 'done' }, { deliverables: ['notes.md'], agentId: 'p', status: 'done' }]),
      run('running', [{ deliverables: ['web/new.css'], plannedAgentId: 'p', status: 'working' }]),
      { kind: 'user', text: 'hi' },
    ];
    expect(productLinks(web, messages, graph)).toEqual({ agents: ['b', 'r', 'p'], building: true });
    expect(productLinks(root, messages, graph)).toEqual({ agents: [], building: false });
  });

  it('ignores agents that are no longer in the tree and finished runs', () => {
    expect(productLinks(web, [run('running', [{ deliverables: ['web/app.js'], agentId: 'gone', status: 'done' }])], graph)).toEqual({ agents: [], building: false });
  });

  it('places a product under its agents, and never on top of another node', () => {
    const messages = [run('done', [{ deliverables: ['web/index.html'], agentId: 'b', status: 'done' }])];
    const [a, b] = placeProducts([web, { ...web, id: 'web2' }], messages, graph);
    expect(a).toMatchObject({ id: 'web', x: 100, y: 445, agents: ['b'], building: false });
    expect(b.y).toBe(445);
    expect(b.x).toBeGreaterThanOrEqual(100 + 224);
    const [alone] = placeProducts([root], [], graph);
    expect(alone.y).toBe(445);
    expect(placeProducts([], [], graph)).toEqual([]);
  });

  it('places a product under the lowest of its agents', () => {
    const tree = { nodes: [{ id: 'm', x: 300, y: 0 }, { id: 'b', x: 100, y: 230 }, { id: 'r', x: 300, y: 460 }] };
    const messages = [run('done', [{ deliverables: ['web/index.html'], agentId: 'b', review: { reviewerId: 'r' }, status: 'done' }])];
    expect(placeProducts([web], messages, tree)[0]).toMatchObject({ x: 300, y: 460 + 159 + 56 });
  });

  it('builds the preview address with the entry page and a version', () => {
    expect(previewUrl('pabc', web, 3)).toBe('orqestra-preview://pabc/web/index.html?v=3');
    expect(previewUrl('pabc', { ...root, entry: 'my page.html' })).toBe('orqestra-preview://pabc/my%20page.html?v=0');
    expect(previewUrl(null, web)).toBeNull();
  });
});

import { addProblem, fixMessage, MAX_PROBLEMS, problemLine, problemsFor, readProblem } from './live-chat.mjs';

describe('preview problems', () => {
  const web = { id: 'web', folder: 'web', entry: 'web/index.html', name: 'Web', files: ['web/index.html', 'web/app.js'] };
  const root = { id: 'root', folder: '', entry: 'index.html', name: 'Site', files: ['index.html'] };
  const err = readProblem({ projectId: 'p1', kind: 'error', message: 'Uncaught ReferenceError: x is not defined', page: 'web/index.html', source: 'web/app.js', line: 4 });

  it('reads only well-formed problems', () => {
    expect(err).toEqual({ kind: 'error', message: 'Uncaught ReferenceError: x is not defined', page: 'web/index.html', source: 'web/app.js', line: 4 });
    expect(readProblem({ kind: 'evil', message: 'x' })).toBeNull();
    expect(readProblem({ kind: 'error', message: '  ' })).toBeNull();
    expect(readProblem(null)).toBeNull();
    expect(readProblem({ kind: 'missing', message: 'm', line: -2, page: 5 })).toEqual({ kind: 'missing', message: 'm', page: null, source: null, line: null });
  });

  it('keeps each problem once and only the latest ones', () => {
    let list = addProblem([], err);
    expect(addProblem(list, { ...err })).toBe(list);
    for (let i = 0; i < 30; i++) list = addProblem(list, { ...err, message: `m${i}` });
    expect(list).toHaveLength(MAX_PROBLEMS);
    expect(list.at(-1).message).toBe('m29');
    expect(addProblem(list, null)).toBe(list);
  });

  it('finds the problems of a product by its page or file', () => {
    const missing = { kind: 'missing', message: 'gone', page: null, source: 'web/style.css', line: null };
    const other = { ...err, page: 'landing/index.html', source: 'landing/a.js' };
    expect(problemsFor(web, [err, missing, other])).toEqual([err, missing]);
    expect(problemsFor(root, [err, other])).toHaveLength(2);
    expect(problemsFor(null, [err])).toEqual([]);
  });

  it('writes a fix request for the Manager', () => {
    expect(problemLine(err)).toBe('Script error: Uncaught ReferenceError: x is not defined (web/app.js, line 4)');
    const text = fixMessage(web, [err]);
    expect(text).toContain('The preview of "Web" (web/index.html) shows this problem:');
    expect(text).toContain('- Script error: Uncaught ReferenceError');
    expect(text).toContain('Files of this product: web/index.html, web/app.js.');
  });

  it('places a product where the user moved it', () => {
    const [p] = placeProducts([web], [], { nodes: [{ id: 'm', x: 0, y: 0 }] }, { web: { x: 900, y: 40 } });
    expect(p).toMatchObject({ x: 900, y: 40 });
  });
});

import { mergeProducts, planProducts } from './live-chat.mjs';

describe('products named in the plan', () => {
  const planText = (extra) => `Plan.\n<orqestra-plan>\n${JSON.stringify({ goal: 'Log', tasks: [{ id: 't1', title: 'Page', role: 'Builder', goal: 'Write it', deliverables: ['web/index.html'], product: 'Log' }], ...extra })}\n</orqestra-plan>`;

  it('reads products and the product of each task', () => {
    const { plan } = parsePlan(planText({ products: [{ id: 'Log', name: 'Workout log', folder: 'web/' }, { id: 'bad id', name: 'x' }, { id: 'n', name: '' }] }));
    expect(plan.products).toEqual([{ id: 'log', name: 'Workout log', folder: 'web' }]);
    expect(plan.tasks[0].product).toBe('log');
    expect(parsePlan(planText({})).plan.products).toEqual([]);
    expect(planProducts('x')).toEqual([]);
  });

  it('keeps them on the run', () => {
    const { plan } = parsePlan(planText({ products: [{ id: 'log', name: 'Workout log', folder: 'web' }] }));
    const run = newTeamRun('r1', plan);
    expect(run.products).toEqual([{ id: 'log', name: 'Workout log', folder: 'web' }]);
    expect(run.tasks[0].product).toBe('log');
  });

  const graph = { nodes: [{ id: 'm', x: 300, y: 0 }, { id: 'b', x: 100, y: 230 }] };
  const team = (status, products, tasks) => ({ kind: 'team', run: { status, products, tasks } });

  it('shows a planned product before it has files, linked to the agent building it', () => {
    const messages = [team('running', [{ id: 'log', name: 'Workout log', folder: 'web' }], [{ deliverables: ['web/index.html'], product: 'log', plannedAgentId: 'b', status: 'working' }])];
    const [p] = mergeProducts([], messages);
    expect(p).toMatchObject({ id: 'web', folder: 'web', entry: 'web/index.html', name: 'Workout log', files: [], planned: true, plannedIds: ['log'] });
    expect(productLinks(p, messages, graph)).toEqual({ agents: ['b'], building: true });
  });

  it('gives a found product the name from the plan, and keeps its id', () => {
    const found = [{ id: 'web', folder: 'web', entry: 'web/index.html', name: 'Page title', files: ['web/index.html'], updatedAt: 5 }];
    const messages = [team('done', [{ id: 'log', name: 'Workout log', folder: 'web' }], [{ deliverables: ['web/x.js'], product: 'log', agentId: 'b', status: 'done' }])];
    const [p, ...rest] = mergeProducts(found, messages);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ id: 'web', name: 'Workout log', files: ['web/index.html'], plannedIds: ['log'] });
    expect(p.planned).toBeUndefined();
  });

  it('forgets planned products of earlier runs that never got files', () => {
    const messages = [team('failed', [{ id: 'old', name: 'Old', folder: 'old' }], []), team('running', [{ id: 'new', name: 'New', folder: 'new' }], [])];
    expect(mergeProducts([], messages).map((p) => p.id)).toEqual(['new']);
    expect(mergeProducts([], [])).toEqual([]);
  });
});

import { answersFor } from './live-chat.mjs';

describe('a form of questions', () => {
  const q = (question, recommended = 0) => ({ question, options: [{ label: 'A', description: 'first' }, { label: 'B' }], recommended });
  const block = (value) => `Några frågor först.\n<orqestra-question>\n${JSON.stringify(value)}\n</orqestra-question>`;

  it('reads up to four questions', () => {
    const { body, question, questions } = parseQuestion(block({ questions: [q('Vem?'), q('Hur?', 1)] }));
    expect(body).toBe('Några frågor först.');
    expect(questions.map((x) => x.question)).toEqual(['Vem?', 'Hur?']);
    expect(question.question).toBe('Vem?');
    expect(questions[1].recommended).toBe(1);
  });

  it('refuses a form with a broken question or too many', () => {
    expect(parseQuestion(block({ questions: [q('Vem?'), { question: 'x', options: [] }] })).question).toBeNull();
    expect(parseQuestion(block({ questions: [q('1'), q('2'), q('3'), q('4'), q('5')] })).question).toBeNull();
    expect(parseQuestion(block({ questions: [] })).question).toBeNull();
  });

  it('still reads one question', () => {
    expect(parseQuestion(block(q('Vem?'))).questions).toHaveLength(1);
  });

  it('writes the answers as one message', () => {
    const questions = [q('Vem?'), q('Hur?')];
    expect(answersFor(questions, [{ kind: 'option', index: 0 }, { kind: 'own', text: 'Snabbt' }])).toBe('1. Vem?\n   A (first)\n2. Hur?\n   Snabbt');
    expect(answersFor(questions, [{ kind: 'skip' }, { kind: 'option', index: 1 }])).toBe('1. Vem?\n   You decide.\n2. Hur?\n   B');
    expect(answersFor(questions, [{ kind: 'skip' }, { kind: 'skip' }])).toMatch(/^I skip these questions/);
    expect(answersFor([questions[0]], [{ kind: 'option', index: 1 }])).toBe('B');
  });
});
