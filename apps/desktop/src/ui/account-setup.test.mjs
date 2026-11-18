import { describe, expect, it } from 'vitest';
import { activityText, agentChoices, badgeFor, canUse, elapsed, mainAction, stateLine, steps, subtitle } from './account-setup.mjs';

const base = { provider: 'claude', name: 'Claude Code', installed: false, version: null, signedIn: false, subscription: false, plan: null, authMethod: null, source: null, activity: null, lastTest: null, checkFailed: false, problem: null };
const card = (over) => ({ ...base, ...over });

describe('AI accounts cards', () => {
  it('gives each state one clear main action', () => {
    expect(mainAction(card({ setup: 'missing' }))).toEqual({ kind: 'install', label: 'Install Claude Code' });
    expect(mainAction(card({ setup: 'signed_out', installed: true }))).toEqual({ kind: 'signIn', label: 'Sign in' });
    expect(mainAction(card({ setup: 'api_key', provider: 'codex', name: 'Codex' }))).toEqual({ kind: 'signIn', label: 'Sign in with your ChatGPT plan' });
    expect(mainAction(card({ setup: 'signed_in' }))).toEqual({ kind: 'test', label: 'Test connection' });
    expect(mainAction(card({ setup: 'failed', lastTest: { ok: false } }))).toEqual({ kind: 'test', label: 'Test again' });
    expect(mainAction(card({ setup: 'failed', checkFailed: true }))).toEqual({ kind: 'refresh', label: 'Check again' });
    expect(mainAction(card({ setup: 'missing', activity: { kind: 'installing', startedAt: 0, log: [] } })).kind).toBe('cancel');
    expect(mainAction(card({ setup: 'signed_in', activity: { kind: 'testing', startedAt: 0, log: [] } })).kind).toBe('busy');
  });

  it('shows four distinct states and the API-key case apart', () => {
    const badges = ['missing', 'signed_out', 'signed_in', 'failed'].map((setup) => badgeFor(card({ setup })).badge);
    expect(badges).toEqual(['CLI missing', 'Installed · signed out', 'Signed in', 'Connection failed']);
    expect(badgeFor(card({ setup: 'signed_in', lastTest: { ok: true } })).badge).toBe('Connected');
    expect(badgeFor(card({ setup: 'api_key' })).badge).toBe('Signed in with an API key');
    expect(stateLine(card({ setup: 'api_key', authMethod: 'api_key' }))).toContain('never uses API keys');
    expect(stateLine(card({ setup: 'signed_in', plan: 'max' }))).toContain('max Claude subscription');
  });

  it('tracks the guide steps', () => {
    const done = (c) => steps(c).map((s) => (s.done ? 'done' : s.current ? 'now' : '-')).join(' ');
    expect(done(card({ setup: 'missing' }))).toBe('now - -');
    expect(done(card({ setup: 'signed_out' }))).toBe('done now -');
    expect(done(card({ setup: 'signed_in', subscription: true }))).toBe('done done now');
    expect(done(card({ setup: 'signed_in', subscription: true, lastTest: { ok: true } }))).toBe('done done done');
  });

  it('describes progress and where the tool came from', () => {
    expect(elapsed(83_400)).toBe('1:23');
    expect(activityText(card({ activity: { kind: 'installing' } }))).toContain("Anthropic's official installer");
    expect(activityText(card({ activity: { kind: 'waiting_sign_in' } }))).toContain('updates by itself');
    expect(subtitle(card({}))).toBe('Official tool from Anthropic');
    expect(subtitle(card({ installed: true, version: '2.1.400', source: 'winget' }))).toBe('Claude Code · version 2.1.400 · WinGet');
  });

  it('offers a connected tool for the Manager or an agent, never a tool on an API key', () => {
    expect(canUse(card({ setup: 'signed_in' }))).toBe(true);
    expect(canUse(card({ setup: 'api_key' }))).toBe(false);
    expect(agentChoices([{ id: 'm', name: 'Boss', role: 'Manager' }, { id: 'b', name: 'Builder one', role: 'Builder' }])).toEqual([{ id: 'b', label: 'Builder one (Builder)' }]);
  });
});
