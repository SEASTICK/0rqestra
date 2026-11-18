import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { EventQueue, type ChatEvent, type ChatRequest, type ProviderAdapter, type ProviderId, type ProviderStatus } from "../providers/types.js";
import { AccountsService, installAdvice, POLL_MS, setupState, SIGN_IN_WAIT_MS, TEST_PROMPT, type AccountView, type TerminalRequest } from "./accounts-service.js";
import { officialCommands } from "./commands.js";
import { encodePowerShell, terminalScript, windowsTerminalArgs } from "./terminal.js";

const status = (provider: ProviderId, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  provider, name: provider === "claude" ? "Claude Code" : "Codex", installed: false, version: null, signedIn: false, plan: null,
  subscription: false, models: [], limits: [], problem: null, ...over,
});
const SIGNED_OUT = { installed: true, version: "2.1.400", binaryPath: "C:\\Users\\Min Dator\\.local\\bin\\claude.exe", source: "native" };
const SUBSCRIPTION = { ...SIGNED_OUT, signedIn: true, subscription: true, authMethod: "subscription" as const, plan: "max" };
const API_KEY = { ...SIGNED_OUT, signedIn: true, subscription: false, authMethod: "api_key" as const };

class FakeAdapter implements ProviderAdapter {
  current: ProviderStatus;
  checks = 0;
  requests: ChatRequest[] = [];
  answer: ChatEvent[] = [{ type: "started", model: "claude-test" }, { type: "completed", text: "The connection works.", usage: null, limits: [] }];
  constructor(readonly id: ProviderId, over: Partial<ProviderStatus> = {}) {
    this.current = status(id, over);
  }
  async status() {
    this.checks += 1;
    return { ...this.current };
  }
  chat(request: ChatRequest) {
    this.requests.push(request);
    const queue = new EventQueue<ChatEvent>();
    for (const e of this.answer) queue.push(e);
    queue.end();
    return { events: queue, stop: () => queue.end() };
  }
}

