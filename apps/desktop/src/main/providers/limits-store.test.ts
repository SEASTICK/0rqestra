import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsStore, recordLimits } from "./limits-store.js";
import { EventQueue, type ChatEvent, type ProviderAdapter, type ProviderStatus } from "./types.js";

const status = (provider: "claude" | "codex", limits: ProviderStatus["limits"] = []): ProviderStatus => ({ provider, name: provider, installed: true, version: "1", signedIn: true, plan: null, subscription: true, models: [], limits, problem: null });
const five = { label: "5-hour limit", usedPercent: 30, windowMinutes: 300 };

describe("limits store", () => {
  it("keeps the last limits a reply reported, with their time", () => {
    let t = 1000;
    const store = new LimitsStore(() => t);
    store.record("claude", []);
    expect(store.get("claude")).toBeNull();
    store.record("claude", [five]);
    t = 2000;
    const [claude, codex] = store.merge([status("claude"), status("codex", [{ ...five, usedPercent: 10 }])]);
    expect(claude).toMatchObject({ limits: [five], limitsAt: 1000 });
    // A tool that reports limits in its status check keeps its own, as read just now.
    expect(codex).toMatchObject({ limits: [{ ...five, usedPercent: 10 }], limitsAt: null });
  });

  it("records limits from every completed reply of a wrapped adapter", async () => {
    const store = new LimitsStore();
    const queue = new EventQueue<ChatEvent>();
    const adapter = { id: "claude", status: async () => status("claude"), chat: () => ({ events: queue, stop: () => {} }) } as unknown as ProviderAdapter;
    const handle = recordLimits(adapter, store).chat({ provider: "claude", model: null, effort: null, history: [], text: "hi", cwd: "." });
    queue.push({ type: "delta", text: "a" });
    queue.push({ type: "completed", text: "a", usage: null, limits: [five] });
    queue.end();
    const seen: string[] = [];
    for await (const e of handle.events) seen.push(e.type);
    expect(seen).toEqual(["delta", "completed"]);
    expect(store.get("claude")?.limits).toEqual([five]);
  });

  it("keeps the other window and the values across a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-limits-"));
    const file = path.join(dir, "limits.json");
    const week = { ...five, label: "7-day limit", windowMinutes: 10080, usedPercent: 40 };
    const a = new LimitsStore(() => 5);
    a.persistTo(file);
    a.record("claude", [week]);
    a.record("claude", [{ ...five, usedPercent: 12 }]);
    expect(a.get("claude")?.limits.map((l) => l.label).sort()).toEqual(["5-hour limit", "7-day limit"].sort());
    const b = new LimitsStore();
    b.persistTo(file);
    expect(b.get("claude")?.limits).toHaveLength(2);
    expect(b.get("claude")?.at).toBe(5);
    fs.writeFileSync(file, "not json");
    expect(() => new LimitsStore().persistTo(file)).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
