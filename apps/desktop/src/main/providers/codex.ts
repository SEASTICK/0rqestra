import type { ChildProcess } from "node:child_process";
import { buildPrompt } from "./history";
import { EFFORT_NAME, findBinary, killTree, MODEL_NAME, onJsonLines, providerEnv, runShort, spawnTool, type ToolBinary } from "./process";
import { EventQueue, type ChatEvent, type ChatHandle, type ChatRequest, type ModelOption, type ProviderAdapter, type ProviderStatus, type RateLimit, type Usage } from "./types";

// Codex, signed in with the user's own ChatGPT plan, driven through `codex app-server` (JSON-RPC
// over stdio). Same methods as the Windows probe in docs/provider-runtime-results.md §4: an
// ephemeral thread, read-only sandbox, approvals never granted, and turn/interrupt to stop.

export interface CodexOptions {
  find?: () => ToolBinary | null;
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  requestTimeoutMs?: number;
}

type Json = Record<string, unknown>;
const APPROVALS = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"];

class RpcProcess {
  readonly child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, (message: Json) => void>();
  exited = false;
  stderr = "";
  onNotification: (method: string, params: Json) => void = () => {};
  onExit: () => void = () => {};

  constructor(spec: Parameters<typeof spawnTool>[0], private readonly timeoutMs: number) {
    this.child = spawnTool(spec);
    this.child.stdin?.on("error", () => {});
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (d: string) => (this.stderr = (this.stderr + d).slice(-2000)));
    const done = () => {
      if (this.exited) return;
      this.exited = true;
      for (const settle of this.pending.values()) settle({ error: { message: "Codex stopped before answering." } });
      this.pending.clear();
      this.onExit();
    };
    this.child.on("error", done);
    this.child.on("close", done);
    if (this.child.stdout) onJsonLines(this.child.stdout, (message) => this.handle(message));
  }

  private handle(message: Json): void {
    const id = message.id;
    if (typeof id === "number" && message.method === undefined) {
      this.pending.get(id)?.(message);
      this.pending.delete(id);
    } else if (id !== undefined && typeof message.method === "string") {
      // A request from the server. Only approvals are expected, and nothing is ever granted.
      if (APPROVALS.includes(message.method)) this.send({ id, result: { decision: "decline" } });
      else this.send({ id, error: { code: -32601, message: `0rqestra does not handle ${message.method}` } });
    } else if (typeof message.method === "string") {
      this.onNotification(message.method, (message.params as Json) ?? {});
    }
  }

  send(message: Json): void {
    if (!this.exited) this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  request<T = Json>(method: string, params: Json): Promise<T> {
    if (this.exited) return Promise.reject(new Error("Codex is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not answer ${method} in time.`));
      }, this.timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(String((message.error as Json).message ?? "Codex reported an error.")));
        else resolve(message.result as T);
      });
      this.send({ method, id, params });
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "orqestra", title: "0rqestra", version: "0.1" } });
    this.send({ method: "initialized", params: {} });
  }

  stop(): void {
    if (this.exited) return;
    this.child.stdin?.end();
    setTimeout(() => {
      if (!this.exited) killTree(this.child);
    }, 5000).unref();
  }
}

interface Account {
  account?: { type?: string; planType?: string } | null;
}

