// The window's part of installing an update (see main/update/index.ts, prepareInstall).
// Before an update is installed, the projects are written to storage, and installing is refused
// while a run is active, with a message that says what has to finish or stop first.

import { ALLOWANCES_KEY, PROJECTS_KEY } from './storage-keys.mjs';

export { ALLOWANCES_KEY, PROJECTS_KEY };

export function prepareForUpdate({ projects, allowances, runs, storage }) {
  let saved = true;
  try {
    storage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    storage.setItem(ALLOWANCES_KEY, JSON.stringify(allowances));
  } catch {
    saved = false;
  }
  const active = runs.find((run) => run && ['running', 'waiting'].includes(run.phase));
  if (!active) return { saved, blocked: null };
  const name = projects.find((project) => project.id === active.projectId)?.name || 'a project';
  const state = active.phase === 'waiting' ? 'waiting for your decision' : 'running';
  return {
    saved,
    blocked: `A simulated run in “${name}” is still ${state}. Stop it or let it finish, then choose Restart now again.`,
  };
}
