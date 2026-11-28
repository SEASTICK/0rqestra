import { describe, expect, it } from 'vitest';
import { accountWarnings, backupCandidates, moveBackup, orderedBackups, resetText, switchText } from './backup-ui.mjs';

const node = { id: 'b1', name: 'Bea', role: 'Builder', agent: { tool: 'claude', model: 'opus' } };
const graph = { nodes: [
  { id: 'm', name: 'Manager', role: 'Manager', agent: { tool: 'claude' } },
  node,
  { id: 'b2', name: 'Codex Builder', role: 'Builder', agent: { tool: 'codex', model: 'gpt-5' } },
  { id: 'b3', name: 'Bo', role: 'Builder', agent: { tool: 'claude', model: null } },
  { id: 'b4', name: 'Gem', role: 'Builder', agent: { tool: 'gemini', model: 'pro' } },
  { id: 'b5', name: 'Cody', role: 'Builder', agent: { tool: 'codex', model: null } },
  { id: 'r1', name: 'Vera', role: 'Code Reviewer', agent: { tool: 'codex' } },
  { id: 'x', name: 'No tool', role: 'Builder', agent: null },
] };
const statuses = [{ provider: 'claude', installed: true, subscription: true }, { provider: 'codex', installed: true, subscription: true }, { provider: 'gemini', installed: true, subscription: false }];

describe('backup agents', () => {
  it('offers other agents with the same role that run on a tool, with provider, model and readiness', () => {
    const c = backupCandidates(graph, node, statuses);
    expect(c.map((x) => [x.name, x.toolName, x.model, x.ready])).toEqual([['Bo', 'Claude Code', 'default model', true], ['Codex Builder', 'Codex', 'gpt-5', true], ['Cody', 'Codex', 'default model', true], ['Gem', 'Gemini', 'pro', false]]);
  });

  it('keeps the chosen order and explains shared accounts', () => {
    const c = backupCandidates(graph, node, statuses);
    const chosen = orderedBackups(['b2', 'b3', 'b5', 'gone'], c);
    expect(chosen.map((x) => x.name)).toEqual(['Codex Builder', 'Bo', 'Cody']);
    const w = accountWarnings(node, chosen);
    expect(w[0]).toMatch(/Bo uses Claude Code like Bea: they share one account/);
    expect(w[1]).toMatch(/Codex Builder and Cody both use Codex/);
    expect(moveBackup(['b2', 'b3'], 'b3', -1)).toEqual(['b3', 'b2']);
    expect(moveBackup(['b2', 'b3'], 'b2', -1)).toEqual(['b2', 'b3']);
  });

  it('shows a reset time only when reported, and words a switch for the run card', () => {
    expect(resetText(null)).toBeNull();
    expect(resetText(undefined)).toBeNull();
    expect(resetText(1_900_000_000)).toMatch(/^Resets /);
    expect(switchText({ fromTool: 'claude', toName: 'Codex Builder' })).toBe('Claude Code reached its usage limit. Codex Builder resumed from the last checkpoint.');
  });
});
