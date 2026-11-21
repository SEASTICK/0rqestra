import { describe, expect, it } from 'vitest';
import { isRunning, renameProject, retireAgents, teamLinkFor, withoutProject } from './project-removal.mjs';

const project = (id, nodes = []) => ({ id, name: id.toUpperCase(), graph: { nodes, edges: [] }, messages: [] });

describe('removing a project from 0rqestra', () => {
  it('drops only the entry, and shows the next project', () => {
    const ps = [project('general'), project('a'), project('b'), project('c')];
    expect(withoutProject(ps, 'b', 'b', 'general')).toEqual({ projects: [ps[0], ps[1], ps[3]], activeId: 'c' });
    expect(withoutProject(ps, 'c', 'c', 'general').activeId).toBe('b');
    expect(withoutProject(ps, 'b', 'a', 'general').activeId).toBe('a');
    expect(withoutProject([ps[0], ps[1]], 'a', 'a', 'general')).toEqual({ projects: [ps[0]], activeId: 'general' });
  });

  it('keeps the agents (with their keys, so their skills) for other projects, not the Manager', () => {
    const p = project('a', [{ id: 'm', role: 'Manager', name: 'Manager', agentKey: 'k-m' }, { id: 'b1', role: 'Builder', name: 'Bob', agentKey: 'k-bob', x: 1, y: 2, agent: { tool: 'codex' } }]);
    const lib = retireAgents([], p);
    expect(lib).toEqual([{ role: 'Builder', name: 'Bob', agentKey: 'k-bob', agent: { tool: 'codex' }, projectName: 'A', retired: true }]);
    expect(retireAgents(lib, p)).toHaveLength(1);
  });

  it('finds a shared link even when the folder moved, and sees running work', () => {
    const view = { status: 'signed_in', teams: [{ id: 't', projects: [{ id: 's', link: { localProjectId: 'a', state: 'missing' } }] }] };
    expect(teamLinkFor(view, 'a')?.project.id).toBe('s');
    expect(teamLinkFor(view, 'b')).toBeNull();
    expect(teamLinkFor({ status: 'signed_out' }, 'a')).toBeNull();
    expect(isRunning({ messages: [{ kind: 'team', run: { status: 'running' } }] })).toBe(true);
    expect(isRunning({ messages: [{ kind: 'team', run: { status: 'done' } }] })).toBe(false);
  });

  it('renames only with a name', () => {
    const ps = [project('a')];
    expect(renameProject(ps, 'a', '  New name ')[0].name).toBe('New name');
    expect(renameProject(ps, 'a', '   ')).toBe(ps);
  });
});
