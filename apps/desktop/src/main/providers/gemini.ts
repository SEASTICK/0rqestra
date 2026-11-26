import os from "node:os";
import { buildPrompt } from "./history";
import { findBinary, killTree, MODEL_NAME, onJsonLines, providerEnv, runShort, spawnTool, type ToolBinary } from "./process";
import { toolEnvironment } from "./tool-env";
import { withTextFiles } from "../attachments";
import { EventQueue, type ChatEvent, type ChatHandle, type ChatRequest, type ModelOption, type ProviderAdapter, type ProviderStatus, type RateLimit, type Usage } from "./types";

// Gemini through Google's Antigravity CLI (`agy`), signed in with the user's own Google account (Google AI Pro or
// Ultra). Google closed Gemini CLI to personal accounts on 2026-06-18 ("This client is no longer supported for
// Gemini Code Assist for individuals"), and Antigravity CLI is its replacement. Everything below follows the real
// output of agy 1.5.18 on Windows, sent by the user on 2026-11-26 (stream-json, /usage, /model), and its public
// changelog (github.com/google-antigravity/antigravity-cli).
//
// How a chat stays on the subscription and stays text only:
// - No API key can be used. The environment is cleaned (process.ts removes GEMINI_API_KEY, AGY_ADC_AUTH, the
//   enterprise gateway and Google Cloud variables). And the sign-in is proven before every chat by `/usage`, which
//   only an account sign-in can answer (with an API key agy exits with code 2, because a key has no account quota).
// - agy is started in `--mode default`: it asks before it edits or runs anything, and in a headless run what it
//   would ask about is refused. Its init event names the mode it really runs in; any other than "request-review"
//   or "plan" (for example an auto-approving one) ends the run before anything is sent.
// - agy has tools and no switch to remove them. So the stream is watched: the first step that is not the user's
//   message or the model's answer (a tool call, such as a command, a file read or a web search) ends the run and
//   tells which tool it was. Nothing it tried has been approved, so nothing has been changed on the computer.
// - Pictures and PDFs are not sent (reading them is a tool call); Auto does not choose Gemini for them.

export interface GeminiOptions {
  find?: () => ToolBinary | null;
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  idleMs?: number;
  // How long a cached /usage and model list are used (ms).
  cacheMs?: number;
}

export const DEFAULT_MODEL: ModelOption = { id: "default", label: "Default (your plan's model)", efforts: [], isDefault: true };

// The init event's permission_mode values a chat accepts: agy asks before it changes anything.
export const SAFE_MODES = new Set(["request-review", "plan"]);

// Steps that are only the conversation itself. Anything else is a tool call. The names are agy's step types; the
// two it sends for a plain answer are "user_input" and "agent_response" (seen in the real stream).
const CONVERSATION_STEPS = /^(user_input|agent_response)$/;
// Steps that carry no tool call and may come with a reply (kept narrow; an unknown name ends the run and is named).
const QUIET_STEPS = /^(thinking|reasoning|planner_response|ephemeral_message|conversation_history|checkpoint|knowledge_generation|system_message)$/;

const QUOTA = /quota|rate.?limit|resource.?exhausted|too many requests|\b429\b|usage limit|exhausted|prepaid|out of credits/i;
const NOT_SIGNED_IN = /not signed in|sign in|log ?in|unauthenticated|authentication|authorize|\b401\b|credentials|keyring/i;

export function geminiArgs(model: string | null): string[] {
  // --print without a text: the prompt is read from stdin. --mode default: agy asks before it changes anything.
  return ["--print", "--output-format", "stream-json", "--mode", "default", ...(model && model !== "default" ? ["--model", model] : [])];
}

