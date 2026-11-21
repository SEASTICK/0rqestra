import { describe, expect, it } from 'vitest';
import { cleanDemoStorage, migrateNode, migrateProject, projectHadDemo } from './migrate-demo.mjs';
import { TARGET_KEY } from './live-chat.mjs';

const storage = (entries) => {
  const data = new Map(Object.entries(entries));
  return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
};
const oldProject = {
  id: 'p1', name: 'Shop', messages: [{ id: 'm1', kind: 'user', text: 'hi' }, { id: 'm2', kind: 'manager', text: 'Your message is saved in this preview.' }],
  tasks: [{ id: 't1' }], approvals: [{ id: 'a1' }], liveWorkflow: true,
  graph: {
    nodes: [
      { id: 'manager', name: 'Project manager', role: 'Manager', provider: 'OpenAI', model: 'Codex (demo)', priority: 1, x: 1, y: 2 },
      { id: 'b', name: 'Code builder', role: 'Builder', provider: 'Claude Code', model: 'Opus', priority: 2, x: 3, y: 4, agent: { tool: 'claude', model: 'opus', effort: null }, backups: [{ id: 'x' }], activeProfileId: 'primary', recoveryPaused: false },
      { id: 'r', name: 'Fresh eyes', role: 'Code Reviewer', provider: 'Google', model: 'Gemini (demo)', priority: 1, x: 5, y: 6, backups: [{ id: 'y', provider: 'xAI', model: 'Grok (demo)' }], recoveryPaused: true },
    ],
    edges: [{ id: 'e1', from: 'manager', to: 'b' }],
  },
};

describe('after Demo mode was removed', () => {
  it('keeps projects, chat history and every agent, without demo models, stacks, tasks or approvals', () => {
    const p = migrateProject(oldProject);
    expect(p).toMatchObject({ id: 'p1', name: 'Shop', messages: oldProject.messages, graph: { edges: oldProject.graph.edges } });
    expect(p).not.toHaveProperty('tasks');
    expect(p).not.toHaveProperty('approvals');
    expect(p).not.toHaveProperty('liveWorkflow');
    expect(p.graph.nodes.map((n) => [n.id, n.name, n.role, n.priority, n.x, n.y])).toEqual(oldProject.graph.nodes.map((n) => [n.id, n.name, n.role, n.priority, n.x, n.y]));
    // A demo agent has no tool now: no made-up model is shown for it.
    expect(p.graph.nodes[0]).toEqual({ id: 'manager', name: 'Project manager', role: 'Manager', priority: 1, x: 1, y: 2, agent: null, agentKey: 'p1:manager' });
    // An agent on a real tool keeps its tool and model; only the demo recovery fields go.
    expect(p.graph.nodes[1]).toEqual({ id: 'b', name: 'Code builder', role: 'Builder', provider: 'Claude Code', model: 'Opus', priority: 2, x: 3, y: 4, agent: { tool: 'claude', model: 'opus', effort: null }, agentKey: 'p1:b' });
    expect(migrateNode(p.graph.nodes[1])).toEqual(p.graph.nodes[1]);
    // Every agent gets a permanent key once (its skills are saved against it); an existing key stays.
    expect(migrateProject({ ...oldProject, graph: { ...oldProject.graph, nodes: [{ ...oldProject.graph.nodes[1], agentKey: 'kept-key' }] } }).graph.nodes[0].agentKey).toBe('kept-key');
  });

  it('clears saved demo settings once and says whether anything from Demo mode was found', () => {
    const s = storage({ 'orqestra-demo-allowances': '{"OpenAI":40}', 'worktreeai-demo-allowances': '{}', [TARGET_KEY]: '{"provider":"demo"}', other: 'kept' });
    expect(cleanDemoStorage(s, [])).toBe(true);
    expect([...s.data.keys()]).toEqual(['other']);
    expect(cleanDemoStorage(s, [])).toBe(false);
    expect(cleanDemoStorage(storage({ [TARGET_KEY]: '{"provider":"claude"}' }), [])).toBe(false);
    expect(cleanDemoStorage(storage({}), [oldProject])).toBe(true);
    expect(projectHadDemo(migrateProject(oldProject))).toBe(false);
  });
});
