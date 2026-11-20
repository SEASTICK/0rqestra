import { describe, expect, it } from "vitest";
import { claudeUsage, codexUsage } from "./usage";

describe("provider usage", () => {
  it("adds Claude Code's cached input to its input total (its inputTokens excludes the cache)", () => {
    // The shape Claude Code returned for a one-word reply on 2026-11-19.
    const result = { modelUsage: { "claude-opus-5-5": { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 27653, cacheCreationInputTokens: 7593 } } };
    expect(claudeUsage(result)).toEqual({ inputTokens: 35248, outputTokens: 4, cachedInputTokens: 27653 });
    // Two models in one answer are summed.
    expect(claudeUsage({ modelUsage: { a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 10 }, b: { inputTokens: 3, outputTokens: 4 } } })).toEqual({ inputTokens: 14, outputTokens: 6, cachedInputTokens: 10 });
    expect(claudeUsage({ usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 1 } })).toEqual({ inputTokens: 105, outputTokens: 1, cachedInputTokens: 100 });
  });

  it("keeps Codex's input total as it is (its cachedInputTokens is already part of it), from the latest turn", () => {
    expect(codexUsage({ last: { inputTokens: 18579, cachedInputTokens: 14976, outputTokens: 5 }, total: { inputTokens: 99999, outputTokens: 9 } })).toEqual({ inputTokens: 18579, outputTokens: 5, cachedInputTokens: 14976 });
    expect(codexUsage({ total: { inputTokens: 100, outputTokens: 7 } })).toEqual({ inputTokens: 100, outputTokens: 7, cachedInputTokens: null });
  });

  it("says unavailable (null) when nothing was reported", () => {
    expect(claudeUsage({})).toBeNull();
    expect(claudeUsage({ modelUsage: {} })).toBeNull();
    expect(codexUsage(undefined)).toBeNull();
    expect(codexUsage({ last: {}, total: {} })).toBeNull();
  });
});
