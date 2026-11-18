// The window's part of installing an update (see main/update/index.ts, prepareInstall).
// Before an update is installed, the projects are written to storage, and installing is refused
// while a team run is working, with a message that says what has to finish or stop first.

import { PROJECTS_KEY } from './storage-keys.mjs';

export { PROJECTS_KEY };

// `runs`: the team runs shown in the chats, as { projectId, status }.
export function prepareForUpdate({ projects, runs, storage }) {
  let saved = true;
  try {
    storage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  } catch {
    saved = false;
  }
  const active = (runs || []).find((run) => run && run.status === 'running');
  if (!active) return { saved, blocked: null };
  const name = projects.find((project) => project.id === active.projectId)?.name || 'a project';
  return { saved, blocked: `A team run in “${name}” is still working. Stop it or let it finish, then choose Restart now again.` };
}
