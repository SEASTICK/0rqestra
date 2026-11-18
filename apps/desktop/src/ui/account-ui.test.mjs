import { describe, expect, it } from 'vitest';
import { accountLabel, cleanError, gateState, secondsLeft } from './account-ui.mjs';

describe('first launch and staying signed in', () => {
  const signedIn = { status: 'signed_in', email: 'ann@x.se', displayName: 'Ann' };
  it('shows a loading state until the saved session is read, so the welcome screen never flashes', () => {
    expect(gateState({ loaded: false, view: null, choice: null })).toBe('loading');
    expect(gateState({ loaded: true, view: signedIn, choice: null })).toBe('app');
  });
  it('welcomes a new user, and respects "Continue without an account"', () => {
    expect(gateState({ loaded: true, view: { status: 'signed_out' }, choice: null })).toBe('welcome');
    expect(gateState({ loaded: true, view: { status: 'signed_out' }, choice: 'local' })).toBe('app');
    expect(gateState({ loaded: true, view: { status: 'code_sent' }, choice: 'local' })).toBe('welcome');
  });
  it('asks to sign in again when the session ended, unless the user declines', () => {
    const ended = { status: 'signed_out', sessionEnded: 'Your 0rqestra session has ended.' };
    expect(gateState({ loaded: true, view: ended, choice: 'local' })).toBe('welcome');
    expect(gateState({ loaded: true, view: ended, choice: 'local', dismissedEnd: true })).toBe('app');
  });
  it('opens the app when there is no account system (Teams not set up) or no bridge', () => {
    expect(gateState({ loaded: true, view: { status: 'unconfigured' }, choice: null })).toBe('app');
    expect(gateState({ loaded: true, view: null, choice: null })).toBe('app');
  });
  it('shows the cooldown, the account, and readable errors', () => {
    expect(secondsLeft(10_500, 1_000)).toBe(10);
    expect(secondsLeft(0, 1_000)).toBe(0);
    expect(accountLabel(signedIn)).toEqual({ name: 'Ann', email: 'ann@x.se' });
    expect(accountLabel({ ...signedIn, displayName: null })).toEqual({ name: 'ann', email: 'ann@x.se' });
    expect(accountLabel({ status: 'signed_out' })).toBeNull();
    expect(cleanError(new Error("Error invoking remote method 'teams:send-code': Error: No account"))).toBe('No account');
  });
});
