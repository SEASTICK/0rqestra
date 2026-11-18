import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, claudeArgs, isClaudeSubscription } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { buildPrompt, MAX_HISTORY_CHARS } from "./history.js";
import { findBinary, providerEnv, SAFE_ARG } from "./process.js";
import type { ChatEvent, ChatHandle, ChatRequest } from "./types.js";

const fixtures = path.join(__dirname, "test-fixtures");
const node = { path: process.execPath, viaCmd: false };
let dir: string;
let logFile: string;
// The tools' working directory. On Windows a folder cannot be removed while a process that has just
// answered is still closing inside it, so this one is shared and removed after all tests.
const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-chat-cwd-"));
afterAll(() => {
  try {
    fs.rmSync(cwdDir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  } catch {
    // A leftover empty temporary folder is harmless.
  }
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-providers-"));
  logFile = path.join(dir, "log.json");
});
// On Windows a tool that has just answered can still be closing with this folder as its working
// directory for a moment, and the folder cannot be removed until it has gone. Node retries EPERM.
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: "claude", model: null, effort: null, history: [], text: "Hej", cwd: cwdDir, ...over,
});

const env = (extra: Record<string, string>) => ({
  ...process.env, FAKE_LOG: logFile, ANTHROPIC_API_KEY: "sk-ant-should-not-pass", OPENAI_API_KEY: "sk-should-not-pass", ...extra,
});

async function collect(handle: ChatHandle, onEvent?: (event: ChatEvent) => void): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

const claude = (extra: Record<string, string>, more: Partial<ConstructorParameters<typeof ClaudeCodeAdapter>[0]> = {}) =>
  new ClaudeCodeAdapter({ find: () => node, prefixArgs: [path.join(fixtures, "fake-claude-chat.mjs")], env: env(extra), settingsDir: dir, ...more });
const codex = (extra: Record<string, string>, more: Partial<ConstructorParameters<typeof CodexAdapter>[0]> = {}) =>
  new CodexAdapter({ find: () => node, prefixArgs: [path.join(fixtures, "fake-codex-chat.mjs")], env: env(extra), ...more });
const readLog = () => JSON.parse(fs.readFileSync(logFile, "utf8"));
const deltas = (events: ChatEvent[]) => events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");

describe("provider environment", () => {
  it("removes API keys and Electron variables, keeps the rest", () => {
    const out = providerEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "x", GEMINI_API_KEY: "x", CODEX_API_KEY: "x",
      CLAUDE_CODE_USE_BEDROCK: "1", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--x", AWS_SECRET_ACCESS_KEY: "x", LANG: "sv_SE" });
    expect(out).toEqual({ PATH: "/bin", HOME: "/h", LANG: "sv_SE" });
  });

  it("finds a tool on PATH, prefers an override, and accepts only safe cmd.exe arguments", () => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude"), "");
    expect(findBinary("claude", { PATH: bin, HOME: dir }, "linux")).toEqual({ path: path.join(bin, "claude"), viaCmd: false, source: "path" });
    expect(findBinary("codex", { PATH: bin, HOME: dir }, "linux")).toBeNull();
    fs.writeFileSync(path.join(bin, "codex.cmd"), "");
    expect(findBinary("codex", { PATH: bin, USERPROFILE: dir, LOCALAPPDATA: dir, APPDATA: dir }, "win32")).toEqual({ path: path.join(bin, "codex.cmd"), viaCmd: true, source: "path" });
    expect(findBinary("codex", { PATH: "", ORQESTRA_CODEX_BIN: path.join(bin, "claude") }, "linux")?.path).toBe(path.join(bin, "claude"));
    for (const ok of ["--model", "mcp__*", "C:\\Users\\Sjöqvist\\AppData\\x.json", ""]) expect(SAFE_ARG.test(ok), ok).toBe(true);
    for (const bad of ["a&b", "%PATH%", "x|y", 'a"b', "^", "a!b", "<x>"]) expect(SAFE_ARG.test(bad), bad).toBe(false);
  });
});

