import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyFailure, GEMINI_MODELS, geminiArgs, GeminiAdapter, geminiSettings, geminiSignedIn, geminiUsage } from "./gemini.js";
import { providerEnv } from "./process.js";
import type { ChatEvent, ChatHandle, ChatRequest } from "./types.js";
import { adapterOf } from "./types.js";

const fixtures = path.join(__dirname, "test-fixtures");
const node = { path: process.execPath, viaCmd: false };
let dir: string;
let home: string;
let logFile: string;
const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-gemini-cwd-"));
afterAll(() => {
  try {
    fs.rmSync(cwdDir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  } catch {
    // harmless
  }
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-gemini-"));
  home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "oauth_creds.json"), JSON.stringify({ access_token: "a", refresh_token: "r" }));
  logFile = path.join(dir, "log.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({ provider: "gemini", model: null, effort: null, history: [], text: "Hej", cwd: cwdDir, ...over });
const env = (extra: Record<string, string> = {}) => ({
  ...process.env, FAKE_LOG: logFile, GEMINI_API_KEY: "should-not-pass", GOOGLE_API_KEY: "should-not-pass", GOOGLE_GENAI_USE_VERTEXAI: "true", ...extra,
});
const gemini = (extra: Record<string, string> = {}, more: Partial<ConstructorParameters<typeof GeminiAdapter>[0]> = {}) =>
  new GeminiAdapter({ find: () => node, prefixArgs: [path.join(fixtures, "fake-gemini-chat.mjs")], env: env(extra), settingsDir: path.join(dir, "settings"), home, ...more });
const readLog = () => JSON.parse(fs.readFileSync(logFile, "utf8"));
async function collect(handle: ChatHandle): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}
const deltas = (events: ChatEvent[]) => events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");

describe("Gemini CLI", () => {
  it("answers through the CLI's stream, with usage, and sends the prompt on stdin", async () => {
    const events = await collect(gemini().chat(request({ text: "Vad är fotosyntes?", model: "flash" })));
    expect(events[0]).toEqual({ type: "started", model: null });
    expect(deltas(events)).toBe("Hej från Gemini");
    expect(events.at(-1)).toMatchObject({ type: "completed", text: "Hej från Gemini", usage: { inputTokens: 30, outputTokens: 10, cachedInputTokens: 5 }, limits: [] });
    const log = readLog();
    expect(log.input).toContain("Vad är fotosyntes?");
    expect(log.args).toEqual(expect.arrayContaining(["-p", "Reply to the message above.", "-o", "stream-json", "--skip-trust", "-e", "none", "-m", "flash"]));
    // The prompt is never an argument.
    expect(JSON.stringify(log.args)).not.toContain("fotosyntes");
  });

  it("uses no model flag for the default, and refuses unknown or unsafe names", async () => {
    await collect(gemini().chat(request({ model: "default" })));
    expect(readLog().args).not.toContain("-m");
    expect(geminiArgs("pro")).toContain("pro");
    const bad = await collect(gemini().chat(request({ model: "pro; rm -rf" })));
    expect(bad.at(-1)).toMatchObject({ type: "failed", reason: "provider_error" });
    const odd = await collect(gemini().chat(request({ model: "gpt-5" })));
    expect(odd.at(-1)).toMatchObject({ type: "failed", message: "Unknown Gemini model." });
  });

  it("never lets an API key or another sign-in reach the CLI, and forces the Google login with every tool off", async () => {
    await collect(gemini().chat(request()));
    const log = readLog();
    expect(log.geminiKeyReached).toBe(false);
    expect(log.googleKeyReached).toBe(false);
    expect(log.genaiReached).toBe(false);
    expect(log.settings.security.auth).toEqual({ selectedType: "oauth-personal", enforcedType: "oauth-personal" });
    expect(log.settings.tools.core).toEqual([]);
    expect(log.settings.mcp.allowed).toEqual(["orqestra-none"]);
    expect(log.settings.hooksConfig.enabled).toBe(false);
    expect(providerEnv({ GOOGLE_GENAI_USE_GCA: "true", GOOGLE_CLOUD_PROJECT: "p", GEMINI_API_KEY: "k", GOOGLE_GEMINI_BASE_URL: "u", CLOUD_SHELL: "true", HOME: "/h" })).toEqual({ HOME: "/h" });
  });

  it("does not send anything when it is not signed in with a Google account", async () => {
    fs.rmSync(path.join(home, ".gemini", "oauth_creds.json"));
    const events = await collect(gemini().chat(request()));
    expect(events.at(-1)).toMatchObject({ type: "failed", reason: "not_signed_in" });
    expect(fs.existsSync(logFile)).toBe(false);
    expect(geminiSignedIn(home)).toBe(false);
  });

  it("fails closed when the CLI does not accept the settings file (folder permissions)", async () => {
    const events = await collect(gemini({ FAKE_INSECURE: "1" }).chat(request()));
    expect(events.at(-1)).toMatchObject({ type: "failed", reason: "not_subscription" });
    expect(deltas(events)).toBe("");
    const status = await gemini({ FAKE_INSECURE: "1" }).status();
    expect(status).toMatchObject({ installed: true, signedIn: true, subscription: false });
    expect(status.problem).toMatch(/refused/);
  });

  it("reports the status: version, Google account sign-in, models", async () => {
    const status = await gemini().status();
    expect(status).toMatchObject({ provider: "gemini", name: "Gemini CLI", installed: true, version: "9.9.9", signedIn: true, subscription: true, plan: null, problem: null });
    expect(status.models.map((m) => m.id)).toEqual(["default", "pro", "flash", "flash-lite"]);
    expect(GEMINI_MODELS.filter((m) => m.isDefault)).toHaveLength(1);
    fs.rmSync(path.join(home, ".gemini", "oauth_creds.json"));
    expect(await gemini().status()).toMatchObject({ signedIn: false, subscription: false });
    expect(await new GeminiAdapter({ find: () => null, env: env(), home }).status()).toMatchObject({ installed: false, problem: "Gemini CLI is not installed." });
  });

  it("sorts failures: signed-out CLI, usage limit, other errors, crashes", async () => {
    expect((await collect(gemini({ FAKE_MODE: "auth" }).chat(request()))).at(-1)).toMatchObject({ type: "failed", reason: "not_signed_in" });
    expect((await collect(gemini({ FAKE_MODE: "quota" }).chat(request()))).at(-1)).toMatchObject({ type: "failed", reason: "usage_limit" });
    expect((await collect(gemini({ FAKE_MODE: "error-result" }).chat(request()))).at(-1)).toMatchObject({ type: "failed", reason: "provider_error", message: "The model failed." });
    expect((await collect(gemini({ FAKE_MODE: "crash" }).chat(request()))).at(-1)).toMatchObject({ type: "failed", reason: "crashed" });
    expect(classifyFailure("HTTP 429 too many requests", null).reason).toBe("usage_limit");
    expect(classifyFailure("anything", 41).reason).toBe("not_signed_in");
  });

  it("stops on request and when the answer goes silent", async () => {
    const handle = gemini({ FAKE_MODE: "stall" }).chat(request());
    const seen: ChatEvent[] = [];
    const run = (async () => { for await (const e of handle.events) { seen.push(e); if (e.type === "delta") handle.stop(); } })();
    await run;
    expect(seen.at(-1)).toMatchObject({ type: "cancelled" });
    const quiet = await collect(gemini({ FAKE_MODE: "stall" }, { idleMs: 300 }).chat(request()));
    expect(quiet.at(-1)).toMatchObject({ type: "failed", reason: "provider_error" });
  });

  it("puts text files in the message and copies pictures next to the chat for the CLI's @ syntax, then removes them", async () => {
    const png = path.join(dir, "pic.png");
    const txt = path.join(dir, "notes.txt");
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(txt, "mina anteckningar");
    const before = fs.readdirSync(cwdDir).length;
    await collect(gemini().chat(request({ text: "Vad visar bilden?", attachments: [
      { id: "a".repeat(24), name: "pic.png", kind: "image", mediaType: "image/png", size: 4, path: png },
      { id: "b".repeat(24), name: "notes.txt", kind: "text", mediaType: "text/plain", size: 17, path: txt },
    ] })));
    const log = readLog();
    expect(log.input).toContain("mina anteckningar");
    expect(log.input).toMatch(/@attached-[a-z0-9-]+\/file1\.png/);
    // The file reader is only on when a picture or PDF is attached.
    expect(log.settings.tools.core).toEqual(["read_file"]);
    expect(fs.readdirSync(cwdDir).length).toBe(before);
    expect(JSON.parse(geminiSettings(false)).tools.core).toEqual([]);
  });

  it("turns the final stats into usage, and a missing Gemini adapter into 'not available'", async () => {
    expect(geminiUsage({ input_tokens: 100, output_tokens: 7, cached: 40 })).toEqual({ inputTokens: 100, outputTokens: 7, cachedInputTokens: 40 });
    expect(geminiUsage({})).toBeNull();
    const missing = adapterOf({ claude: {} as never, codex: {} as never }, "gemini");
    expect((await missing.status()).installed).toBe(false);
    expect((await collect(missing.chat(request()))).at(-1)).toMatchObject({ type: "failed", reason: "not_installed" });
  });
});
