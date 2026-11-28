// Backup agents (agent settings and the run card): which agents can back up this one, what each runs
// on and whether it is ready, warnings about shared provider accounts, and how a switch reads.
// Free of React, so it is unit-tested.

export const TOOL_NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };
const toolName = (tool) => TOOL_NAME[tool] || tool || 'no tool';
const real = (n) => Boolean(n?.agent && TOOL_NAME[n.agent.tool]);

// Other agents in the tree with the same role that run on a tool, with their readiness.
export function backupCandidates(graph, node, statuses = []) {
  const ready = new Set((Array.isArray(statuses) ? statuses : []).filter((s) => s && s.installed && s.subscription).map((s) => s.provider));
  return (graph?.nodes || [])
    .filter((n) => n.id !== node?.id && n.role === node?.role && n.role !== 'Manager' && real(n))
    .map((n) => ({ id: n.id, name: n.name, tool: n.agent.tool, toolName: toolName(n.agent.tool), model: n.agent.model || 'default model', ready: ready.has(n.agent.tool) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The chosen backups, in order, that still exist as candidates.
export function orderedBackups(ids, candidates) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return (ids || []).map((id) => byId.get(id)).filter(Boolean);
}

// One account per tool on this computer: agents on the same tool share its usage limit.
export function accountWarnings(node, chosen) {
  const out = [];
  const primaryTool = node?.agent?.tool;
  for (const b of chosen) if (b.tool === primaryTool) out.push(`${b.name} uses ${toolName(b.tool)} like ${node.name}: they share one account, so ${b.name} will likely hit the same usage limit and is skipped when ${toolName(b.tool)} reports it.`);
  const seen = new Map();
  for (const b of chosen) {
    if (b.tool === primaryTool) continue;
    if (seen.has(b.tool)) out.push(`${seen.get(b.tool)} and ${b.name} both use ${toolName(b.tool)}: they share one account and may hit the same usage limit.`);
    else seen.set(b.tool, b.name);
  }
  return out;
}

export function moveBackup(ids, id, delta) {
  const list = [...(ids || [])];
  const i = list.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}

// A reset time only when the provider reported one (seconds since the epoch).
export function resetText(resetsAt, now = Date.now()) {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const at = new Date(resetsAt * 1000);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Resets ${sameDay ? `at ${time}` : `${at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`}.`;
}

// How a switch reads on the run card.
export function switchText(sw) {
  return `${toolName(sw.fromTool)} reached its usage limit. ${sw.toName} resumed from the last checkpoint.`;
}
