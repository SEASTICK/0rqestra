import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyFailure, geminiArgs, GeminiAdapter, geminiLimits, geminiUsage, parseModels, SAFE_MODES } from "./gemini.js";
import { providerEnv } from "./process.js";
import type { ChatEvent, ChatHandle, ChatRequest } from "./types.js";
import { adapterOf } from "./types.js";

const fixtures = path.join(__dirname, "test-fixtures");
const node = { path: process.execPath, viaCmd: false };
let dir: string;
let logFile: string;
const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-agy-cwd-"));
afterAll(() => {
  try {
    fs.rmSync(cwdDir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  } catch {
    // harmless
  }
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-agy-"));
  logFile = path.join(dir, "log.jsonl");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({ provider: "gemini", model: null, effort: null, history: [], text: "Hej", cwd: cwdDir, ...over });
const env = (extra: Record<string, string> = {}) => ({
  ...process.env, FAKE_LOG: logFile, GEMINI_API_KEY: "should-not-pass", GOOGLE_API_KEY: "should-not-pass", AGY_ADC_AUTH: "1", AGY_LLM_GATEWAY_MODELS: "x", GOOGLE_CLOUD_PROJECT: "p", ...extra,
});
const gemini = (extra: Record<string, string> = {}, more: Partial<ConstructorParameters<typeof GeminiAdapter>[0]> = {}) =>
  new GeminiAdapter({ find: () => node, prefixArgs: [path.join(fixtures, "fake-agy.mjs")], env: env(extra), cacheMs: 0, ...more });
const calls = () => fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
async function collect(handle: ChatHandle): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}
const deltas = (events: ChatEvent[]) => events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");

describe("Antigravity CLI as Gemini", () => {
  it("answers through agy's stream, with usage, and sends the prompt on stdin, never on the command line", async () => {
    const events = await collect(gemini().chat(request({ text: "Vad är fotosyntes?" })));
    expect(events[0]).toEqual({ type: "started", model: null });
    expect(deltas(events).trim()).toBe("Hej från Gemini");
    expect(events.at(-1)).toMatchObject({ type: "completed", text: "Hej från Gemini", usage: { inputTokens: 10489, outputTokens: 33, cachedInputTokens: 100 } });
    const chat = calls().find((c) => c.args.includes("--print"))!;
    expect(chat.input).toContain("Vad är fotosyntes?");
    expect(chat.args).toEqual(["--print", "--output-format", "stream-json", "--mode", "default"]);
    expect(JSON.stringify(chat.args)).not.toContain("fotosyntes");
    expect(geminiArgs("gemini-4-neon-high")).toEqual(["--print", "--output-format", "stream-json", "--mode", "default", "--model", "gemini-4-neon-high"]);
    expect(geminiArgs("default")).not.toContain("--model");
  });

  it("never lets an API key, Application Default Credentials or a gateway reach agy", async () => {
    await collect(gemini().chat(request()));
    for (const c of calls()) {
      expect(c.geminiKeyReached).toBe(false);
      expect(c.adcReached).toBe(false);
      expect(c.googleReached).toBe(false);
    }
    expect(providerEnv({ AGY_ADC_AUTH: "1", AGY_LLM_GATEWAY_MODELS: "m", GEMINI_API_KEY: "k", GOOGLE_GEMINI_BASE_URL: "u", AGY_CLI_HIDE_LOGO: "1", HOME: "/h" })).toEqual({ AGY_CLI_HIDE_LOGO: "1", HOME: "/h" });
  });

  it("proves a Google account sign-in with /usage before it sends anything, and refuses an API key or no sign-in", async () => {
    await collect(gemini().chat(request()));
    expect(calls()[0]!.args).toEqual(["-p", "/usage", "--output-format", "json"]);
    const signedOut = await collect(gemini({ FAKE_AUTH: "signed-out" }).chat(request()));
    expect(signedOut.at(-1)).toMatchObject({ type: "failed", reason: "not_signed_in" });
    const key = await collect(gemini({ FAKE_AUTH: "apikey" }).chat(request()));
    expect(key.at(-1)).toMatchObject({ type: "failed", reason: "not_subscription" });
    expect(deltas(key)).toBe("");
  });

  it("reports the status with the plan's real limits and the models agy lists", async () => {
    const status = await gemini().status();
    expect(status).toMatchObject({ provider: "gemini", name: "Gemini", installed: true, version: "1.5.18", signedIn: true, subscription: true, problem: null });
    expect(status.limits).toEqual([
      { label: "7-day limit", usedPercent: 1, windowMinutes: 10080, resetsAt: 1796330313 },
      { label: "5-hour limit", usedPercent: 1, windowMinutes: 300, resetsAt: 1795743513 },
    ]);
    expect(status.models.map((m) => m.id)).toEqual(["default", "gemini-4-neon-high", "gemini-4-carbon-high", "gemini-3-8-flash"]);
    expect(await gemini({ FAKE_AUTH: "signed-out" }).status()).toMatchObject({ installed: true, signedIn: false, subscription: false, limits: [] });
    expect((await gemini({ FAKE_AUTH: "apikey" }).status()).problem).toMatch(/API key/);
    expect(await new GeminiAdapter({ find: () => null, env: env() }).status()).toMatchObject({ installed: false, problem: "Antigravity CLI (agy) is not installed." });
  });

  it("ends the run, naming the tool, the moment agy tries a tool instead of answering", async () => {
    const events = await collect(gemini({ FAKE_MODE: "tool" }).chat(request()));
    expect(events.at(-1)).toMatchObject({ type: "failed", reason: "provider_error" });
    expect((events.at(-1) as { message: string }).message).toMatch(/tool \("run_command"\).*Nothing was changed/);
  });

  it("refuses to run when agy starts in a mode that does not ask before changing things", async () => {
    for (const perm of ["auto", "accept-edits", "", "bypass"]) {
      const events = await collect(gemini({ FAKE_PERM: perm }).chat(request()));
      expect(events.at(-1)).toMatchObject({ type: "failed", reason: "not_subscription" });
      expect(deltas(events)).toBe("");
    }
    expect([...SAFE_MODES].sort()).toEqual(["plan", "request-review"]);
  });

  it("sorts failures: usage limit, crash; and stops on request and when the answer goes silent", async () => {
    expect((await collect(gemini({ FAKE_MODE: "quota" }).chat(request()))).at(-1)).toMatchObject({ type: "failed", reason: "usage_limit" });
    expect((await collect(gemini({ FAKE_MODE: "crash" }).chat(request()))).at(-1)).toMatchObject({ type: "failed", reason: "crashed" });
    expect(classifyFailure("RESOURCE_EXHAUSTED · You have exhausted your quota", null).reason).toBe("usage_limit");
    expect(classifyFailure("UNAUTHENTICATED", null).reason).toBe("not_signed_in");
    const handle = gemini({ FAKE_MODE: "stall" }).chat(request());
    const seen: ChatEvent[] = [];
    for await (const e of handle.events) { seen.push(e); if (e.type === "delta") handle.stop(); }
    expect(seen.at(-1)).toMatchObject({ type: "cancelled" });
    const quiet = await collect(gemini({ FAKE_MODE: "stall" }, { idleMs: 300 }).chat(request()));
    expect(quiet.at(-1)).toMatchObject({ type: "failed", reason: "provider_error" });
  });

  it("takes the answer from the result when no text came in the stream", async () => {
    const events = await collect(gemini({ FAKE_MODE: "no-deltas" }).chat(request()));
    expect(events.at(-1)).toMatchObject({ type: "completed", text: "Hej från Gemini" });
  });

  it("puts text files in the message and refuses pictures and PDFs, which agy could only read with a tool", async () => {
    const txt = path.join(dir, "notes.txt");
    fs.writeFileSync(txt, "mina anteckningar");
    await collect(gemini().chat(request({ text: "Sammanfatta", attachments: [{ id: "b".repeat(24), name: "notes.txt", kind: "text", mediaType: "text/plain", size: 17, path: txt }] })));
    expect(calls().find((c) => c.args.includes("--print"))!.input).toContain("mina anteckningar");
    const pic = await collect(gemini().chat(request({ attachments: [{ id: "a".repeat(24), name: "p.png", kind: "image", mediaType: "image/png", size: 4, path: txt }] })));
    expect(pic.at(-1)).toMatchObject({ type: "failed", message: expect.stringMatching(/pictures or PDFs/) });
  });

  it("reads usage, limits and model lists from agy's own output", async () => {
    expect(geminiUsage({ input_tokens: 10489, output_tokens: 33, thinking_tokens: 31, cache_read_tokens: 0 })).toEqual({ inputTokens: 10489, outputTokens: 33, cachedInputTokens: 0 });
    expect(geminiUsage({})).toBeNull();
    expect(geminiLimits({})).toEqual([]);
    expect(geminiLimits({ command: { data: { groups: [{ name: "Claude and GPT models", buckets: [{ window: "5h", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" }] }] } } })).toEqual([]);
    // The text form of `/model` (id, tab, label) and a JSON list both work; junk gives nothing.
    expect(parseModels('{"response":"gemini-4-neon-high\\tGemini 4 Neon (High)\\n","command":{"data":{"id":"gemini-4-neon-high","label":"Gemini 4 Neon (High)"}}}').map((m) => m.id)).toEqual(["gemini-4-neon-high"]);
    expect(parseModels("gemini-4-argon-low\tGemini 4 Argon (Low)\nnot a model line").map((m) => m.label)).toEqual(["Gemini 4 Argon (Low)"]);
    expect(parseModels("<html>")).toEqual([]);
  });

  it("answers as 'not available' when the adapter is missing", async () => {
    const missing = adapterOf({ claude: {} as never, codex: {} as never }, "gemini");
    expect((await missing.status()).installed).toBe(false);
    expect((await collect(missing.chat(request()))).at(-1)).toMatchObject({ type: "failed", reason: "not_installed" });
  });
});
