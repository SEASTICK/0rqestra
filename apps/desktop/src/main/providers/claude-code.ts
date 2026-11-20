import fs from "node:fs";
import { claudeUsage } from "./usage";
import os from "node:os";
import path from "node:path";
import { buildPrompt } from "./history";
import { findBinary, killTree, MODEL_NAME, onJsonLines, providerEnv, runShort, spawnTool, type ToolBinary } from "./process";
import { toolEnvironment } from "./tool-env";
import { withTextFiles, type Attachment } from "../attachments";
import { EventQueue, type AuthMethod, type ChatEvent, type ChatHandle, type ChatRequest, type ModelOption, type ProviderAdapter, type ProviderStatus, type RateLimit } from "./types";

// Claude Code, signed in with the user's own Claude subscription, run in print mode with streamed
// JSON. Launch profile A from docs/provider-integrations.md §1.4, probed on Windows with 2.1.325
// (docs/provider-runtime-results.md §3a): no hooks, no MCP servers, no tools, no subagents.

export interface ClaudeOptions {
  find?: () => ToolBinary | null;
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  settingsDir?: string;
  timeoutMs?: number;
  stopGraceMs?: number;
  // How long a reply may go silent once it has started, and how long after it wrote a tool call as
  // text (a stall seen on 2026-11-20), before it is ended as stalled.
  idleMs?: number;
  fakeToolIdleMs?: number;
}

// Claude Code given no tools can write a tool call as plain text, then stop sending anything
// without ending the reply (no "result" event). Seen on 2026-11-20 with a reviewer that wanted to
// open a file it was not given: `<invoke name="Bash">` repeated, then silence until the time limit.
export const FAKE_TOOL_CALL = /<invoke name=|<function_calls>|<\/invoke>/;

// Claude Code takes aliases that follow the newest model of each family; there is no list command.
export const CLAUDE_MODELS: ModelOption[] = [
  { id: "default", label: "Default", efforts: [], isDefault: true },
  { id: "opus", label: "Opus", efforts: [], isDefault: false },
  { id: "sonnet", label: "Sonnet", efforts: [], isDefault: false },
  { id: "haiku", label: "Haiku", efforts: [], isDefault: false },
];

interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string | null;
}

export function isClaudeSubscription(status: AuthStatus): boolean {
  return status.loggedIn === true && status.authMethod === "claude.ai" && (status.apiProvider ?? "firstParty") === "firstParty";
}

// authMethod from `claude auth status` is one of none, claude.ai, oauth_token, api_key,
// api_key_helper, or third_party (Claude Code CLI reference, checked 2026-11-18).
export function claudeAuthMethod(status: AuthStatus | null): AuthMethod | null {
  if (!status?.loggedIn) return null;
  if (isClaudeSubscription(status)) return "subscription";
  if (/^api_?key/i.test(status.authMethod ?? "")) return "api_key";
  return "other";
}

export function claudeArgs(settingsFile: string, model: string | null): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--safe-mode",
    "--setting-sources", "user",
    "--settings", settingsFile,
    "--strict-mcp-config",
    "--tools", "",
    "--disallowedTools", "Agent", "mcp__*",
    "--permission-mode", "default",
    "--permission-prompts", "none",
    "--max-turns", "1",
    "--no-session-persistence",
    ...(model && model !== "default" ? ["--model", model] : []),
  ];
}

// Claude Code reports the subscription's usage windows during a reply ("rate_limit_event"): the 5-hour
// session window and the weekly one, as a fraction used. Newer versions list every window, older ones
// only the window that limits right now. Unknown shapes give nothing rather than a wrong number.
const CLAUDE_WINDOWS: Record<string, { label: string; minutes: number }> = {
  five_hour: { label: "5-hour limit", minutes: 300 },
  seven_day: { label: "7-day limit", minutes: 7 * 1440 },
};

export function limitsFromClaude(info: unknown, known: Map<string, RateLimit> = new Map()): Map<string, RateLimit> {
  const next = new Map(known);
  if (!info || typeof info !== "object") return next;
  const record = (kind: string, raw: unknown) => {
    const w = CLAUDE_WINDOWS[kind];
    const v = raw as { utilization?: unknown; resetsAt?: unknown } | null;
    if (!w || !v || typeof v.utilization !== "number" || !Number.isFinite(v.utilization) || v.utilization < 0) return;
    const usedPercent = v.utilization > 5 ? v.utilization : v.utilization * 100;
    next.set(kind, { label: w.label, usedPercent: Math.round(usedPercent * 10) / 10, windowMinutes: w.minutes, resetsAt: typeof v.resetsAt === "number" ? v.resetsAt : null });
  };
  const i = info as Record<string, unknown>;
  for (const holder of [i, i.windows, i.rateLimits]) {
    if (!holder || typeof holder !== "object") continue;
    for (const kind of Object.keys(CLAUDE_WINDOWS)) record(kind, (holder as Record<string, unknown>)[kind]);
  }
  if (typeof i.rateLimitType === "string") record(i.rateLimitType, i);
  return next;
}

