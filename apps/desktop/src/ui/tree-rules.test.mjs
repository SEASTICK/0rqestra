import { describe, expect, it } from 'vitest';
import { AGREED_ROLES, byPriority, canConnect, isAgreedRole, nextPriority, priorityConflict } from './tree-rules.mjs';

const graph = {
  nodes: [
    { id: 'm', role: 'Manager', priority: 1 },
    { id: 'b1', role: 'Builder', priority: 1 },
    { id: 'b2', role: 'Builder', priority: 2 },
    { id: 'r', role: 'Code Reviewer', priority: 1 },
    { id: 'd', role: 'Debugger', priority: 1 },
  ],
  edges: [{ from: 'm', to: 'b1' }, { from: 'b1', to: 'r' }],
};

describe('roles', () => {
  it('offers exactly the agreed specialist roles', () => {
    expect(AGREED_ROLES).toEqual(['Planner', 'Builder', 'Code Reviewer', 'Debugger', 'Tester', 'Security Reviewer']);
  });
  it('recognises the Manager and agreed roles, not template-only roles', () => {
    expect(isAgreedRole('Manager')).toBe(true);
    expect(isAgreedRole('Debugger')).toBe(true);
    expect(isAgreedRole('Reviewer')).toBe(false);
    expect(isAgreedRole('Researcher')).toBe(false);
  });
});

describe('connections (D1)', () => {
  it('allows a cycle between specialists', () => {
    expect(canConnect(graph, 'r', 'b1')).toBeNull();
  });
  it('rejects self-edges, edges into the Manager, and duplicates', () => {
    expect(canConnect(graph, 'b1', 'b1')).toMatch(/itself/);
    expect(canConnect(graph, 'r', 'm')).toMatch(/Manager/);
    expect(canConnect(graph, 'm', 'b1')).toMatch(/already connected/);
  });
});

describe('priorities (A7, D7)', () => {
  it('gives a new agent the next free priority in its role', () => {
    expect(nextPriority(graph, 'Builder')).toBe(3);
    expect(nextPriority(graph, 'Tester')).toBe(1);
  });
  it('ignores the agent itself when moving it to another role', () => {
    expect(nextPriority(graph, 'Builder', 'b2')).toBe(2);
  });
  it('detects a duplicate priority within a role only', () => {
    expect(priorityConflict(graph, 'b2', 'Builder', 1)?.id).toBe('b1');
    expect(priorityConflict(graph, 'b2', 'Builder', 2)).toBeNull();
    expect(priorityConflict(graph, 'd', 'Debugger', 1)).toBeNull();
  });
  it('breaks a tie by creation order', () => {
    const tied = { nodes: [{ id: 'x', priority: 1 }, { id: 'y', priority: 1 }, { id: 'z', priority: 0 }], edges: [] };
    expect([tied.nodes[1], tied.nodes[0], tied.nodes[2]].sort(byPriority(tied)).map((n) => n.id)).toEqual(['z', 'x', 'y']);
  });
});
