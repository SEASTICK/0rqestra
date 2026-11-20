import type { Usage } from "./types";

// Token usage as the tools report it, turned into one shape: every input token (cached ones
// included), the part of it that came from the cache, and output tokens. The tools count cache
// differently (checked against both on 2026-11-19):
// - Claude Code's result has, per model, inputTokens WITHOUT the cache, plus cacheReadInputTokens
//   and cacheCreationInputTokens. A one-word reply showed inputTokens 2, cache read 27,653 and
//   cache creation 7,593: Claude Code's own instructions are in the cache. All three are input.
// - Codex reports inputTokens WITH the cached part already in it (cachedInputTokens is a subset:
//   18,579 input of which 14,976 cached for a one-word reply). Its usage notification is sent
//   again as a turn streams, with running totals, so only the latest one counts (never a sum).

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

export function claudeUsage(result: Record<string, unknown>): Usage | null {
  const models = result.modelUsage;
  if (models && typeof models === "object" && Object.keys(models).length) {
    let input = 0, cached = 0, output = 0, known = false;
    for (const m of Object.values(models as Record<string, Record<string, unknown>>)) {
      const base = num(m?.inputTokens), read = num(m?.cacheReadInputTokens) ?? 0, write = num(m?.cacheCreationInputTokens) ?? 0, out = num(m?.outputTokens);
      if (base === null && out === null) continue;
      known = true;
      input += (base ?? 0) + read + write;
      cached += read;
      output += out ?? 0;
    }
    if (known) return { inputTokens: input, outputTokens: output, cachedInputTokens: cached };
  }
  // Older results only have the API's usage block (same meaning: input_tokens excludes the cache).
  const u = result.usage as Record<string, unknown> | undefined;
  if (u && typeof u === "object") {
    const base = num(u.input_tokens), out = num(u.output_tokens);
    if (base === null && out === null) return null;
    const read = num(u.cache_read_input_tokens) ?? 0, write = num(u.cache_creation_input_tokens) ?? 0;
    return { inputTokens: (base ?? 0) + read + write, outputTokens: out, cachedInputTokens: read };
  }
  return null;
}

// Codex's thread/tokenUsage/updated: `last` is the latest turn, `total` the whole (one-turn,
// ephemeral) thread. The latest notification replaces the earlier ones.
export function codexUsage(tokenUsage: unknown): Usage | null {
  const t = (tokenUsage ?? {}) as { last?: Record<string, unknown>; total?: Record<string, unknown> };
  const b = t.last && num(t.last.inputTokens) !== null ? t.last : t.total;
  if (!b) return null;
  const input = num(b.inputTokens), output = num(b.outputTokens);
  if (input === null && output === null) return null;
  return { inputTokens: input, outputTokens: output, cachedInputTokens: num(b.cachedInputTokens) };
}