// Timers that run only when the test says so.
function manualTimers() {
  let now = 1_000_000;
  const pending: { at: number; fn: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, cancelled: false };
      pending.push(t);
      return { cancel: () => { t.cancelled = true; } };
    },
    async advance(ms: number) {
      now += ms;
      for (const t of pending.filter((p) => !p.cancelled && p.at <= now)) {
        t.cancelled = true;
        t.fn();
      }
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    },
  };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function setup(over: { claude?: Partial<ProviderStatus>; codex?: Partial<ProviderStatus>; terminal?: boolean } = {}) {
  const timers = manualTimers();
  const adapters = { claude: new FakeAdapter("claude", over.claude), codex: new FakeAdapter("codex", over.codex) };
  const emitted: AccountView[][] = [];
  const terminals: TerminalRequest[] = [];
  const installers: ReturnType<typeof fakeChild>[] = [];
  const killed: unknown[] = [];
  let pathReads = 0;
  let invalidated = 0;
  const service = new AccountsService({
    adapters,
    refreshPath: async () => { pathReads += 1; },
    invalidate: () => { invalidated += 1; },
    startInstaller: () => {
      const child = fakeChild();
      installers.push(child);
      return child as unknown as ChildProcess;
    },
    openTerminal: over.terminal === false ? null : (request) => { terminals.push(request); return true; },
    cwd: () => "C:\\work",
    emit: (accounts) => emitted.push(accounts),
    platform: "win32",
    now: timers.now,
    setTimer: timers.setTimer,
    killTree: (child) => { killed.push(child); (child as unknown as EventEmitter).emit("close", null); },
  });
  const card = (id: ProviderId) => service.view().find((a) => a.provider === id)!;
  return { service, adapters, timers, emitted, terminals, installers, killed, card, pathReads: () => pathReads, invalidated: () => invalidated };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

describe("setup states", () => {
  it("shows four states and tells a subscription apart from an API key", () => {
    expect(setupState(status("claude"), null)).toBe("missing");
    expect(setupState(status("claude", SIGNED_OUT), null)).toBe("signed_out");
    expect(setupState(status("claude", SUBSCRIPTION), null)).toBe("signed_in");
    expect(setupState(status("claude", API_KEY), null)).toBe("api_key");
    expect(setupState(status("claude", { ...SIGNED_OUT, checkFailed: true }), null)).toBe("failed");
    const failedTest = { ok: false, at: 0, text: "", model: null, message: "boom", reason: "provider_error" as const };
    expect(setupState(status("claude", SUBSCRIPTION), failedTest)).toBe("failed");
  });

  it("labels the cards and reads the PATH again on every check", async () => {
    const t = setup({ claude: SUBSCRIPTION });
    const view = await t.service.refresh();
    expect(view.map((a) => a.label)).toEqual(["Claude via Claude Code", "ChatGPT via Codex"]);
    expect(view.map((a) => a.setup)).toEqual(["signed_in", "missing"]);
    expect(t.pathReads()).toBe(1);
    expect(t.invalidated()).toBe(1);
  });

  it("rejects unknown providers and commands from the window", async () => {
    const t = setup();
    expect(() => t.service.install("bash")).toThrow("Unknown provider.");
    expect(() => t.service.openTerminal("claude", "rm -rf")).toThrow("Unknown command.");
    expect(() => t.service.signIn({ provider: "claude" })).toThrow("Unknown provider.");
    await expect(t.service.test("../x")).rejects.toThrow("Unknown provider.");
  });
});

describe("installing", () => {
  it("runs the official installer, shows its output, and checks again with a fresh PATH when it ends", async () => {
    const t = setup();
    await t.service.refresh();
    expect(t.service.install("claude")).toBe(true);
    expect(t.card("claude").activity?.kind).toBe("installing");
    t.installers[0]!.stderr.write("#< CLIXML\r\n<Objs Version=\"1.1.0.1\"><Obj S=\"progress\"/></Objs>\r\n");
    t.installers[0]!.stdout.write("Setting up Claude Code...\r\n\u001b[32m✔\u001b[0m Installation complete!\n");
    await flush();
    expect(t.card("claude").activity?.log).toEqual(["Setting up Claude Code...", "✔ Installation complete!"]);
    t.adapters.claude.current = status("claude", SIGNED_OUT);
    const readsBefore = t.pathReads();
    t.installers[0]!.emit("close", 0);
    await flush();
    expect(t.pathReads()).toBe(readsBefore + 1);
    expect(t.card("claude")).toMatchObject({ setup: "signed_out", activity: null, error: null });
    expect(() => t.service.install("claude")).toThrow("already installed");
  });

  it("explains a failed installation and offers what to do", async () => {
    const t = setup();
    t.service.install("codex");
    t.installers[0]!.stderr.write("irm : The remote name could not be resolved: 'chatgpt.com'\n");
    t.installers[0]!.emit("close", 1);
    await flush();
    const card = t.card("codex");
    expect(card.setup).toBe("missing");
    expect(card.error?.message).toContain("could not be resolved");
    expect(card.error?.advice).toContain("internet connection");
    expect(card.commands.install).toBe('powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"');
  });

  it("says so when the installer succeeds but the tool still cannot be found", async () => {
    const t = setup();
    t.service.install("claude");
    t.installers[0]!.emit("close", 0);
    await flush();
    expect(t.card("claude").error?.message).toContain("cannot find Claude Code yet");
  });

  it("stops an installer that the user cancels", async () => {
    const t = setup();
    t.service.install("claude");
    expect(t.service.cancel("claude")).toBe(true);
    await flush();
    expect(t.killed.length).toBe(1);
    expect(t.card("claude")).toMatchObject({ activity: null, error: { message: "The installation was stopped." } });
  });

  it("opens a terminal with the official command filled in, then notices the install by itself", async () => {
    const t = setup();
    t.service.openTerminal("codex", "install");
    expect(t.terminals[0]).toMatchObject({ command: "irm https://chatgpt.com/codex/install.ps1 | iex", confirm: true });
    expect(t.card("codex").activity?.kind).toBe("waiting_install");
    await t.timers.advance(POLL_MS);
    expect(t.card("codex").activity?.kind).toBe("waiting_install");
    t.adapters.codex.current = status("codex", { installed: true, version: "0.170.0", binaryPath: "C:\\x\\codex.exe", source: "native" });
    await t.timers.advance(POLL_MS);
    expect(t.card("codex")).toMatchObject({ setup: "signed_out", activity: null });
  });
});

describe("signing in", () => {
  it("opens the provider's own sign-in and follows the state from signed out to signed in", async () => {
    const t = setup({ claude: SIGNED_OUT });
    await t.service.refresh();
    expect(t.card("claude").setup).toBe("signed_out");
    t.service.signIn("claude");
    expect(t.terminals[0]!.command).toBe("& 'C:\\Users\\Min Dator\\.local\\bin\\claude.exe' auth login");
    expect(t.terminals[0]!.confirm).toBe(false);
    expect(t.card("claude").activity?.kind).toBe("waiting_sign_in");
    await t.timers.advance(POLL_MS);
    expect(t.card("claude").setup).toBe("signed_out");
    t.adapters.claude.current = status("claude", SUBSCRIPTION);
    await t.timers.advance(POLL_MS);
    expect(t.card("claude")).toMatchObject({ setup: "signed_in", activity: null, plan: "max", authMethod: "subscription" });
  });

  it("shows an API-key sign-in as its own state, and never treats it as connected", async () => {
    const t = setup({ codex: { ...SIGNED_OUT, binaryPath: "C:\\x\\codex.exe" } });
    await t.service.refresh();
    t.service.signIn("codex");
    expect(t.terminals[0]!.command).toBe("& 'C:\\x\\codex.exe' login");
    t.adapters.codex.current = status("codex", { ...API_KEY, binaryPath: "C:\\x\\codex.exe" });
    await t.timers.advance(POLL_MS);
    expect(t.card("codex")).toMatchObject({ setup: "api_key", authMethod: "api_key", subscription: false, activity: null });
  });

  it("stops waiting after ten minutes and says what to do", async () => {
    const t = setup({ claude: SIGNED_OUT });
    await t.service.refresh();
    t.service.signIn("claude");
    for (let waited = 0; waited <= SIGN_IN_WAIT_MS; waited += POLL_MS) await t.timers.advance(POLL_MS);
    expect(t.card("claude")).toMatchObject({ setup: "signed_out", activity: null, error: { message: "No sign-in was seen within 10 minutes." } });
  });

  it("keeps the copy fallback when no terminal can be opened", async () => {
    const t = setup({ claude: SIGNED_OUT, terminal: false });
    await t.service.refresh();
    expect(t.service.signIn("claude")).toBe(false);
    expect(t.card("claude")).toMatchObject({ canOpenTerminal: false, error: { message: "0rqestra could not open a terminal window here." } });
    expect(t.card("claude").commands.signIn).toBe("& 'C:\\Users\\Min Dator\\.local\\bin\\claude.exe' auth login");
  });

  it("needs the tool installed before signing in", () => {
    const t = setup();
    expect(() => t.service.signIn("claude")).toThrow("Install the tool first.");
  });
});

describe("testing the connection", () => {
  it("sends one short request and remembers a success", async () => {
    const t = setup({ claude: SUBSCRIPTION });
    await t.service.refresh();
    const result = await t.service.test("claude");
    expect(result).toMatchObject({ ok: true, text: "The connection works.", model: "claude-test" });
    expect(t.adapters.claude.requests[0]).toMatchObject({ provider: "claude", text: TEST_PROMPT, raw: true, history: [], cwd: "C:\\work" });
    expect(t.card("claude")).toMatchObject({ setup: "signed_in", lastTest: { ok: true } });
  });

  it("shows a failed connection, and clears it when the sign-in changes", async () => {
    const t = setup({ codex: SUBSCRIPTION });
    await t.service.refresh();
    t.adapters.codex.answer = [{ type: "failed", reason: "usage_limit", message: "The ChatGPT plan's usage limit is reached.", text: "" }];
    await t.service.test("codex");
    expect(t.card("codex")).toMatchObject({ setup: "failed", lastTest: { ok: false, reason: "usage_limit" } });
    t.adapters.codex.current = status("codex", SIGNED_OUT);
    await t.service.refresh();
    expect(t.card("codex")).toMatchObject({ setup: "signed_out", lastTest: null });
  });

  it("goes back to signed out when the test finds the sign-in gone", async () => {
    const t = setup({ claude: SUBSCRIPTION });
    await t.service.refresh();
    t.adapters.claude.current = status("claude", SIGNED_OUT);
    t.adapters.claude.answer = [{ type: "failed", reason: "not_signed_in", message: "Claude Code is not signed in.", text: "" }];
    await t.service.test("claude");
    expect(t.card("claude")).toMatchObject({ setup: "signed_out", lastTest: null });
  });
});

describe("official commands and the terminal", () => {
  it("uses the providers' documented commands", () => {
    expect(officialCommands("claude", "win32", null, null)).toMatchObject({ install: "irm https://claude.ai/install.ps1 | iex", signIn: "claude auth login" });
    expect(officialCommands("codex", "darwin", "/Users/a/.local/bin/codex", "path")).toMatchObject({
      install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", signIn: "codex login", terminalSignIn: "'/Users/a/.local/bin/codex' login",
    });
    expect(officialCommands("claude", "linux", null, null).install).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(officialCommands("claude", "win32", "C:\\O'Brien\\claude.exe", "native").signIn).toBe("& 'C:\\O''Brien\\claude.exe' auth login");
  });

  it("builds a terminal window that shows the command before it runs it", () => {
    const request = { title: "0rqestra: install Codex", intro: ["Official installer:"], command: "irm https://chatgpt.com/codex/install.ps1 | iex", confirm: true };
    const script = terminalScript(request);
    expect(script).toContain("Write-Host '  irm https://chatgpt.com/codex/install.ps1 | iex' -ForegroundColor Cyan");
    expect(script.indexOf("Read-Host")).toBeLessThan(script.lastIndexOf("irm https://chatgpt.com/codex/install.ps1 | iex\n"));
    const args = windowsTerminalArgs(request, { SystemRoot: "C:\\Windows" });
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(args[3]).toMatch(/^"start "0rqestra" "C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+"$/);
    expect(Buffer.from(encodePowerShell(script), "base64").toString("utf16le")).toBe(script);
  });

  it("gives advice that matches the installer's error", () => {
    expect(installAdvice("running scripts is disabled on this system", 1)).toContain("PowerShell blocked");
    expect(installAdvice("The process cannot access the file because it is being used by another process", 1)).toContain("Close any open");
    expect(installAdvice("", null, true)).toContain("10 minutes");
    expect(installAdvice("something else", 3)).toContain("exit code 3");
  });
});