interface UsageTokens {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

// agy counts thinking tokens inside output_tokens (33 output of which 31 thinking, total = input + output).
export function geminiUsage(u: unknown): Usage | null {
  const t = (u ?? {}) as UsageTokens;
  const input = num(t.input_tokens);
  const output = num(t.output_tokens);
  if (input === null && output === null) return null;
  return { inputTokens: input, outputTokens: output, cachedInputTokens: num(t.cache_read_tokens) };
}

// `/usage` as agy prints it (-p "/usage" --output-format json): command.data.groups[].buckets[] with window "5h" or
// "weekly", remaining_fraction and reset_time (ISO). The Gemini group is the user's plan; the Claude and GPT group
// belongs to models 0rqestra does not use through agy.
export function geminiLimits(json: unknown): RateLimit[] {
  const groups = ((json as { command?: { data?: { groups?: unknown } } } | null)?.command?.data?.groups ?? []) as { name?: unknown; buckets?: unknown }[];
  const group = (Array.isArray(groups) ? groups : []).find((g) => typeof g?.name === "string" && /gemini/i.test(g.name));
  const out: RateLimit[] = [];
  for (const b of (Array.isArray(group?.buckets) ? group!.buckets : []) as { window?: unknown; remaining_fraction?: unknown; reset_time?: unknown }[]) {
    const remaining = num(b?.remaining_fraction);
    if (remaining === null || remaining > 1) continue;
    const minutes = b.window === "5h" ? 300 : b.window === "weekly" ? 7 * 1440 : null;
    if (!minutes) continue;
    const reset = typeof b.reset_time === "string" ? Date.parse(b.reset_time) : NaN;
    out.push({ label: minutes === 300 ? "5-hour limit" : "7-day limit", usedPercent: Math.round((1 - remaining) * 1000) / 10, windowMinutes: minutes, resetsAt: Number.isFinite(reset) && reset > 86_400_000 ? Math.round(reset / 1000) : null });
  }
  return out;
}

// The models agy lists (`agy models --output-format json`). The shape is not documented, so any objects with an id
// and a label are taken; plain lines "id<TAB>label" too. Nothing found: only the default is offered.
export function parseModels(text: string): ModelOption[] {
  const found = new Map<string, string>();
  const take = (value: unknown, depth = 0): void => {
    if (depth > 6 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) return void value.forEach((v) => take(v, depth + 1));
    const o = value as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : typeof o.slug === "string" ? o.slug : null;
    const label = typeof o.label === "string" ? o.label : typeof o.name === "string" ? o.name : id;
    if (id && label && MODEL_NAME.test(id)) found.set(id, label);
    for (const v of Object.values(o)) take(v, depth + 1);
  };
  try {
    const json = JSON.parse(text) as unknown;
    take(json);
    const response = (json as { response?: unknown } | null)?.response;
    if (typeof response === "string") for (const line of response.split("\n")) { const [id, label] = line.split("\t"); if (id && label && MODEL_NAME.test(id)) found.set(id, label.trim()); }
  } catch {
    for (const line of text.split("\n")) {
      const [id, label] = line.split("\t");
      if (id && label && MODEL_NAME.test(id.trim())) found.set(id.trim(), label.trim());
    }
  }
  return [...found].slice(0, 30).map(([id, label]) => ({ id, label, efforts: [], isDefault: false }));
}

export function classifyFailure(message: string, code: number | null): { reason: Extract<ChatEvent, { type: "failed" }>["reason"]; message: string } {
  if (QUOTA.test(message)) return { reason: "usage_limit", message: message.trim().slice(0, 300) || "Your Gemini usage limit is reached." };
  if (code === 2 && /api key|usage|quota/i.test(message)) return { reason: "not_subscription", message: "Antigravity CLI is not signed in with a Google account (it runs on an API key), so nothing was sent." };
  if (NOT_SIGNED_IN.test(message)) return { reason: "not_signed_in", message: "Antigravity CLI is not signed in. Open AI accounts and choose Sign in." };
  return { reason: "provider_error", message: message.trim().slice(0, 400) || "Antigravity CLI could not answer." };
}

// agy prints "AGY_ERROR: {...}" on stderr when a run fails; the JSON names the error.
function agyError(stderr: string): string {
  const line = stderr.split(/\r?\n/).reverse().find((l) => l.includes("AGY_ERROR:"));
  if (!line) return stderr;
  const json = line.slice(line.indexOf("AGY_ERROR:") + "AGY_ERROR:".length).trim();
  try {
    const e = JSON.parse(json) as Record<string, unknown>;
    return [e.short_error, e.message, e.status, e.error_message].filter((x) => typeof x === "string").join(" · ") || json;
  } catch {
    return json;
  }
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini" as const;
  private readonly find: () => ToolBinary | null;
  private usage: { at: number; ok: boolean; limits: RateLimit[]; problem: string | null } | null = null;
  private models: { at: number; list: ModelOption[] } | null = null;

  constructor(private readonly options: GeminiOptions = {}) {
    this.find = options.find ?? (() => findBinary("agy", this.options.env ?? toolEnvironment.env()));
  }

  private env(): NodeJS.ProcessEnv {
    return { ...providerEnv(this.options.env ?? toolEnvironment.env()), NO_COLOR: "1", AGY_CLI_HIDE_LOGO: "1" };
  }

  // Is agy signed in with a Google account right now, and what is left of the plan? One cheap command that does not
  // start a turn and spends no quota. An API key or no sign-in makes it fail, which is what we want to know.
  private async account(bin: ToolBinary, fresh: boolean): Promise<{ ok: boolean; limits: RateLimit[]; problem: string | null }> {
    const cacheMs = this.options.cacheMs ?? 45_000;
    if (!fresh && this.usage && Date.now() - this.usage.at < cacheMs) return this.usage;
    const run = await runShort({ bin, prefixArgs: this.options.prefixArgs, args: ["-p", "/usage", "--output-format", "json"], env: this.env(), cwd: os.tmpdir() }, 40_000);
    let value: { ok: boolean; limits: RateLimit[]; problem: string | null };
    try {
      const json = JSON.parse(run.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "") as { status?: unknown };
      const limits = geminiLimits(json);
      value = json.status === "SUCCESS" && limits.length ? { ok: true, limits, problem: null } : { ok: false, limits: [], problem: "Antigravity CLI is not signed in with a Google account." };
    } catch {
      const why = agyError(`${run.stderr}\n${run.stdout}`).replace(/\s+/g, " ").trim();
      value = { ok: false, limits: [], problem: run.error ? `Antigravity CLI did not answer (${run.error}).` : /api key/i.test(why) || run.code === 2 ? "Antigravity CLI runs on an API key, not a Google account. 0rqestra only uses the account sign-in." : "Not signed in. Run agy once and choose Google OAuth." };
    }
    this.usage = { at: Date.now(), ...value };
    return this.usage;
  }

  private async modelList(bin: ToolBinary): Promise<ModelOption[]> {
    if (this.models && Date.now() - this.models.at < 10 * 60_000) return this.models.list;
    const run = await runShort({ bin, prefixArgs: this.options.prefixArgs, args: ["models", "--output-format", "json"], env: this.env(), cwd: os.tmpdir() }, 30_000);
    const list = [DEFAULT_MODEL, ...parseModels(run.stdout)];
    this.models = { at: Date.now(), list };
    return list;
  }

  async status(): Promise<ProviderStatus> {
    const base: ProviderStatus = {
      provider: "gemini", name: "Gemini", installed: false, version: null, signedIn: false, plan: null,
      subscription: false, models: [DEFAULT_MODEL], limits: [], problem: null,
    };
    const bin = this.find();
    if (!bin) return { ...base, problem: "Antigravity CLI (agy) is not installed." };
    const found = { binaryPath: bin.path, source: bin.source ?? null };
    const version = await runShort({ bin, prefixArgs: this.options.prefixArgs, args: ["--version"], env: this.env(), cwd: os.tmpdir() });
    const versionText = /\d+\.\d+\.\d+/.exec(`${version.stdout}\n${version.stderr}`)?.[0] ?? null;
    if (version.error && /ENOENT|EACCES|spawn/i.test(version.error)) {
      return { ...base, ...found, installed: true, checkFailed: true, problem: `Antigravity CLI was found but did not start (${version.error}). Reinstall it, or run \`agy --version\` in a terminal to see the error.` };
    }
    const account = await this.account(bin, true);
    return {
      ...base,
      ...found,
      installed: true,
      version: versionText,
      signedIn: account.ok,
      plan: null,
      subscription: account.ok,
      authMethod: account.ok ? "subscription" : null,
      models: account.ok ? await this.modelList(bin) : [DEFAULT_MODEL],
      limits: account.limits,
      problem: account.ok ? null : account.problem,
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
    if (!bin) return fail("not_installed", "Antigravity CLI (agy) is not installed, or not on PATH.");
    if (request.model && !MODEL_NAME.test(request.model)) return fail("provider_error", "Invalid model name.");
    if ((request.attachments ?? []).some((a) => a.kind !== "text")) return fail("provider_error", "Gemini cannot take pictures or PDFs here yet. Choose Claude Code for those.");
    // Proven before anything is sent: a Google account sign-in, and the plan's limits (also shown in Usage left).
    const account = await this.account(bin, false);
    if (!account.ok) return fail(/API key/i.test(account.problem ?? "") ? "not_subscription" : "not_signed_in", account.problem ?? "Antigravity CLI is not signed in. Open AI accounts and choose Sign in.");
    if (control.stopped) {
      queue.push({ type: "cancelled", text });
      queue.end();
      return;
    }

    const child = spawnTool({ bin, prefixArgs: this.options.prefixArgs, args: geminiArgs(request.model), cwd: request.cwd, env: this.env() });
    let finished = false;
    let stderr = "";
    let sawText = false;
    let lastOutput = 0;
    // A failed result is finished when the process has ended, so its stderr (AGY_ERROR) has arrived too.
    let failedResult: string | null = null;
    const idleMs = this.options.idleMs ?? 180_000;
    const finish = (event: ChatEvent) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(watchdog);
      queue.push(event);
      queue.end();
      child.stdin?.end();
    };
    const stopAndFail = (reason: Extract<ChatEvent, { type: "failed" }>["reason"], message: string) => {
      killTree(child);
      finish({ type: "failed", reason, message, text });
    };
    const timeout = setTimeout(() => stopAndFail("timeout", "No answer within the time limit."), this.options.timeoutMs ?? 10 * 60_000);
    // Thinking can take long before the first words; once the answer has begun, silence ends it.
    const watchdog = setInterval(() => {
      if (!finished && lastOutput && Date.now() - lastOutput >= idleMs) stopAndFail("provider_error", `Antigravity CLI stopped sending its answer (nothing for ${Math.round((Date.now() - lastOutput) / 1000)} seconds).`);
    }, Math.min(2000, Math.max(50, Math.floor(idleMs / 4))));
    watchdog.unref?.();

    control.stop = () => {
      if (finished) return;
      killTree(child);
      setTimeout(() => finish({ type: "cancelled", text }), 50).unref();
    };

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.on("error", (error) => finish({ type: "failed", reason: "crashed", message: error.message, text }));
    child.on("close", (code) => {
      if (control.stopped) return finish({ type: "cancelled", text });
      const why = agyError(stderr).replace(/\s+/g, " ").trim();
      if (failedResult !== null) { const c = classifyFailure(why || failedResult, code); return finish({ type: "failed", reason: c.reason, message: c.message, text }); }
      if (code !== 0 && why) { const c = classifyFailure(why, code); if (c.reason !== "provider_error") return finish({ type: "failed", reason: c.reason, message: c.message, text }); }
      finish({ type: "failed", reason: "crashed", message: `Antigravity CLI stopped without an answer (exit ${code}). ${why.slice(-300)}`.trim(), text });
    });
    if (child.stdout) onJsonLines(child.stdout, (event) => {
      if (sawText) lastOutput = Date.now();
      if (event.event === "init") {
        const init = (event.init ?? {}) as { permission_mode?: unknown };
        const mode = typeof init.permission_mode === "string" ? init.permission_mode : "";
        // It must be asking before it changes anything; otherwise nothing more is sent from here.
        if (!SAFE_MODES.has(mode)) return stopAndFail("not_subscription", `Antigravity CLI started in the mode "${mode || "unknown"}", which does not ask before it changes things, so the chat was stopped.`);
        queue.push({ type: "started", model: null });
      } else if (event.event === "step_update") {
        const step = (event.step_update ?? {}) as { step_type?: unknown; text_delta?: unknown };
        const type = typeof step.step_type === "string" ? step.step_type : "";
        if (!CONVERSATION_STEPS.test(type) && !QUIET_STEPS.test(type)) return stopAndFail("provider_error", `Antigravity CLI tried to use a tool ("${type || "unknown"}") instead of answering. Nothing was changed. Ask again, or choose Claude Code.`);
        if (type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
          sawText = true;
          lastOutput = Date.now();
          text += step.text_delta;
          queue.push({ type: "delta", text: step.text_delta });
        }
      } else if (event.event === "result") {
        if (control.stopped) return finish({ type: "cancelled", text });
        const r = (event.result ?? {}) as { status?: unknown; response?: unknown; usage?: unknown; error?: unknown; finished_reason?: unknown };
        if (r.status !== "SUCCESS") {
          const message = agyError(stderr) || (typeof r.error === "string" ? r.error : typeof (r.error as { message?: unknown } | undefined)?.message === "string" ? String((r.error as { message: string }).message) : typeof r.response === "string" ? r.response : "");
          failedResult = message.replace(/\s+/g, " ");
          setTimeout(() => { if (!finished) { const c = classifyFailure(agyError(stderr).replace(/\s+/g, " ") || failedResult || "", null); killTree(child); finish({ type: "failed", reason: c.reason, message: c.message, text }); } }, 3000).unref();
          return;
        }
        const answer = text || (typeof r.response === "string" ? r.response : "");
        if (!text && answer) queue.push({ type: "delta", text: answer });
        finish({ type: "completed", text: answer.replace(/\s+$/, ""), usage: geminiUsage(r.usage), limits: account.limits });
      }
    });

    // The prompt goes on stdin and stdin is then closed (agy waits for the end of stdin on Windows). A note says
    // it answers in text: it has tools it must not use here.
    const body = request.raw ? request.text : buildPrompt(request.history, request.text, request.team, request.teamNow, request.planMode ? "plan" : "auto", request.memory ?? []);
    const prompt = `${withTextFiles(body, request.attachments ?? [])}\n\n(Answer in text only. Do not use tools: do not read files, run commands or search the web.)`;
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
  }
}
