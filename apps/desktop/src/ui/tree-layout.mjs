// Tidies the team tree: the Manager on top, each agent one row below the agent it is connected from,
// rows ordered so that connections cross as little as possible, and everything centred. Agents that no
// connection reaches go in the first row under the Manager. Pure, so it is unit-tested.

export const LAYOUT = { width: 224, height: 159, gapX: 48, gapY: 56, left: 40, top: 40 };

export function arrangeTree(graph, layout = LAYOUT) {
  const nodes = graph?.nodes || [];
  if (!nodes.length) return {};
  const edges = (graph.edges || []).filter((e) => e.from !== e.to && nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to));
  const byPriority = (a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0) || String(a.name).localeCompare(String(b.name)) || a.x - b.x;
  const hasParent = new Set(edges.map((e) => e.to));
  const roots = nodes.filter((n) => n.role === 'Manager');
  const top = roots.length ? roots : nodes.filter((n) => !hasParent.has(n.id));
  const first = top.length ? top : [nodes[0]];
  // Row of each agent: breadth first from the top row, along the connections.
  const level = new Map(first.map((n) => [n.id, 0]));
  let frontier = first.map((n) => n.id);
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const e of edges.filter((x) => x.from === id)) {
        if (!level.has(e.to)) { level.set(e.to, level.get(id) + 1); next.push(e.to); }
      }
    }
    frontier = next;
  }
  // Agents no connection reaches: in the first row under the top, and what they lead below them.
  for (const n of [...nodes].sort(byPriority)) {
    if (level.has(n.id)) continue;
    level.set(n.id, 1);
    let queue = [n.id];
    while (queue.length) {
      const next = [];
      for (const id of queue) for (const e of edges.filter((x) => x.from === id)) if (!level.has(e.to)) { level.set(e.to, level.get(id) + 1); next.push(e.to); }
      queue = next;
    }
  }
  const depth = Math.max(...level.values());
  const rows = Array.from({ length: depth + 1 }, (_, d) => nodes.filter((n) => level.get(n.id) === d));
  rows[0].sort(byPriority);
  // Order each row by the average place of the agents it is connected from (fewer crossing lines).
  for (let d = 1; d <= depth; d++) {
    const above = rows[d - 1].map((n) => n.id);
    const weight = (n) => {
      const places = edges.filter((e) => e.to === n.id && above.includes(e.from)).map((e) => above.indexOf(e.from));
      return places.length ? places.reduce((a, b) => a + b, 0) / places.length : above.length;
    };
    rows[d].sort((a, b) => weight(a) - weight(b) || byPriority(a, b));
  }
  const step = layout.width + layout.gapX;
  const widest = Math.max(...rows.map((r) => r.length));
  const positions = {};
  rows.forEach((row, d) => {
    const offset = ((widest - row.length) * step) / 2;
    row.forEach((n, i) => { positions[n.id] = { x: Math.round(layout.left + offset + i * step), y: layout.top + d * (layout.height + layout.gapY) }; });
  });
  return positions;
}
