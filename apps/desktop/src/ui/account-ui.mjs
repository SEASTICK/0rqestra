// The 0rqestra account in the window: when to show the welcome screen, and small text helpers.
// The account is the same Supabase account Teams uses; its session lives only in the main process.

export const ACCOUNT_CHOICE_KEY = 'orqestra-account-choice';

// What the window shows: 'loading' until the saved session has been read, 'welcome' for the
// account screens, 'app' otherwise. A user who chose "Continue without an account" sees the app,
// unless Supabase ended their session (then they are asked to sign in again, and may decline).
export function gateState({ loaded, view, choice, dismissedEnd }) {
  if (!loaded) return 'loading';
  if (!view || view.status === 'unconfigured' || view.status === 'signed_in') return 'app';
  if (view.status === 'code_sent') return 'welcome';
  if (view.sessionEnded && !dismissedEnd) return 'welcome';
  return choice === 'local' ? 'app' : 'welcome';
}

export function secondsLeft(resendAt, now = Date.now()) {
  return resendAt && resendAt > now ? Math.ceil((resendAt - now) / 1000) : 0;
}

export function accountLabel(view) {
  if (!view || view.status !== 'signed_in') return null;
  const name = view.displayName || String(view.email || '').split('@')[0] || 'Your account';
  return { name, email: view.email || '' };
}

export const cleanError = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
