// Removing a project from 0rqestra (the sidebar's project menu). Only the app's saved entry and its
// links go: the project folder, its Git working tree and any GitHub repository stay as they are.
// Reusable agents stay available: a removed project's agents move to the agent library, so they can
// be added to another project with the skills installed on them (skills are kept by agent key).

export const AGENT_LIBRARY_KEY = 'orqestra-agent-library-v1';
const LIBRARY_LIMIT = 200;

// The shared project this local project is linked to on this computer, whatever the link's state
// (a moved folder still counts, so it can be unlinked or relinked).
export function teamLinkFor(view, localProjectId) {
  if (!view || view.status !== 'signed_in') return null;
  for (const team of view.teams || []) {
    for (const project of team.projects || []) {
      if (project.link?.localProjectId === localProjectId) return { team, project };
    }
  }
  return null;
}

export function isRunning(project) {
  return Boolean(project?.messages?.some((m) => m.kind === 'team' && m.run?.status === 'running'));
}

// Agents worth keeping from a project: everyone except the Manager, by their permanent key.
export function retireAgents(library, project) {
  const list = Array.isArray(library) ? library.filter((a) => a && typeof a.agentKey === 'string') : [];
  const known = new Set(list.map((a) => a.agentKey));
  for (const n of project?.graph?.nodes || []) {
    if (n.role === 'Manager' || !n.agentKey || known.has(n.agentKey)) continue;
    const { id, x, y, parent, ...keep } = n;
    void id; void x; void y; void parent;
    list.push({ ...keep, projectName: project.name, retired: true });
    known.add(n.agentKey);
  }
  return list.slice(-LIBRARY_LIMIT);
}

// The workspace without the project, and which project to show next (the next one in the list,
// else the one before, else "Ask anything").
export function withoutProject(projects, projectId, activeId, fallbackId) {
  const index = projects.findIndex((p) => p.id === projectId);
  if (index < 0) return { projects, activeId };
  const rest = projects.filter((p) => p.id !== projectId);
  if (activeId !== projectId) return { projects: rest, activeId };
  const others = rest.filter((p) => p.id !== fallbackId);
  const next = others[Math.min(index, others.length - 1)] || rest.find((p) => p.id === fallbackId) || rest[0];
  return { projects: rest, activeId: next?.id ?? fallbackId };
}

export function readLibrary(storage) {
  try {
    const v = JSON.parse(storage.getItem(AGENT_LIBRARY_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function renameProject(projects, projectId, name) {
  const clean = String(name || '').trim().slice(0, 50);
  if (!clean) return projects;
  return projects.map((p) => (p.id === projectId ? { ...p, name: clean } : p));
}