describe("prompt", () => {
  it("includes recent turns oldest first and the new message last", () => {
    const prompt = buildPrompt([{ role: "user", text: "Q1" }, { role: "assistant", text: "A1" }], "Q2");
    expect(prompt.indexOf("User: Q1")).toBeLessThan(prompt.indexOf("Manager: A1"));
    expect(prompt.trim().endsWith("User: Q2")).toBe(true);
  });

  it("adds the team and the plan format only when the window sends a team", () => {
    expect(buildPrompt([], "hi")).not.toContain("<orqestra-plan>");
    const prompt = buildPrompt([], "build me an app", [{ name: "Code builder", role: "Builder", ready: true }, { name: "The architect", role: "Planner", ready: false }]);
    expect(prompt).toContain("<orqestra-plan>");
    expect(prompt).toContain("- Builder: Code builder (can work)");
    expect(prompt).toContain("Demo agents that cannot work yet: The architect (Planner).");
  });

  it("drops the oldest turns when the history is too long", () => {
    const long = "x".repeat(MAX_HISTORY_CHARS / 2);
    const prompt = buildPrompt([{ role: "user", text: `OLD ${long}` }, { role: "assistant", text: `MID ${long}` }, { role: "user", text: "NEW" }], "now");
    expect(prompt).not.toContain("OLD");
    expect(prompt).toContain("NEW");
  });
});

