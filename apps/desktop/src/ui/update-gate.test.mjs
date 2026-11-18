import { describe, expect, it } from 'vitest';
import { prepareForUpdate, PROJECTS_KEY } from './update-gate.mjs';

const memory = () => {
  const data = new Map();
  return { data, setItem: (key, value) => data.set(key, value) };
};
const projects = [{ id: 'p1', name: 'Shop' }, { id: 'p2', name: 'Blog' }];

describe('prepareForUpdate', () => {
  it('saves the projects and allows installing when no team run is working', () => {
    const storage = memory();
    expect(prepareForUpdate({ projects, runs: [null, { status: 'done', projectId: 'p1' }], storage })).toEqual({ saved: true, blocked: null });
    expect(JSON.parse(storage.data.get(PROJECTS_KEY))).toEqual(projects);
  });

  it('refuses while a team run is working, and names the project and what to do', () => {
    const storage = memory();
    const running = prepareForUpdate({ projects, runs: [{ status: 'running', projectId: 'p2' }], storage });
    expect(running.saved).toBe(true); // still saved, so nothing is lost if the user quits instead
    expect(running.blocked).toMatch(/team run in “Blog” is still working\. Stop it or let it finish/);
  });

  it('reports a failed save, which the main process treats as "do not install"', () => {
    const storage = { setItem: () => { throw new Error('quota'); } };
    expect(prepareForUpdate({ projects, runs: [], storage })).toEqual({ saved: false, blocked: null });
  });
});
