// Demo mode and the simulated features were removed from 0rqestra. Existing installations can
// still hold what they saved: demo agents with made-up models, demo allowances and recovery
// stacks, simulated tasks and approvals, a saved "Demo" choice for the Manager. This module cleans
// that up once, keeping everything the user made: projects, chat history, and each agent's name,
// role, priority and place in the tree. An agent that ran on Demo keeps its place but has no tool
// until the user chooses Claude Code or Codex for it.

import { TARGET_KEY } from './live-chat.mjs';
import { ALLOWANCES_KEY, LEGACY_ALLOWANCES_KEY } from './storage-keys.mjs';

export const DEMO_REMOVED_KEY = 'orqestra-demo-removed';
const DEMO_NODE_FIELDS = ['backups', 'activeProfileId', 'recoveryPaused'];

const realTool = (node) => Boolean(node && node.agent && (node.agent.tool === 'claude' || node.agent.tool === 'codex' || node.agent.tool === 'gemini'));

export function migrateNode(node) {
  const out = { ...node };
  for (const f of DEMO_NODE_FIELDS) delete out[f];
  if (!realTool(node)) {
    // "provider" and "model" only ever named a demo model on these nodes.
    delete out.provider;
    delete out.model;
    out.agent = null;
  }
  return out;
}

// An agent's permanent key (Capabilities): skills installed on an agent are saved against it, so
// they follow the agent when it is renamed, after a restart, and into other projects. Agents made
// before keys existed get one from their project and node ids, once.
export function withAgentKey(node, projectId) {
  if (!node || node.agentKey) return node;
  return { ...node, agentKey: `${String(projectId).slice(0, 48)}:${String(node.id).slice(0, 48)}`.replace(/[^A-Za-z0-9:_-]/g, '-') };
}

export function migrateProject(project) {
  const { tasks, approvals, liveWorkflow, ...rest } = project;
  void tasks; void approvals; void liveWorkflow;
  return { ...rest, graph: { ...project.graph, nodes: (project.graph?.nodes || []).map((n) => withAgentKey(migrateNode(n), project.id)) } };
}

export function projectHadDemo(project) {
  return Boolean((project.tasks && project.tasks.length) || (project.approvals && project.approvals.length) || project.liveWorkflow
    || (project.graph?.nodes || []).some((n) => !realTool(n) && (n.provider || n.model || n.backups || n.recoveryPaused)));
}

// Clears saved demo settings. Returns true when anything from Demo mode was found (in storage or in
// the projects), so the window can explain once what changed.
export function cleanDemoStorage(storage, projects = []) {
  let found = false;
  try {
    for (const key of [ALLOWANCES_KEY, LEGACY_ALLOWANCES_KEY]) {
      if (storage.getItem(key) !== null) { storage.removeItem(key); found = true; }
    }
    const target = JSON.parse(storage.getItem(TARGET_KEY) || 'null');
    if (target && target.provider === 'demo') { storage.removeItem(TARGET_KEY); found = true; }
  } catch {
    /* storage unavailable: nothing to clean */
  }
  if (projects.some(projectHadDemo)) found = true;
  return found;
}