describe("Claude Code adapter", () => {
  it("uses the subscription check, the locked-down profile, and no API key", async () => {
    expect(isClaudeSubscription({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })).toBe(true);
    expect(isClaudeSubscription({ loggedIn: true, authMethod: "apiKey", apiProvider: "firstParty" })).toBe(false);
    const args = claudeArgs("settings.json", "opus");
    for (const flag of ["--safe-mode", "--strict-mcp-config", "--no-session-persistence"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
    expect(args.slice(-2)).toEqual(["--model", "opus"]);
    expect(claudeArgs("s", "default")).not.toContain("--model");
  });

  it("streams a reply and reports usage", async () => {
    const events = await collect(claude({}).chat(request({ model: "sonnet", history: [{ role: "user", text: "earlier" }] })));
    expect(events[0]).toEqual({ type: "started", model: "claude-test-model" });
    expect(deltas(events)).toBe("Hej där!");
    expect(events.at(-1)).toEqual({ type: "completed", text: "Hej där!", usage: { inputTokens: 12, outputTokens: 3 }, limits: [] });
    const log = readLog();
    expect(log.apiKeyReached).toBe(false);
    expect(log.openaiKeyReached).toBe(false);
    expect(log.prompt).toContain("User: earlier");
    expect(log.args).toContain("sonnet");
  });

  it("uses the final message when the tool sends no partial text", async () => {
    const events = await collect(claude({ FAKE_MODE: "no-deltas" }).chat(request()));
    expect(events.at(-1)).toMatchObject({ type: "completed", text: "Full answer" });
  });

  it("refuses to send anything without a subscription login", async () => {
    for (const [auth, reason] of [["apikey", "not_subscription"], ["signed-out", "not_signed_in"]] as const) {
      const events = await collect(claude({ FAKE_AUTH: auth }).chat(request()));
      expect(events).toEqual([expect.objectContaining({ type: "failed", reason })]);
      expect(fs.existsSync(logFile)).toBe(false);
    }
  });

  it("reports a usage limit and a crash", async () => {
    expect((await collect(claude({ FAKE_MODE: "error" }).chat(request()))).at(-1)).toMatchObject({ type: "failed", reason: "usage_limit" });
    const crash = (await collect(claude({ FAKE_MODE: "crash" }).chat(request()))).at(-1);
    expect(crash).toMatchObject({ type: "failed", reason: "crashed" });
    expect((crash as { message: string }).message).toContain("boom");
  });

  it("stops cleanly and keeps the text so far", async () => {
    const handle = claude({ FAKE_MODE: "slow" }).chat(request());
    const events = await collect(handle, (e) => { if (e.type === "delta" && e.text.startsWith("3")) handle.stop(); });
    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
    expect((events.at(-1) as { text: string }).text).toContain("1 2 3");
  });

  it("ends a tool that ignores the stop request", async () => {
    const handle = claude({ FAKE_MODE: "stubborn" }, { stopGraceMs: 200 }).chat(request());
    const events = await collect(handle, (e) => { if (e.type === "delta") handle.stop(); });
    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
  });

  it("rejects a model name that is not plain", async () => {
    const events = await collect(claude({}).chat(request({ model: "opus & calc" })));
    expect(events).toEqual([expect.objectContaining({ type: "failed", reason: "provider_error" })]);
  });

  it("reports its status", async () => {
    expect(await claude({}).status()).toMatchObject({ installed: true, version: "9.9.9", signedIn: true, plan: "max", subscription: true, problem: null });
    expect(await claude({ FAKE_AUTH: "apikey" }).status()).toMatchObject({ subscription: false, problem: expect.stringContaining("API key") });
    expect(await new ClaudeCodeAdapter({ find: () => null }).status()).toMatchObject({ installed: false });
  });

  it("tells signed out, subscription and API-key sign-ins apart, and reports a tool that does not start", async () => {
    expect(await claude({ FAKE_AUTH: "signed-out" }).status()).toMatchObject({ installed: true, signedIn: false, authMethod: null, checkFailed: false });
    expect(await claude({}).status()).toMatchObject({ signedIn: true, authMethod: "subscription", checkFailed: false });
    expect(await claude({ FAKE_AUTH: "apikey" }).status()).toMatchObject({ signedIn: true, subscription: false, authMethod: "api_key" });
    const broken = new ClaudeCodeAdapter({ find: () => ({ path: path.join(dir, "missing.exe"), viaCmd: false, source: "native" }), env: env({}), settingsDir: dir });
    expect(await broken.status()).toMatchObject({ installed: true, checkFailed: true, binaryPath: path.join(dir, "missing.exe"), source: "native" });
  });
});

describe("Codex adapter", () => {
  it("streams a reply with usage and limits, in a read-only thread that grants nothing", async () => {
    const events = await collect(codex({}).chat(request({ provider: "codex", model: "gpt-6.1-sol", effort: "high" })));
    expect(events[0]).toEqual({ type: "started", model: "gpt-6.1-sol" });
    expect(deltas(events)).toBe("Hello world");
    expect(events.at(-1)).toEqual({
      type: "completed", text: "Hello world", usage: { inputTokens: 100, outputTokens: 7 },
      limits: [{ label: "5-hour limit", usedPercent: 19, windowMinutes: 300 }],
    });
    const log = readLog();
    expect(log.thread).toMatchObject({ approvalPolicy: "never", sandbox: "read-only", ephemeral: true, model: "gpt-6.1-sol", cwd: cwdDir });
    expect(log.turn).toMatchObject({ threadId: "th-1", effort: "high" });
    expect(log.apiKeyReached).toBe(false);
  });

  it("uses the final message when no partial text arrives", async () => {
    const events = await collect(codex({ FAKE_MODE: "final-only" }).chat(request({ provider: "codex" })));
    expect(events.at(-1)).toMatchObject({ type: "completed", text: "Only the final text" });
  });

  it("declines any approval request", async () => {
    await collect(codex({ FAKE_MODE: "approval" }).chat(request({ provider: "codex" })));
    expect(readLog().approvalAnswer).toEqual({ decision: "decline" });
  });

  it("refuses to send anything without a ChatGPT plan", async () => {
    for (const [auth, reason] of [["apikey", "not_subscription"], ["none", "not_signed_in"]] as const) {
      const events = await collect(codex({ FAKE_AUTH: auth }).chat(request({ provider: "codex" })));
      expect(events.at(-1)).toMatchObject({ type: "failed", reason });
      expect(fs.existsSync(logFile)).toBe(false);
    }
  });

  it("reports the usage limit and a crash", async () => {
    expect((await collect(codex({ FAKE_MODE: "usage-limit" }).chat(request({ provider: "codex" })))).at(-1)).toMatchObject({ type: "failed", reason: "usage_limit" });
    expect((await collect(codex({ FAKE_MODE: "crash" }).chat(request({ provider: "codex" })))).at(-1)).toMatchObject({ type: "failed", reason: "crashed" });
  });

  it("stops with turn/interrupt", async () => {
    const handle = codex({ FAKE_MODE: "slow" }).chat(request({ provider: "codex" }));
    const events = await collect(handle, (e) => { if (e.type === "delta" && e.text.startsWith("3")) handle.stop(); });
    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
    expect((events.at(-1) as { text: string }).text).toContain("1 2 3");
  });

  it("reports status with models, efforts and limits, hiding hidden models", async () => {
    expect(await codex({}).status()).toMatchObject({
      installed: true, version: "9.9.9", signedIn: true, plan: "plus", subscription: true, problem: null,
      models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: ["low", "high"], isDefault: true }],
      limits: [{ label: "5-hour limit", usedPercent: 18, windowMinutes: 300 }, { label: "7-day limit", usedPercent: 3, windowMinutes: 10080 }],
    });
    expect(await codex({ FAKE_AUTH: "apikey" }).status()).toMatchObject({ subscription: false, problem: expect.stringContaining("API key") });
  });

  it("tells signed out, ChatGPT and API-key sign-ins apart", async () => {
    expect(await codex({ FAKE_AUTH: "none" }).status()).toMatchObject({ installed: true, signedIn: false, authMethod: null });
    expect(await codex({}).status()).toMatchObject({ signedIn: true, authMethod: "subscription" });
    expect(await codex({ FAKE_AUTH: "apikey" }).status()).toMatchObject({ signedIn: true, subscription: false, authMethod: "api_key" });
  });
});
