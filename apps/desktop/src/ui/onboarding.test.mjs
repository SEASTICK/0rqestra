import { describe, expect, it } from 'vitest';
import { agentProblems, checklist, dismissed, firstRunState, NEW_PROJECT_ONBOARDING, reopened, showsChecklist, starterRequest, withWorkspace } from './onboarding.mjs';

// "Get started": every step is read from the app's real state.
const codex = { provider: 'codex', name: 'Codex', installed: true, signedIn: true, subscription: true, models: [{ id: 'gpt-x' }] };
const codexOut = { ...codex, signedIn: false, subscription: false };
const manager = { id: 'm', name: 'Manager', role: 'Manager', agent: null };
const bea = { id: 'b', name: 'Bea', role: 'Builder', agent: { tool: 'codex', model: 'gpt-x' } };
const vera = { id: 'v', name: 'Vera', role: 'Code Reviewer', agent: { tool: 'codex', model: 'gpt-x' } };
const project = (over = {}) => ({ id: 'p', name: 'Shop', onboarding: { ...NEW_PROJECT_ONBOARDING }, messages: [], graph: { nodes: [manager] }, ...over });
const access = (folders = []) => ({ folders, workspace: 'C:\\data\\projects\\p\\workspace' });
const run = (id, status, tasks) => ({ kind: 'team', id: `m-${id}`, run: { id, goal: `Goal ${id}`, status, tasks } });
const state = (p, providers, acc = access(), runChanges = {}) => checklist({ project: p, graph: p.graph, providers, access: acc, runChanges });
const byId = (c) => Object.fromEntries(c.steps.map((s) => [s.id, s]));

describe('Get started checklist', () => {
  it('shows only for new projects until dismissed, never for Ask anything', () => {
    expect(showsChecklist(project())).toBe(true);
    expect(showsChecklist(project(), true)).toBe(false);
    expect(showsChecklist({ id: 'old', messages: [] })).toBe(false);
    expect(showsChecklist(dismissed(project()))).toBe(false);
    expect(showsChecklist(reopened(dismissed(project())))).toBe(true);
    expect(showsChecklist(reopened({ id: 'old' }))).toBe(true);
  });

  it('starts at the folder, then the provider, then the team, then the task', () => {
    let p = project();
    let c = state(p, [codexOut]);
    expect(c.next).toBe('folder');
    expect(byId(c).provider).toMatchObject({ status: 'todo', action: { kind: 'accounts', provider: 'codex' } });
    expect(byId(c).task.status).toBe('blocked');
    c = state(p, [codexOut], access([{ id: 'f', path: 'C:\\code\\shop', available: true, write: true }]));
    expect(byId(c).folder).toMatchObject({ status: 'done', detail: 'C:\\code\\shop' });
    expect(c.next).toBe('provider');
    p = withWorkspace(p);
    c = state(p, [codex]);
    expect(byId(c).folder.detail).toContain('workspace');
    expect(byId(c).team).toMatchObject({ status: 'todo', optional: true, action: { kind: 'create-team' } });
    expect(c.next).toBe('team');
    p = { ...p, graph: { nodes: [manager, bea, vera] } };
    c = state(p, [codex]);
    expect(byId(c).team.status).toBe('done');
    expect(byId(c).task).toMatchObject({ status: 'todo', action: { kind: 'compose' }, alt: { kind: 'starter' } });
    expect(c.next).toBe('task');
    expect(starterRequest(p)).toContain('"Shop"');
  });

  it('names the agent that still needs a provider or a model, and blocks the task until one works', () => {
    const p = withWorkspace(project({ graph: { nodes: [manager, { id: 'x', name: 'Xan', role: 'Builder', agent: null }, { ...vera, agent: { tool: 'codex', model: 'old-model' } }] } }));
    expect(agentProblems(p.graph, [codex]).map((a) => a.name)).toEqual(['Xan', 'Vera']);
    const c = state(p, [codex]);
    expect(byId(c).team).toMatchObject({ status: 'todo', action: { kind: 'setup-team' } });
    expect(byId(c).team.detail).toMatch(/Xan \(Builder\) needs a provider.*Vera.*old-model/);
    expect(byId(c).task.status).toBe('blocked');
    // A signed-out provider makes every agent on it a problem, and the step points to AI accounts.
    const out = state(withWorkspace(project({ graph: { nodes: [manager, bea] } })), [codexOut]);
    expect(byId(out).team.detail).toMatch(/not signed in/);
    expect(out.next).toBe('provider');
  });

  it('completes the task only after a run that finished with every task reviewed', () => {
    const base = withWorkspace(project({ graph: { nodes: [manager, bea, vera] } }));
    const at = (messages, rc, acc = access()) => byId(state({ ...base, messages }, [codex], acc, rc)).task;
    const withFolder = access([{ id: 'f', path: 'C:\\code\\shop', available: true, write: true }]);
    expect(at([{ kind: 'assistant', id: 'a1', status: 'done', text: 'Plan\n<orqestra-plan>{"goal":"g","tasks":[{"id":"t1","title":"T","role":"Builder","goal":"x","dependsOn":[],"deliverables":["a.html"]}]}</orqestra-plan>' }])).toMatchObject({ status: 'active', action: { kind: 'scroll', messageId: 'a1' } });
    expect(at([run('r1', 'running', [{ status: 'working' }])]).status).toBe('active');
    expect(at([run('r1', 'failed', [{ status: 'failed' }])])).toMatchObject({ status: 'warn', action: { kind: 'scroll-run', runId: 'r1' } });
    expect(at([run('r1', 'done', [{ status: 'unverified' }])])).toMatchObject({ status: 'warn', action: { kind: 'tree' } });
    expect(at([run('r1', 'failed', [{ status: 'failed' }]), run('r2', 'done', [{ status: 'done' }])], { r2: { pending: 2, current: 2 } }, withFolder)).toMatchObject({ status: 'done', action: { kind: 'review', runId: 'r2' } });
    // In 0rqestra's workspace the files already are where they belong: nothing to apply.
    expect(at([run('r2', 'done', [{ status: 'done' }])], { r2: { pending: 2, current: 2 } })).toMatchObject({ status: 'done', action: null, detail: expect.stringContaining('project workspace') });
    const done = state({ ...base, messages: [run('r2', 'done', [{ status: 'done' }])] }, [codex]);
    expect(done.complete).toBe(true);
    expect(done.next).toBeNull();
    expect(firstRunState([], {})).toEqual({ state: 'none' });
  });
});
