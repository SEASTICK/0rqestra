/* global document, window */
// Decides which screen greets the user: a normal start, or "Updated to vX" when the app version
// is higher than at the previous start (the same model as Trader_go). The last version seen is
// kept on this device; if it cannot be read, the start is a normal one.

export const LAST_VERSION_KEY = 'orqestra-last-version';

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  return match ? match.slice(1).map(Number) : null;
}

export function isNewer(candidate, current) {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function launchKind(previous, current) {
  return previous && current && isNewer(current, previous) ? 'update' : 'start';
}

export function readLaunch(storage, current) {
  let previous = null;
  try {
    previous = storage.getItem(LAST_VERSION_KEY);
  } catch {
    // Unknown previous version: a normal start.
  }
  const kind = launchKind(previous, current);
  if (current) {
    try {
      storage.setItem(LAST_VERSION_KEY, current);
    } catch {
      // Not remembering the version only means no "Updated" screen next time.
    }
  }
  return { kind, previous };
}

// The start screen is plain HTML in index.html, so it shows from the very first frame instead of
// appearing once the script has loaded. This takes it away after it has played (at least minMs
// since the page started), or at once on a click, Escape, or Enter. Resolves when it starts to fade.
export function dismissBoot({ doc = document, win = window, minMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const boot = doc.getElementById('boot');
    if (!boot) {
      resolve();
      return;
    }
    if (boot.dataset.leaving) {
      // Already fading (for example a second call from the same start).
      resolve();
      return;
    }
    let reduce = false;
    try {
      reduce = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      reduce = false;
    }
    const leave = () => {
      if (!boot.dataset.leaving) {
        boot.dataset.leaving = '1';
        boot.classList.add('leaving');
        win.setTimeout(() => boot.remove(), reduce ? 0 : 420);
      }
      win.removeEventListener('keydown', onKey);
      resolve();
    };
    const onKey = (event) => {
      if (event.key === 'Escape' || event.key === 'Enter') leave();
    };
    boot.addEventListener('click', leave);
    win.addEventListener('keydown', onKey);
    const elapsed = typeof win.performance?.now === 'function' ? win.performance.now() : minMs;
    win.setTimeout(leave, reduce ? 0 : Math.max(0, minMs - elapsed));
  });
}
