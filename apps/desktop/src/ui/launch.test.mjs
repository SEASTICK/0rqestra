import { describe, expect, it, vi } from 'vitest';
import { dismissBoot, isNewer, LAST_VERSION_KEY, launchKind, readLaunch } from './launch.mjs';

const memory = (entries = {}) => ({
  data: new Map(Object.entries(entries)),
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; },
  setItem(key, value) { this.data.set(key, value); },
});

describe('launch kind', () => {
  it('compares versions numerically', () => {
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
    expect(isNewer('0.1.4', '0.1.4')).toBe(false);
    expect(isNewer('0.1.3', '0.1.4')).toBe(false);
    expect(isNewer('dev', '0.1.4')).toBe(false);
  });

  it('shows "Updated" only when the version went up since the previous start', () => {
    expect(launchKind(null, '0.1.4')).toBe('start');
    expect(launchKind('0.1.3', '0.1.4')).toBe('update');
    expect(launchKind('0.1.4', '0.1.4')).toBe('start');
    expect(launchKind('0.1.5', '0.1.4')).toBe('start');
    expect(launchKind('0.1.3', undefined)).toBe('start');
  });

  it('remembers the current version for the next start', () => {
    const storage = memory({ [LAST_VERSION_KEY]: '0.1.3' });
    expect(readLaunch(storage, '0.1.4')).toEqual({ kind: 'update', previous: '0.1.3' });
    expect(readLaunch(storage, '0.1.4')).toEqual({ kind: 'start', previous: '0.1.4' });
  });

  it('starts normally when storage cannot be used', () => {
    const blocked = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
    expect(readLaunch(blocked, '0.1.4')).toEqual({ kind: 'start', previous: null });
  });
});

describe('start screen', () => {
  function fakeDom() {
    const listeners = {};
    const boot = {
      dataset: {},
      classes: new Set(),
      removed: false,
      classList: { add(c) { boot.classes.add(c); } },
      addEventListener(type, fn) { listeners[`boot:${type}`] = fn; },
      remove() { boot.removed = true; },
    };
    const win = {
      performance: { now: () => 200 },
      matchMedia: () => ({ matches: false }),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      addEventListener(type, fn) { listeners[`win:${type}`] = fn; },
      removeEventListener(type) { delete listeners[`win:${type}`]; },
    };
    return { boot, win, listeners, doc: { getElementById: (id) => (id === 'boot' ? boot : null) } };
  }

  it('waits until the animation has played, then fades out and removes itself', async () => {
    vi.useFakeTimers();
    const { boot, win, doc } = fakeDom();
    let done = false;
    dismissBoot({ doc, win, minMs: 1500 }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1299);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(boot.classes.has('leaving')).toBe(true);
    expect(boot.removed).toBe(false);
    await vi.advanceTimersByTimeAsync(420);
    expect(boot.removed).toBe(true);
    vi.useRealTimers();
  });

  it('can be skipped with a click or Escape', async () => {
    vi.useFakeTimers();
    const { boot, win, doc, listeners } = fakeDom();
    const promise = dismissBoot({ doc, win, minMs: 1500 });
    listeners['win:keydown']({ key: 'Escape' });
    await promise;
    expect(boot.classes.has('leaving')).toBe(true);
    expect(listeners['win:keydown']).toBeUndefined();
    vi.useRealTimers();
  });

  it('resolves at once when there is no start screen', async () => {
    await expect(dismissBoot({ doc: { getElementById: () => null }, win: {} })).resolves.toBeUndefined();
  });
});

describe('start screen called twice', () => {
  it('resolves the second call too, without fading twice', async () => {
    vi.useFakeTimers();
    let removed = 0;
    const boot = { dataset: {}, classList: { add() {} }, addEventListener() {}, remove() { removed += 1; } };
    const win = { performance: { now: () => 5000 }, matchMedia: () => ({ matches: false }), setTimeout: (f, ms) => setTimeout(f, ms), addEventListener() {}, removeEventListener() {} };
    const doc = { getElementById: () => boot };
    const first = dismissBoot({ doc, win });
    await vi.advanceTimersByTimeAsync(0);
    await first;
    await expect(dismissBoot({ doc, win })).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(removed).toBe(1);
    vi.useRealTimers();
  });
});
