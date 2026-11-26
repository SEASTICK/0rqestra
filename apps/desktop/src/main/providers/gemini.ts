import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPrompt } from "./history";
import { findBinary, killTree, MODEL_NAME, onJsonLines, providerEnv, runShort, spawnTool, type ToolBinary } from "./process";
import { toolEnvironment } from "./tool-env";
import { withTextFiles, type Attachment } from "../attachments";
import { EventQueue, type ChatEvent, type ChatHandle, type ChatRequest, type ModelOption, type ProviderAdapter, type ProviderStatus, type Usage } from "./types";

// Gemini, signed in with the user's own Google account (a Google AI Pro or Ultra plan, or the free
// tier), driven through the official Gemini CLI in headless mode (`gemini -p -o stream-json`).
//
// What keeps this on the subscription and out of the way:
// - The CLI is started with a system settings file of ours that forces "Login with Google"
//   (security.auth.selectedType and enforcedType). A workspace settings file is not enough: tested on
//   2026-11-25, with only workspace settings a GEMINI_API_KEY in the environment was used. The key is
//   also removed from the environment (process.ts), and with the forced login even a key in
//   ~/.gemini/.env or in settings is never used (the CLI then asks for a login instead).
// - The CLI ignores that file when its folder is writable by others ("Skipping system settings file",
//   printed on stderr at start). That is checked before every chat and watched while it runs, and then
//   nothing is sent: it fails closed.
// - Its tools are off (tools.core is empty; MCP servers, hooks, skills and extensions are off too), so
//   a chat is only text, as with the other tools. Only when pictures or PDFs are attached is the file
//   reader turned on, and it can only see the empty chat folder with a copy of those files.

export interface GeminiOptions {
  find?: () => ToolBinary | null;
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  // Where the settings file is written (a folder only the user can write to).
  settingsDir?: string;
  // The folder with the CLI's own state (.gemini); defaults to the user's home.
  home?: string;
  timeoutMs?: number;
  idleMs?: number;
  stopGraceMs?: number;
}

// The CLI's own model aliases, which follow its newest models. "default" starts it without a model
// flag, which is the CLI's own choice per request ("auto").
export const GEMINI_MODELS: ModelOption[] = [
  { id: "default", label: "Default (Auto)", efforts: [], isDefault: true },
  { id: "pro", label: "Pro", efforts: [], isDefault: false },
  { id: "flash", label: "Flash", efforts: [], isDefault: false },
  { id: "flash-lite", label: "Flash-Lite", efforts: [], isDefault: false },
];

const GEMINI_ALIASES = new Set(GEMINI_MODELS.map((m) => m.id));
const REFUSED = /Skipping system settings file/i;
const AUTH_EXIT = 41;
const QUOTA = /quota|rate.?limit|resource.?exhausted|too many requests|\b429\b|usage limit|exceeded your/i;
const NOT_SIGNED_IN = /manual authorization is required|please set an auth method|not (logged|signed) in|log ?in with google|authentication (failed|required)|oauth/i;

export function geminiSettings(withFileReader: boolean): string {
  return JSON.stringify({
    security: { auth: { selectedType: "oauth-personal", enforcedType: "oauth-personal" } },
    tools: { core: withFileReader ? ["read_file"] : [] },
    mcp: { allowed: ["orqestra-none"] },
    hooksConfig: { enabled: false },
    skills: { enabled: false },
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false, checkpointing: { enabled: false } },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
  });
}

export const HEADLESS_PROMPT = "Reply to the message above.";

export function geminiArgs(model: string | null): string[] {
  // The prompt itself goes on stdin; the CLI puts the text of "-p" after it. That text is not empty: through
  // npm's .cmd launcher on Windows an empty argument can be dropped, and "-p" would take the next flag.
  return ["-p", HEADLESS_PROMPT, "-o", "stream-json", "--skip-trust", "-e", "none", ...(model && model !== "default" ? ["-m", model] : [])];
}