// A message with attachments: text files go into the text; images and PDFs go in as their own blocks.
export function claudeContent(prompt: string, attachments: Attachment[]): string | unknown[] {
  if (!attachments.length) return prompt;
  const blocks: unknown[] = [{ type: "text", text: withTextFiles(prompt, attachments) }];
  for (const a of attachments) {
    const data = () => fs.readFileSync(a.path).toString("base64");
    if (a.kind === "image") blocks.push({ type: "image", source: { type: "base64", media_type: a.mediaType, data: data() } });
    else if (a.kind === "pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data() }, title: a.name });
  }
  return blocks;
}

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
  private readonly find: () => ToolBinary | null;
  private auth: { at: number; value: AuthStatus } | null = null;

  constructor(private readonly options: ClaudeOptions = {}) {
    this.find = options.find ?? (() => findBinary("claude", this.options.env ?? toolEnvironment.env()));
  }

  // Read at each use, so a PATH change found by a later check reaches the tool (tool-env.ts).
  private env(): NodeJS.ProcessEnv {
    return providerEnv(this.options.env ?? toolEnvironment.env());
  }

  private settingsFile(): string {
    const dir = this.options.settingsDir ?? path.join(os.tmpdir(), "orqestra");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "claude-chat-settings.json");
    fs.writeFileSync(file, JSON.stringify({ disableAllHooks: true, switchModelsOnFlag: false }));
    return file;
  }

  private async authStatus(bin: ToolBinary, fresh: boolean): Promise<AuthStatus | null> {
    if (!fresh && this.auth && Date.now() - this.auth.at < 60_000) return this.auth.value;
    const run = await runShort({ bin, prefixArgs: this.options.prefixArgs, args: ["auth", "status"], env: this.env() });
    try {
      const value = JSON.parse(run.stdout) as AuthStatus;
      this.auth = { at: Date.now(), value };
      return value;
    } catch {
      return null;
    }
  }

  async status(): Promise<ProviderStatus> {
    const base: ProviderStatus = {
      provider: "claude", name: "Claude Code", installed: false, version: null, signedIn: false, plan: null,
      subscription: false, models: CLAUDE_MODELS, limits: [], problem: null,
    };
    const bin = this.find();
    if (!bin) return { ...base, problem: "Claude Code is not installed." };
    const found = { binaryPath: bin.path, source: bin.source ?? null };
    const version = await runShort({ bin, prefixArgs: this.options.prefixArgs, args: ["--version"], env: this.env() });
    const versionText = version.stdout.trim().split(/\s+/)[0] || null;
    if (version.error || !versionText) {
      return { ...base, ...found, installed: true, checkFailed: true, problem: `Claude Code was found but did not start (${version.error ?? `exit ${version.code}`}). Reinstall it, or run \`claude --version\` in a terminal to see the error.` };
    }
    const auth = await this.authStatus(bin, true);
    const subscription = auth ? isClaudeSubscription(auth) : false;
    return {
      ...base,
      ...found,
      installed: true,
      version: versionText,
      signedIn: auth?.loggedIn === true,
      plan: auth?.subscriptionType ?? null,
      subscription,
      authMethod: claudeAuthMethod(auth),
      checkFailed: !auth,
      problem: !auth
        ? "Could not read the sign-in status of Claude Code."
        : !auth.loggedIn
          ? "Not signed in."
          : !subscription
            ? "Claude Code is signed in with an API key or another provider, not a Claude subscription. 0rqestra only uses subscriptions."
            : null,
    };
  }

  chat(request: ChatRequest): ChatHandle {
    const queue = new EventQueue<ChatEvent>();
    const control = { stopped: false, stop: () => {} };
    void this.run(request, queue, control);
    return {
      events: queue,
      stop: () => {
        control.stopped = true;
        control.stop();
      },
    };
  }

  private async run(request: ChatRequest, queue: EventQueue<ChatEvent>, control: { stopped: boolean; stop: () => void }): Promise<void> {
    let text = "";
    const fail = (reason: Extract<ChatEvent, { type: "failed" }>["reason"], message: string) => {
      queue.push({ type: "failed", reason, message, text });
      queue.end();
    };
    const bin = this.find();
    if (!bin) return fail("not_installed", "Claude Code is not installed, or not on PATH.");
    if (request.model && !MODEL_NAME.test(request.model)) return fail("provider_error", "Invalid model name.");
    const auth = await this.authStatus(bin, false);
    if (!auth?.loggedIn) return fail("not_signed_in", "Claude Code is not signed in.");
    if (!isClaudeSubscription(auth)) return fail("not_subscription", "Claude Code is not signed in with a Claude subscription, so nothing was sent.");
    if (control.stopped) {
      queue.push({ type: "cancelled", text });
      queue.end();
      return;
    }

    const child = spawnTool({
      bin, prefixArgs: this.options.prefixArgs, args: claudeArgs(this.settingsFile(), request.model), cwd: request.cwd, env: this.env(),
    });
    let finished = false;
    let sawDelta = false;
    let windows = new Map<string, RateLimit>();
    let fullText = "";
    let stderr = "";
    const finish = (event: ChatEvent) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(watchdog);
      queue.push(event);
      queue.end();
      child.stdin?.end();
    };
    const timeout = setTimeout(() => {
      killTree(child);
      finish({ type: "failed", reason: "timeout", message: "No answer within the time limit.", text });
    }, this.options.timeoutMs ?? 10 * 60_000);
    // Two ways a started reply never ends, both ended long before the overall time limit:
    // - it goes silent (thinking can take a while, so the wait starts once the answer has begun);
    // - it writes tool calls as text over and over (no tools here), seen on 2026-11-20: more than
    //   1,100 pieces of `<invoke name="Bash">cat sources.md</invoke>` in a minute, never ending.
    let lastOutput = 0;
    let firstFake = 0;
    const idleMs = this.options.idleMs ?? 90_000;
    const fakeToolMs = this.options.fakeToolIdleMs ?? 15_000;
    const stalled = (): string | null => {
      if (!lastOutput) return null;
      const faked = FAKE_TOOL_CALL.test(text);
      if (faked && !firstFake) firstFake = Date.now();
      if (faked && ((text.match(/<invoke name=/g)?.length ?? 0) >= 3 || Date.now() - firstFake >= fakeToolMs)) {
        return "Claude Code tried to use a tool it does not have here, instead of answering.";
      }
      const quiet = Date.now() - lastOutput;
      return quiet >= (faked ? fakeToolMs : idleMs) ? `Claude Code stopped sending its answer (nothing for ${Math.round(quiet / 1000)} seconds).` : null;
    };
    const endStalled = () => {
      const why = finished ? null : stalled();
      if (!why) return;
      killTree(child);
      finish({ type: "failed", reason: "provider_error", text, message: why });
    };
    const watchdog = setInterval(endStalled, Math.min(2000, Math.max(50, Math.floor(Math.min(idleMs, fakeToolMs) / 4))));
    watchdog.unref?.();

    control.stop = () => {
      if (finished) return;
      child.stdin?.write(`${JSON.stringify({ type: "control_request", request_id: "orqestra-stop", request: { subtype: "interrupt" } })}\n`);
      // A clean stop normally ends the turn at once; if the tool does not react, it is ended.
      setTimeout(() => {
        if (!finished) {
          killTree(child);
          finish({ type: "cancelled", text });
        }
      }, this.options.stopGraceMs ?? 5000).unref();
    };

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-2000)));
    child.on("error", (error) => finish({ type: "failed", reason: "crashed", message: error.message, text }));
    child.on("close", (code) => {
      if (control.stopped) finish({ type: "cancelled", text });
      else finish({ type: "failed", reason: "crashed", message: `Claude Code stopped without an answer (exit ${code}). ${stderr.trim().slice(-300)}`.trim(), text });
    });
    if (child.stdout) onJsonLines(child.stdout, (event) => {
      // Any event after the answer text has begun counts as output for the stall guard.
      if (sawDelta) lastOutput = Date.now();
      if (event.type === "system" && event.subtype === "init") {
        queue.push({ type: "started", model: typeof event.model === "string" ? event.model : null });
      } else if (event.type === "stream_event") {
        const delta = (event.event as { delta?: { type?: string; text?: string } } | undefined)?.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          sawDelta = true;
          lastOutput = Date.now();
          text += delta.text;
          queue.push({ type: "delta", text: delta.text });
          endStalled();
        }
      } else if (event.type === "assistant") {
        const content = (event.message as { content?: { type?: string; text?: string }[] } | undefined)?.content ?? [];
        fullText += content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
      } else if (event.type === "rate_limit_event") {
        windows = limitsFromClaude(event.rate_limit_info, windows);
      } else if (event.type === "result") {
        if (!sawDelta && fullText) {
          text = fullText;
          queue.push({ type: "delta", text: fullText });
        }
        if (control.stopped) return finish({ type: "cancelled", text });
        if (event.is_error === true || event.subtype !== "success") {
          const message = typeof event.result === "string" && event.result ? event.result : `Claude Code ended with ${String(event.subtype)}.`;
          const limit = /limit|quota|usage/i.test(message);
          return finish({ type: "failed", reason: limit ? "usage_limit" : "provider_error", message, text });
        }
        const answer = text || (typeof event.result === "string" ? event.result : "");
        finish({ type: "completed", text: answer, usage: claudeUsage(event), limits: [...windows.values()] });
      }
    });

    const prompt = request.raw ? request.text : buildPrompt(request.history, request.text, request.team, request.teamNow, request.planMode ? "plan" : "auto");
    child.stdin?.on("error", () => {});
    child.stdin?.write(`${JSON.stringify({ type: "user", message: { role: "user", content: claudeContent(prompt, request.attachments ?? []) } })}\n`);
  }
}