function limitsFrom(snapshot: unknown): RateLimit[] {
  const s = snapshot as { primary?: { usedPercent?: number; windowDurationMins?: number }; secondary?: { usedPercent?: number; windowDurationMins?: number } } | undefined;
  const out: RateLimit[] = [];
  const add = (w: { usedPercent?: number; windowDurationMins?: number } | undefined) => {
    if (!w || typeof w.usedPercent !== "number") return;
    const minutes = typeof w.windowDurationMins === "number" ? w.windowDurationMins : null;
    const label = minutes === null ? "Usage" : minutes <= 24 * 60 ? `${Math.round(minutes / 60)}-hour limit` : `${Math.round(minutes / 1440)}-day limit`;
    out.push({ label, usedPercent: w.usedPercent, windowMinutes: minutes });
  };
  add(s?.primary);
  add(s?.secondary);
  return out;
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex" as const;
  private readonly find: () => ToolBinary | null;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: CodexOptions = {}) {
    this.env = providerEnv(options.env);
    this.find = options.find ?? (() => findBinary("codex", options.env ?? process.env));
  }

  private server(bin: ToolBinary, cwd?: string): RpcProcess {
    return new RpcProcess({ bin, prefixArgs: this.options.prefixArgs, args: ["app-server"], cwd, env: this.env }, this.options.requestTimeoutMs ?? 30_000);
  }

  async status(): Promise<ProviderStatus> {
    const base: ProviderStatus = {
      provider: "codex", name: "Codex", installed: false, version: null, signedIn: false, plan: null,
      subscription: false, models: [], limits: [], problem: null,
    };
    const bin = this.find();
    if (!bin) return { ...base, problem: "Codex is not installed, or not on PATH." };
    const version = await runShort({ bin, prefixArgs: this.options.prefixArgs, args: ["--version"], env: this.env });
    const server = this.server(bin);
    try {
      await server.initialize();
      const account = await server.request<Account>("account/read", { refreshToken: false });
      const type = account?.account?.type ?? null;
      const models = await server.request<{ data?: Json[] }>("model/list", {}).catch(() => ({ data: [] as Json[] }));
      const limits = await server.request<{ rateLimits?: unknown }>("account/rateLimits/read", {}).catch(() => ({ rateLimits: undefined }));
      const options: ModelOption[] = (models?.data ?? [])
        .filter((m) => m.hidden !== true && typeof m.id === "string")
        .map((m) => ({
          id: String(m.id),
          label: String(m.displayName ?? m.id),
          efforts: ((m.supportedReasoningEfforts as { reasoningEffort?: string }[] | undefined) ?? [])
            .map((e) => e.reasoningEffort)
            .filter((e): e is string => typeof e === "string"),
          isDefault: m.isDefault === true,
        }));
      return {
        ...base,
        installed: true,
        version: version.stdout.trim().split(/\s+/).pop() || null,
        signedIn: type !== null,
        plan: account?.account?.planType ?? null,
        subscription: type === "chatgpt",
        models: options,
        limits: limitsFrom(limits?.rateLimits),
        problem: type === null
          ? "Not signed in. Run `codex login` in a terminal and sign in with ChatGPT."
          : type !== "chatgpt"
            ? "Codex is signed in with an API key, not a ChatGPT plan. 0rqestra only uses subscriptions."
            : null,
      };
    } catch (error) {
      return { ...base, installed: true, version: version.stdout.trim() || null, problem: `Could not talk to Codex: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      server.stop();
    }
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
    let finalText = "";
    let usage: Usage | null = null;
    let limits: RateLimit[] = [];
    let finished = false;
    let server: RpcProcess | null = null;
    const finish = (event: ChatEvent) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      queue.push(event);
      queue.end();
      server?.stop();
    };
    const timeout = setTimeout(() => {
      if (server) killTree(server.child);
      finish({ type: "failed", reason: "timeout", message: "No answer within the time limit.", text });
    }, this.options.timeoutMs ?? 10 * 60_000);

    const bin = this.find();
    if (!bin) return finish({ type: "failed", reason: "not_installed", message: "Codex is not installed, or not on PATH.", text });
    if (request.model && !MODEL_NAME.test(request.model)) return finish({ type: "failed", reason: "provider_error", message: "Invalid model name.", text });
    if (request.effort && !EFFORT_NAME.test(request.effort)) return finish({ type: "failed", reason: "provider_error", message: "Invalid effort level.", text });

    let threadId: string | null = null;
    let turnId: string | null = null;
    server = this.server(bin, request.cwd);
    const rpc = server;
    rpc.onExit = () => {
      if (control.stopped) finish({ type: "cancelled", text });
      else finish({ type: "failed", reason: "crashed", message: `Codex stopped without an answer. ${rpc.stderr.trim().slice(-300)}`.trim(), text });
    };
    rpc.onNotification = (method, params) => {
      if (method === "item/agentMessage/delta") {
        const delta = typeof params.delta === "string" ? params.delta : typeof params.text === "string" ? params.text : "";
        if (delta) {
          text += delta;
          queue.push({ type: "delta", text: delta });
        }
      } else if (method === "item/completed") {
        const item = params.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string") finalText += (finalText ? "\n\n" : "") + item.text;
      } else if (method === "thread/tokenUsage/updated") {
        const total = (params.tokenUsage as { total?: { inputTokens?: number; outputTokens?: number } } | undefined)?.total;
        if (total) usage = { inputTokens: total.inputTokens ?? null, outputTokens: total.outputTokens ?? null };
      } else if (method === "account/rateLimits/updated") {
        limits = limitsFrom(params.rateLimits);
      } else if (method === "turn/completed") {
        const turn = params.turn as { id?: string; status?: string; error?: { message?: string; codexErrorInfo?: unknown } } | undefined;
        if (turnId && turn?.id && turn.id !== turnId) return;
        if (!text && finalText) {
          text = finalText;
          queue.push({ type: "delta", text: finalText });
        }
        if (turn?.status === "completed") finish({ type: "completed", text, usage, limits });
        else if (turn?.status === "interrupted") finish({ type: "cancelled", text });
        else {
          const info = JSON.stringify(turn?.error?.codexErrorInfo ?? "");
          const limit = /usageLimitExceeded/i.test(info);
          finish({ type: "failed", reason: limit ? "usage_limit" : "provider_error", message: turn?.error?.message ?? (limit ? "The ChatGPT plan's usage limit is reached." : "Codex could not finish the answer."), text });
        }
      } else if (method === "error" && params.willRetry === false) {
        const message = (params.error as { message?: string } | undefined)?.message ?? "Codex reported an error.";
        finish({ type: "failed", reason: /usageLimitExceeded|usage limit/i.test(JSON.stringify(params)) ? "usage_limit" : "provider_error", message, text });
      }
    };
    control.stop = () => {
      if (finished) return;
      if (threadId && turnId) void rpc.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      setTimeout(() => {
        if (!finished) {
          killTree(rpc.child);
          finish({ type: "cancelled", text });
        }
      }, 5000).unref();
    };

    try {
      await rpc.initialize();
      const account = await rpc.request<Account>("account/read", { refreshToken: false });
      if (!account?.account?.type) return finish({ type: "failed", reason: "not_signed_in", message: "Codex is not signed in.", text });
      if (account.account.type !== "chatgpt") {
        return finish({ type: "failed", reason: "not_subscription", message: "Codex is not signed in with a ChatGPT plan, so nothing was sent.", text });
      }
      if (control.stopped) return finish({ type: "cancelled", text });
      const thread = await rpc.request<{ thread?: { id?: string }; model?: string }>("thread/start", {
        cwd: request.cwd, approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only", ephemeral: true,
        ...(request.model && request.model !== "default" ? { model: request.model } : {}),
      });
      threadId = thread?.thread?.id ?? null;
      if (!threadId) return finish({ type: "failed", reason: "provider_error", message: "Codex did not start a conversation.", text });
      queue.push({ type: "started", model: thread?.model ?? request.model });
      const turn = await rpc.request<{ turn?: { id?: string } }>("turn/start", {
        threadId, input: [{ type: "text", text: request.raw ? request.text : buildPrompt(request.history, request.text, request.team) }], ...(request.effort ? { effort: request.effort } : {}),
      });
      turnId = turn?.turn?.id ?? null;
      if (control.stopped) control.stop();
    } catch (error) {
      finish({ type: "failed", reason: "provider_error", message: error instanceof Error ? error.message : String(error), text });
    }
  }
}