interface Stats {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cached?: unknown;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

// stats of the final "result" event: input_tokens is the whole prompt (the cached part included).
export function geminiUsage(stats: unknown): Usage | null {
  const s = (stats ?? {}) as Stats;
  const input = num(s.input_tokens);
  const output = num(s.output_tokens);
  if (input === null && output === null) return null;
  return { inputTokens: input, outputTokens: output, cachedInputTokens: num(s.cached) };
}

export function classifyFailure(message: string, code: number | null): { reason: Extract<ChatEvent, { type: "failed" }>["reason"]; message: string } {
  if (code === AUTH_EXIT || NOT_SIGNED_IN.test(message)) return { reason: "not_signed_in", message: "Gemini CLI is not signed in with a Google account. Open AI accounts and choose Sign in." };
  if (QUOTA.test(message)) return { reason: "usage_limit", message: message.trim().slice(0, 300) || "Your Gemini usage limit is reached." };
  return { reason: "provider_error", message: message.trim().slice(0, 400) || "Gemini CLI could not answer." };
}

// Where the CLI keeps its sign-in: <home>/.gemini/oauth_creds.json (GEMINI_CLI_HOME replaces the home).
export function geminiSignedIn(home: string): boolean {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "oauth_creds.json"), "utf8")) as Record<string, unknown>;
    return typeof creds.refresh_token === "string" || typeof creds.access_token === "string";
  } catch {
    return false;
  }
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini" as const;
  private readonly find: () => ToolBinary | null;
  private safe: { at: number; ok: boolean; problem: string | null } | null = null;

  constructor(private readonly options: GeminiOptions = {}) {
    this.find = options.find ?? (() => findBinary("gemini", this.options.env ?? toolEnvironment.env()));
  }

  private home(): string {
    const env = this.options.env ?? toolEnvironment.env();
    return this.options.home ?? env.GEMINI_CLI_HOME ?? env.USERPROFILE ?? env.HOME ?? os.homedir();
  }

  // The settings file is rewritten at each use, in a folder only the user can write to.
  private settingsFile(fileReader: boolean): string {
    const dir = this.options.settingsDir ?? path.join(os.tmpdir(), "orqestra");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, fileReader ? "gemini-system-files.json" : "gemini-system.json");
    fs.writeFileSync(file, geminiSettings(fileReader), { mode: 0o600 });
    return file;
  }

  private env(fileReader = false): NodeJS.ProcessEnv {
    return { ...providerEnv(this.options.env ?? toolEnvironment.env()), GEMINI_CLI_SYSTEM_SETTINGS_PATH: this.settingsFile(fileReader), NO_COLOR: "1" };
  }

  // Does the CLI accept our settings file? It says so on stderr at every start (also for --version).
  private async accepted(bin: ToolBinary, fresh: boolean): Promise<{ ok: boolean; problem: string | null }> {
    if (!fresh && this.safe && Date.now() - this.safe.at < 60_000) return this.safe;
    const run = await runShort({ bin, prefixArgs: this.options.prefixArgs, args: ["--version"], env: this.env() });
    const refused = REFUSED.test(run.stderr);
    const value = {
      at: Date.now(),
      ok: !refused,
      problem: refused ? "Gemini CLI refused 0rqestra's safety settings because of folder permissions, so nothing is sent. Make the folder 0rqestra keeps its data in writable only by you." : null,
    };
    this.safe = value;
    return value;
  }

  async status(): Promise<ProviderStatus> {
    const base: ProviderStatus = {
      provider: "gemini", name: "Gemini CLI", installed: false, version: null, signedIn: false, plan: null,
      subscription: false, models: GEMINI_MODELS, limits: [], problem: null,
    };
    const bin = this.find();
    if (!bin) return { ...base, problem: "Gemini CLI is not installed." };
    const found = { binaryPath: bin.path, source: bin.source ?? null };
    const version = await runShort({ bin, prefixArgs: this.options.prefixArgs, args: ["--version"], env: this.env() });
    const versionText = version.stdout.trim().split(/\s+/).find((w) => /^\d/.test(w)) ?? null;
    if (version.error || !versionText) {
      return { ...base, ...found, installed: true, checkFailed: true, problem: `Gemini CLI was found but did not start (${version.error ?? `exit ${version.code}`}). Reinstall it, or run \`gemini --version\` in a terminal to see the error.` };
    }
    const accepted = await this.accepted(bin, true);
    const signedIn = geminiSignedIn(this.home());
    return {
      ...base,
      ...found,
      installed: true,
      version: versionText,
      signedIn,
      // The CLI does not say which Google plan the account has (AI Pro, Ultra or the free tier); "subscription" here
      // means a Google account login, never an API key.
      plan: null,
      subscription: signedIn && accepted.ok,
      authMethod: signedIn ? "subscription" : null,
      problem: !accepted.ok ? accepted.problem : !signedIn ? "Not signed in. Run Gemini CLI once and choose Login with Google." : null,
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
    if (!bin) return fail("not_installed", "Gemini CLI is not installed, or not on PATH.");
    if (request.model && !MODEL_NAME.test(request.model)) return fail("provider_error", "Invalid model name.");
    if (request.model && !GEMINI_ALIASES.has(request.model) && !/^gemini-[A-Za-z0-9._-]+$/.test(request.model)) return fail("provider_error", "Unknown Gemini model.");
    if (!geminiSignedIn(this.home())) return fail("not_signed_in", "Gemini CLI is not signed in with a Google account. Open AI accounts and choose Sign in.");
    const accepted = await this.accepted(bin, false);
    if (!accepted.ok) return fail("not_subscription", accepted.problem ?? "Gemini CLI refused 0rqestra's settings, so nothing was sent.");
    if (control.stopped) {
      queue.push({ type: "cancelled", text });
      queue.end();
      return;
    }

    // Pictures and PDFs are copied into a folder inside the chat folder and named with @, which is how the
    // CLI takes them; text files go into the message itself (as for the other tools).
    const attachments = request.attachments ?? [];
    const media = attachments.filter((a: Attachment) => a.kind !== "text");
    const copyDir = media.length ? path.join(request.cwd, `attached-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`) : null;
    const refs: string[] = [];
    if (copyDir) {
      fs.mkdirSync(copyDir, { recursive: true });
      media.forEach((a, i) => {
        const name = `file${i + 1}${path.extname(a.path).toLowerCase()}`;
        fs.copyFileSync(a.path, path.join(copyDir, name));
        refs.push(`@${path.basename(copyDir)}/${name}`);
      });
    }
    const cleanup = () => { if (copyDir) fs.rmSync(copyDir, { recursive: true, force: true }); };

    const child = spawnTool({
      bin, prefixArgs: this.options.prefixArgs, args: geminiArgs(request.model), cwd: request.cwd, env: this.env(media.length > 0),
    });
    let finished = false;
    let stderr = "";
    let sawDelta = false;
    let lastOutput = 0;
    let warning = "";
    const idleMs = this.options.idleMs ?? 120_000;
    const finish = (event: ChatEvent) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(watchdog);
      cleanup();
      queue.push(event);
      queue.end();
      child.stdin?.end();
    };
    const timeout = setTimeout(() => {
      killTree(child);
      finish({ type: "failed", reason: "timeout", message: "No answer within the time limit.", text });
    }, this.options.timeoutMs ?? 10 * 60_000);
    // Thinking can take a while before the first words; once the answer has begun, silence ends it.
    const watchdog = setInterval(() => {
      if (finished || !lastOutput || Date.now() - lastOutput < idleMs) return;
      killTree(child);
      finish({ type: "failed", reason: "provider_error", text, message: `Gemini CLI stopped sending its answer (nothing for ${Math.round((Date.now() - lastOutput) / 1000)} seconds).` });
    }, Math.min(2000, Math.max(50, Math.floor(idleMs / 4))));
    watchdog.unref?.();

    control.stop = () => {
      if (finished) return;
      killTree(child);
      setTimeout(() => finish({ type: "cancelled", text }), 50).unref();
    };

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      stderr = (stderr + d).slice(-2000);
      // The CLI did not accept our settings: it could use another sign-in. Stop before anything is sent.
      if (REFUSED.test(stderr) && !finished) {
        killTree(child);
        this.safe = { at: Date.now(), ok: false, problem: "Gemini CLI refused 0rqestra's safety settings because of folder permissions, so nothing is sent." };
        finish({ type: "failed", reason: "not_subscription", text, message: this.safe.problem ?? "Gemini CLI refused 0rqestra's settings." });
      }
    });
    child.on("error", (error) => finish({ type: "failed", reason: "crashed", message: error.message, text }));
    child.on("close", (code) => {
      if (control.stopped) return finish({ type: "cancelled", text });
      const why = (warning || stderr).replace(/\s+/g, " ").trim();
      if (code === AUTH_EXIT || NOT_SIGNED_IN.test(why)) { const c = classifyFailure(why, code); return finish({ type: "failed", reason: c.reason, message: c.message, text }); }
      finish({ type: "failed", reason: "crashed", message: `Gemini CLI stopped without an answer (exit ${code}). ${why.slice(-300)}`.trim(), text });
    });
    if (child.stdout) onJsonLines(child.stdout, (event) => {
      if (sawDelta) lastOutput = Date.now();
      if (event.type === "init") {
        const model = typeof event.model === "string" ? event.model : null;
        queue.push({ type: "started", model: model === "auto" ? null : model });
      } else if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
        sawDelta = true;
        lastOutput = Date.now();
        text += event.content;
        queue.push({ type: "delta", text: event.content });
      } else if (event.type === "error" && typeof event.message === "string") {
        warning = event.message;
      } else if (event.type === "result") {
        if (control.stopped) return finish({ type: "cancelled", text });
        if (event.status === "error") {
          const err = (event.error ?? {}) as { message?: unknown };
          const c = classifyFailure(typeof err.message === "string" ? err.message : warning, null);
          return finish({ type: "failed", reason: c.reason, message: c.message, text });
        }
        finish({ type: "completed", text, usage: geminiUsage(event.stats), limits: [] });
      }
    });

    const body = request.raw ? request.text : buildPrompt(request.history, request.text, request.team, request.teamNow, request.planMode ? "plan" : "auto", request.memory ?? []);
    const prompt = `${withTextFiles(body, attachments)}${refs.length ? `\n\n${refs.join("\n")}` : ""}`;
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
  }
}
