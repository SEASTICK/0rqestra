// The window's color theme: light (default), dark, or following the system. boot.js applies the
// saved choice before the first paint, so the window never flashes the wrong colors; the CSS
// switches with color-scheme and light-dark().

export const THEME_KEY = 'orqestra-theme';
export const THEMES = ['light', 'dark', 'system'];
export const DEFAULT_THEME = 'light';

export function readTheme(storage) {
  try {
    const value = storage.getItem(THEME_KEY);
    return THEMES.includes(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme, root, storage) {
  const value = THEMES.includes(theme) ? theme : DEFAULT_THEME;
  root.setAttribute('data-theme', value);
  try {
    storage.setItem(THEME_KEY, value);
  } catch {
    // The theme still applies for this session.
  }
  return value;
}
