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
    expect(parseQuestion('Just an answer.')).toEqual({ body: 'Just an answer.', question: null });
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
