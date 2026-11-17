import { describe, expect, it } from 'vitest';
import { ALLOWANCES_KEY, prepareForUpdate, PROJECTS_KEY } from './update-gate.mjs';

const memory = () => {
  const data = new Map();
  return { data, setItem: (key, value) => data.set(key, value) };
};
const projects = [{ id: 'p1', name: 'Shop' }, { id: 'p2', name: 'Blog' }];

describe('prepareForUpdate', () => {
  it('saves projects and allowances and allows installing when nothing is running', () => {
    const storage = memory();
    expect(prepareForUpdate({ projects, allowances: { OpenAI: 50 }, runs: [null, { phase: 'completed', projectId: 'p1' }], storage })).toEqual({ saved: true, blocked: null });
    expect(JSON.parse(storage.data.get(PROJECTS_KEY))).toEqual(projects);
    expect(JSON.parse(storage.data.get(ALLOWANCES_KEY))).toEqual({ OpenAI: 50 });
  });

  it('refuses while a run is running or waiting, and names the project and what to do', () => {
    const storage = memory();
    const running = prepareForUpdate({ projects, allowances: {}, runs: [{ phase: 'running', projectId: 'p2' }], storage });
    expect(running.saved).toBe(true); // still saved, so nothing is lost if the user quits instead
    expect(running.blocked).toMatch(/“Blog” is still running\. Stop it or let it finish/);
    const waiting = prepareForUpdate({ projects, allowances: {}, runs: [null, { phase: 'waiting', projectId: 'p1' }], storage });
    expect(waiting.blocked).toMatch(/“Shop” is still waiting for your decision/);
  });

  it('reports a failed save, which the main process treats as "do not install"', () => {
    const storage = { setItem: () => { throw new Error('quota'); } };
    expect(prepareForUpdate({ projects, allowances: {}, runs: [], storage })).toEqual({ saved: false, blocked: null });
  });
});
