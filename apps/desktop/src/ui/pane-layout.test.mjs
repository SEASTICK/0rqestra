import { describe, expect, it } from 'vitest';
import { CHAT_MIN, DEFAULT_RATIO, DIVIDER, LAYOUT_KEY, TREE_MIN, chatWidth, clampRatio, fitsSplit, ratioAt, ratioForKey, readLayout, saveLayout, shownView } from './pane-layout.mjs';

const memory = (entries = {}) => ({
  data: new Map(Object.entries(entries)),
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; },
  setItem(key, value) { this.data.set(key, value); },
});
const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };

describe('pane layout storage', () => {
  it('defaults to chat, the default split and an open sidebar', () => {
    expect(readLayout(memory())).toEqual({ view: 'chat', chatRatio: DEFAULT_RATIO, navOpen: true });
    expect(readLayout(blocked)).toEqual({ view: 'chat', chatRatio: DEFAULT_RATIO, navOpen: true });
    expect(readLayout(null)).toEqual({ view: 'chat', chatRatio: DEFAULT_RATIO, navOpen: true });
  });

  it('round-trips a saved layout', () => {
    const storage = memory();
    expect(saveLayout(storage, { view: 'tree', chatRatio: 0.55, navOpen: false })).toBe(true);
    expect(readLayout(storage)).toEqual({ view: 'tree', chatRatio: 0.55, navOpen: false });
  });

  it('ignores malformed fields one by one', () => {
    expect(readLayout(memory({ [LAYOUT_KEY]: '{not json' }))).toEqual({ view: 'chat', chatRatio: DEFAULT_RATIO, navOpen: true });
    expect(readLayout(memory({ [LAYOUT_KEY]: JSON.stringify({ view: 'grid', chatRatio: 'wide', navOpen: 'no' }) }))).toEqual({ view: 'chat', chatRatio: DEFAULT_RATIO, navOpen: true });
    expect(readLayout(memory({ [LAYOUT_KEY]: JSON.stringify({ view: 'split', chatRatio: 4 }) }))).toEqual({ view: 'split', chatRatio: 0.9, navOpen: true });
  });

  it('reports a failed save instead of throwing', () => {
    expect(saveLayout(blocked, { view: 'split', chatRatio: 0.4, navOpen: true })).toBe(false);
  });
});

describe('pane sizes', () => {
  it('clamps ratios', () => {
    expect(clampRatio(-1)).toBe(0.1);
    expect(clampRatio(2)).toBe(0.9);
    expect(clampRatio(NaN)).toBe(DEFAULT_RATIO);
  });

  it('keeps both panes at least their minimum width when they fit', () => {
    const w = 1200;
    expect(fitsSplit(w)).toBe(true);
    expect(chatWidth(0.1, w)).toBe(CHAT_MIN);
    expect(chatWidth(0.9, w)).toBe(w - DIVIDER - TREE_MIN);
    expect(chatWidth(0.5, w)).toBe(Math.round(0.5 * (w - DIVIDER)));
  });

  it('fits a saved ratio to a smaller window', () => {
    // Saved wide on a big screen, reopened in a small window: the tree keeps its minimum.
    expect(chatWidth(0.85, 700)).toBe(700 - DIVIDER - TREE_MIN);
  });

  it('maps a pointer position to a ratio inside the minimums', () => {
    const w = 1000;
    const avail = w - DIVIDER;
    expect(ratioAt(DIVIDER / 2 + 500, w)).toBeCloseTo(500 / avail);
    expect(ratioAt(0, w)).toBeCloseTo(CHAT_MIN / avail);
    expect(ratioAt(w, w)).toBeCloseTo((avail - TREE_MIN) / avail);
  });

  it('moves the divider with the keyboard', () => {
    expect(ratioForKey(0.4, 'ArrowLeft')).toBeCloseTo(0.38);
    expect(ratioForKey(0.4, 'ArrowRight', true)).toBeCloseTo(0.5);
    expect(ratioForKey(0.4, 'Enter')).toBe(DEFAULT_RATIO);
    expect(ratioForKey(0.4, 'a')).toBeNull();
    const w = 1000;
    expect(ratioForKey(0.4, 'Home', false, w)).toBeCloseTo(CHAT_MIN / (w - DIVIDER));
    expect(ratioForKey(0.4, 'End', false, w)).toBeCloseTo((w - DIVIDER - TREE_MIN) / (w - DIVIDER));
  });
});

describe('shown view', () => {
  it('shows the chat alone for projects without a tree', () => {
    expect(shownView('split', { hasTree: false })).toBe('chat');
    expect(shownView('tree', { hasTree: false })).toBe('chat');
  });

  it('falls back to the tree when a split does not fit', () => {
    expect(shownView('split', { containerWidth: CHAT_MIN + TREE_MIN + DIVIDER })).toBe('split');
    expect(shownView('split', { containerWidth: 500 })).toBe('tree');
    expect(shownView('chat', { containerWidth: 300 })).toBe('chat');
    expect(shownView('nonsense')).toBe('chat');
  });
});
