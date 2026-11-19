import { describe, expect, it } from 'vitest';
import { arrangeTree, LAYOUT } from './tree-layout.mjs';

const node = (id, role, x = 0, y = 0, priority = 1) => ({ id, name: id, role, x, y, priority });
const step = LAYOUT.width + LAYOUT.gapX;
const row = LAYOUT.height + LAYOUT.gapY;

describe('arranging the tree', () => {
  it('puts the Manager on top and connected agents in rows below, centred', () => {
    const graph = {
      nodes: [node('rev', 'Code Reviewer', 900, 50), node('m', 'Manager', 500, 900), node('b', 'Builder', 10, 10), node('p', 'Planner', 300, 300)],
      edges: [{ from: 'm', to: 'p' }, { from: 'm', to: 'b' }, { from: 'b', to: 'rev' }, { from: 'p', to: 'rev' }],
    };
    const at = arrangeTree(graph);
    expect(at.m.y).toBe(LAYOUT.top);
    expect(at.p.y).toBe(LAYOUT.top + row);
    expect(at.b.y).toBe(LAYOUT.top + row);
    expect(at.rev.y).toBe(LAYOUT.top + 2 * row);
    expect(Math.abs(at.b.x - at.p.x)).toBe(step);
    // The Manager and the reviewer sit in the middle of the two agents.
    expect(at.m.x).toBe((at.b.x + at.p.x) / 2);
    expect(at.rev.x).toBe(at.m.x);
  });

  it('places agents without a connection in the first row under the Manager', () => {
    const at = arrangeTree({ nodes: [node('m', 'Manager'), node('a', 'Builder', 0, 0, 2), node('b', 'Designer', 0, 0, 1)], edges: [] });
    expect([at.a.y, at.b.y]).toEqual([LAYOUT.top + row, LAYOUT.top + row]);
    expect(at.b.x).toBeLessThan(at.a.x);
  });

  it('orders a row by the agents it comes from, so lines do not cross', () => {
    const graph = {
      nodes: [node('m', 'Manager'), node('left', 'Builder', 0, 0, 1), node('right', 'Builder', 0, 0, 2), node('underRight', 'Tester', 0, 0, 1), node('underLeft', 'Tester', 0, 0, 2)],
      edges: [{ from: 'm', to: 'left' }, { from: 'm', to: 'right' }, { from: 'right', to: 'underRight' }, { from: 'left', to: 'underLeft' }],
    };
    const at = arrangeTree(graph);
    expect(at.underLeft.x).toBeLessThan(at.underRight.x);
  });

  it('copes with circles, broken connections and a tree without a Manager', () => {
    const at = arrangeTree({ nodes: [node('a', 'Builder'), node('b', 'Builder')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'a', to: 'gone' }, { from: 'a', to: 'a' }] });
    expect(Object.keys(at).sort()).toEqual(['a', 'b']);
    expect(at.a.y).not.toBe(at.b.y);
    expect(arrangeTree({ nodes: [], edges: [] })).toEqual({});
  });
});
