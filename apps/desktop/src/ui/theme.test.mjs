import { describe, expect, it } from 'vitest';
import { applyTheme, DEFAULT_THEME, readTheme, THEME_KEY } from './theme.mjs';

const memory = (entries = {}) => ({
  data: new Map(Object.entries(entries)),
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; },
  setItem(key, value) { this.data.set(key, value); },
});

describe('theme', () => {
  it('defaults to light and accepts only known themes', () => {
    expect(DEFAULT_THEME).toBe('light');
    expect(readTheme(memory())).toBe('light');
    expect(readTheme(memory({ [THEME_KEY]: 'dark' }))).toBe('dark');
    expect(readTheme(memory({ [THEME_KEY]: 'neon' }))).toBe('light');
    expect(readTheme({ getItem() { throw new Error('blocked'); } })).toBe('light');
  });

  it('applies and remembers a theme, falling back to light for anything unknown', () => {
    const storage = memory();
    const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    expect(applyTheme('system', root, storage)).toBe('system');
    expect(root.attrs['data-theme']).toBe('system');
    expect(storage.getItem(THEME_KEY)).toBe('system');
    expect(applyTheme('neon', root, storage)).toBe('light');
  });
});
