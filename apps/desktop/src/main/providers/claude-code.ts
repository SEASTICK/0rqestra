import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPrompt } from "./history";
import { findBinary, killTree, MODEL_NAME, onJsonLines, providerEnv, runShort, spawnTool, type ToolBinary } from "./process";
import { toolEnvironment } from "./tool-env";
import { EventQueue, type AuthMethod, type ChatEvent, type ChatHandle, type ChatRequest, type ModelOption, type ProviderAdapter, type ProviderStatus, type Usage } from "./types";

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
}

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

function usageFrom(result: Record<string, unknown>): Usage | null {
  const models = result.modelUsage;
  if (!models || typeof models !== "object") return null;
  let input = 0;
  let output = 0;
  for (const usage of Object.values(models as Record<string, { inputTokens?: number; outputTokens?: number }>)) {
    input += usage?.inputTokens ?? 0;
    output += usage?.outputTokens ?? 0;
  }
  return { inputTokens: input, outputTokens: output };
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
    let fullText = "";
    let stderr = "";
    const finish = (event: ChatEvent) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      queue.push(event);
      queue.end();
      child.stdin?.end();
    };
    const timeout = setTimeout(() => {
      killTree(child);
      finish({ type: "failed", reason: "timeout", message: "No answer within the time limit.", text });
    }, this.options.timeoutMs ?? 10 * 60_000);

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
      if (event.type === "system" && event.subtype === "init") {
        queue.push({ type: "started", model: typeof event.model === "string" ? event.model : null });
      } else if (event.type === "stream_event") {
        const delta = (event.event as { delta?: { type?: string; text?: string } } | undefined)?.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          sawDelta = true;
          text += delta.text;
          queue.push({ type: "delta", text: delta.text });
        }
      } else if (event.type === "assistant") {
        const content = (event.message as { content?: { type?: string; text?: string }[] } | undefined)?.content ?? [];
        fullText += content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
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
        finish({ type: "completed", text: answer, usage: usageFrom(event), limits: [] });
      }
    });

    const prompt = request.raw ? request.text : buildPrompt(request.history, request.text, request.team, request.teamNow);
    child.stdin?.on("error", () => {});
    child.stdin?.write(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
  }
}
