import { describe, expect, it } from 'vitest';
import { applyChatEvent, DEMO, effectiveTarget, historyFor, newAssistant, readTarget, readyProviders, saveTarget, settleInterrupted, TARGET_KEY, usageLine } from './live-chat.mjs';

const memory = (entries = {}) => ({ data: new Map(Object.entries(entries)), getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }, setItem(k, v) { this.data.set(k, v); } });
const claude = { provider: 'claude', name: 'Claude Code', installed: true, subscription: true, models: [{ id: 'default', label: 'Default', efforts: [], isDefault: true }, { id: 'opus', label: 'Opus', efforts: [], isDefault: false }] };
const codex = { provider: 'codex', name: 'Codex', installed: true, subscription: true, models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['low', 'high'], isDefault: true }, { id: 'gpt-6-luna', label: 'Luna', efforts: ['low'], isDefault: false }] };

describe('chat target', () => {
  it('only offers tools that are installed and signed in with a subscription', () => {
    expect(readyProviders([claude, { ...codex, subscription: false }, null])).toEqual([claude]);
    expect(readyProviders(undefined)).toEqual([]);
  });

  it('falls back to the demo when the chosen tool is not ready', () => {
    expect(effectiveTarget({ provider: 'codex', model: 'gpt-6.1-sol' }, [claude])).toBe(DEMO);
    expect(effectiveTarget({ provider: 'demo' }, [claude])).toBe(DEMO);
  });

  it('keeps a model and effort that exist, and replaces ones that do not', () => {
    expect(effectiveTarget({ provider: 'codex', model: 'gpt-6-luna', effort: 'low' }, [codex])).toMatchObject({ model: 'gpt-6-luna', effort: 'low', name: 'Codex' });
    expect(effectiveTarget({ provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, [codex])).toMatchObject({ model: 'gpt-6-luna', effort: null });
    expect(effectiveTarget({ provider: 'codex', model: 'gone', effort: 'high' }, [codex])).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
    expect(effectiveTarget({ provider: 'claude', model: 'opus' }, [claude])).toMatchObject({ model: 'opus', modelLabel: 'Opus' });
  });

  it('remembers the choice and survives bad storage', () => {
    const storage = memory();
    saveTarget(storage, { provider: 'codex', model: 'gpt-6-luna', effort: 'low', name: 'x' });
    expect(readTarget(storage)).toEqual({ provider: 'codex', model: 'gpt-6-luna', effort: 'low' });
    expect(readTarget(memory({ [TARGET_KEY]: '{"provider":"bash"}' }))).toEqual({ provider: 'demo', model: null, effort: null });
    expect(readTarget(memory({ [TARGET_KEY]: 'not json' })).provider).toBe('demo');
  });
});

describe('chat messages', () => {
  it('sends the user turns and finished real replies, not demo replies', () => {
    const messages = [
      { kind: 'user', text: 'q1' }, { kind: 'manager', text: 'demo reply' },
      { kind: 'assistant', status: 'done', text: 'a1' }, { kind: 'assistant', status: 'failed', text: 'partial' }, { kind: 'user', text: 'q2' },
    ];
    expect(historyFor(messages)).toEqual([{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }, { role: 'user', text: 'q2' }]);
    expect(historyFor(Array(50).fill({ kind: 'user', text: 'x' })).length).toBe(40);
  });

  it('builds the reply from streamed events', () => {
    let m = newAssistant('m1', { provider: 'codex', name: 'Codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(m).toMatchObject({ kind: 'assistant', status: 'streaming', text: '', providerName: 'Codex' });
    m = applyChatEvent(m, { type: 'started', model: 'gpt-6.1-sol-2026' });
    m = applyChatEvent(m, { type: 'delta', text: 'Hel' });
    m = applyChatEvent(m, { type: 'delta', text: 'lo' });
    expect(m.text).toBe('Hello');
    const done = applyChatEvent(m, { type: 'completed', text: 'Hello', usage: { inputTokens: 10, outputTokens: 2 }, limits: [{ label: '5-hour limit', usedPercent: 18.6 }] });
    expect(done).toMatchObject({ status: 'done', model: 'gpt-6.1-sol-2026' });
    expect(usageLine(done)).toBe('10 in · 2 out tokens · 5-hour limit 19% used');
    expect(applyChatEvent(m, { type: 'cancelled', text: '' })).toMatchObject({ status: 'stopped', text: 'Hello' });
    expect(applyChatEvent(m, { type: 'failed', reason: 'usage_limit', message: 'limit', text: '' })).toMatchObject({ status: 'failed', reason: 'usage_limit', error: 'limit' });
    expect(applyChatEvent(m, { type: 'unknown' })).toBe(m);
  });

  it('marks a reply that was interrupted by closing the app as stopped', () => {
    expect(settleInterrupted([{ kind: 'assistant', status: 'streaming' }, { kind: 'user' }])).toEqual([{ kind: 'assistant', status: 'stopped' }, { kind: 'user' }]);
  });
});
