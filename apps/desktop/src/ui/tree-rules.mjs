// Tree rules for the Stage 2 interface, kept separate from App.jsx so they can be tested.
// They implement the agreed rules in docs/tree-routing-and-permissions.md:
//   - the specialist roles (product brief §3);
//   - D1: no edge into the Manager, no self-edges, no duplicates; cycles between specialists
//     are allowed (bounded at run time by the agreed limits);
//   - A7 and D7: unique priorities within a role, a "+" agent gets the next free (lowest)
//     priority, and ties are broken by creation order as a safeguard.

export const AGREED_ROLES = ['Planner', 'Builder', 'Code Reviewer', 'Debugger', 'Tester', 'Security Reviewer'];

export const isAgreedRole = (role) => role === 'Manager' || AGREED_ROLES.includes(role);

// Returns a message explaining why the edge is not allowed, or null when it is.
export function canConnect(graph, from, to) {
  if (from === to) return 'An agent cannot connect to itself.';
  if (graph.nodes.find((n) => n.id === to)?.role === 'Manager') {
    return 'The Manager is the root and cannot have an incoming connection.';
  }
  if (graph.edges.some((e) => e.from === from && e.to === to)) return 'These agents are already connected.';
  return null;
}

// The next free (lowest-priority, i.e. highest-number) priority in a role.
export function nextPriority(graph, role, excludeId = null) {
  const used = graph.nodes.filter((n) => n.role === role && n.id !== excludeId).map((n) => Number(n.priority) || 0);
  return 1 + Math.max(0, ...used);
}

// The agent that already holds this priority in this role, or null.
export function priorityConflict(graph, nodeId, role, priority) {
  return graph.nodes.find((n) => n.id !== nodeId && n.role === role && Number(n.priority) === Number(priority)) ?? null;
}

// Orders candidates by priority (lower number first); equal priorities fall back to creation
// order, which is the node's position in graph.nodes.
export function byPriority(graph) {
  const created = new Map(graph.nodes.map((n, index) => [n.id, index]));
  return (a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0) || created.get(a.id) - created.get(b.id);
}
