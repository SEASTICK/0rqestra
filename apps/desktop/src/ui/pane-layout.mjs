// Layout of the project workspace: the Manager chat and the Work Tree side by side, a divider between
// them, and the navigation sidebar. Pure functions so the rules can be tested without a window.
//
// The split is stored as the chat's share of the width (0..1), not in pixels, so a saved layout fits
// whatever window the app reopens in; chatWidth() turns it into pixels for the space there is now.

export const LAYOUT_KEY = 'orqestra-layout';
export const VIEWS = ['chat', 'split', 'tree'];
export const CHAT_MIN = 300;
export const TREE_MIN = 320;
export const DIVIDER = 14;
export const DEFAULT_RATIO = 0.38;
export const KEY_STEP = 0.02;
export const KEY_STEP_LARGE = 0.1;

const RATIO_MIN = 0.1;
const RATIO_MAX = 0.9;

export function clampRatio(ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r)) return DEFAULT_RATIO;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
}

export const defaultLayout = () => ({ view: 'chat', chatRatio: DEFAULT_RATIO, navOpen: true });

// Reads the saved layout. Anything missing or malformed falls back to the default for that field.
export function readLayout(storage) {
  const base = defaultLayout();
  let saved;
  try { saved = JSON.parse(storage?.getItem(LAYOUT_KEY) || 'null'); } catch { saved = null; }
  if (!saved || typeof saved !== 'object') return base;
  return {
    view: VIEWS.includes(saved.view) ? saved.view : base.view,
    chatRatio: saved.chatRatio === undefined ? base.chatRatio : clampRatio(saved.chatRatio),
    navOpen: typeof saved.navOpen === 'boolean' ? saved.navOpen : base.navOpen,
  };
}

export function saveLayout(storage, layout) {
  try {
    storage?.setItem(LAYOUT_KEY, JSON.stringify({ view: VIEWS.includes(layout.view) ? layout.view : 'chat', chatRatio: clampRatio(layout.chatRatio), navOpen: layout.navOpen !== false }));
    return true;
  } catch {
    return false;
  }
}

// True when both panes fit beside each other at their minimum widths.
export const fitsSplit = (containerWidth) => containerWidth >= CHAT_MIN + TREE_MIN + DIVIDER;

// The chat's width in pixels for this container, kept between both panes' minimums.
export function chatWidth(ratio, containerWidth) {
  const avail = Math.max(0, containerWidth - DIVIDER);
  const wanted = Math.round(clampRatio(ratio) * avail);
  if (!fitsSplit(containerWidth)) return Math.max(0, Math.min(wanted, avail));
  return Math.min(avail - TREE_MIN, Math.max(CHAT_MIN, wanted));
}

// The ratio for a pointer at x pixels from the container's left edge (the divider's centre).
export function ratioAt(x, containerWidth) {
  const avail = containerWidth - DIVIDER;
  if (avail <= 0) return DEFAULT_RATIO;
  const lo = Math.min(CHAT_MIN, avail) / avail;
  const hi = Math.max(lo, (avail - TREE_MIN) / avail);
  return clampRatio(Math.min(hi, Math.max(lo, (x - DIVIDER / 2) / avail)));
}

// The ratio after a key press on the divider, or null when the key does nothing.
export function ratioForKey(ratio, key, shift = false, containerWidth = 0) {
  const step = shift ? KEY_STEP_LARGE : KEY_STEP;
  let next;
  if (key === 'ArrowLeft') next = ratio - step;
  else if (key === 'ArrowRight') next = ratio + step;
  else if (key === 'Home') next = 0;
  else if (key === 'End') next = 1;
  else if (key === 'Enter') return DEFAULT_RATIO;
  else return null;
  // Keep the keyboard inside what the panes can show, so each press visibly moves the divider.
  if (containerWidth > 0 && fitsSplit(containerWidth)) {
    const avail = containerWidth - DIVIDER;
    next = Math.min((avail - TREE_MIN) / avail, Math.max(CHAT_MIN / avail, next));
  }
  return clampRatio(next);
}

// What the workspace shows: projects without a tree ("Ask anything") always show the chat alone, and a
// split that cannot fit the window shows the tree with a control to show the chat instead.
export function shownView(view, { hasTree = true, containerWidth = Infinity } = {}) {
  if (!hasTree) return 'chat';
  const v = VIEWS.includes(view) ? view : 'chat';
  if (v === 'split' && !fitsSplit(containerWidth)) return 'tree';
  return v;
}
