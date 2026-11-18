import type { ChildProcess } from "node:child_process";
import { PROVIDER_IDS, type ChatEvent, type FailureReason, type ProviderAdapter, type ProviderId, type ProviderStatus } from "../providers/types";
import { officialCommands, type CommandKind, type OfficialCommands } from "./commands";

// AI accounts: takes each provider tool from "not installed" to a working chat, using only the
// providers' official installers and sign-in commands. Free of Electron so it is unit-tested; the
// Electron wiring (accounts-ipc.ts) supplies the process starter, the terminal, and the clipboard.
//
// Nothing here sees a credential. Sign-in runs the provider's own command in a terminal window that
// the user drives; 0rqestra only reads the result through the tool's own status command.

// The four states the card shows, plus "api_key": signed in, but not with a subscription, so the
// tool is never used (0rqestra never causes pay-per-use billing).
export type SetupState = "missing" | "signed_out" | "api_key" | "signed_in" | "failed";

export interface TestResult {
  ok: boolean;
  at: number;
  text: string;
  model: string | null;
  message: string | null;
  reason: FailureReason | null;
}

export type ActivityKind = "installing" | "waiting_install" | "waiting_sign_in" | "testing";

export interface Activity {
  kind: ActivityKind;
  startedAt: number;
  log: string[];
}

export interface AccountError {
  message: string;
  advice: string;
}

export interface AccountView extends ProviderStatus {
  label: string;
  setup: SetupState;
  lastTest: TestResult | null;
  activity: Activity | null;
  error: AccountError | null;
  commands: OfficialCommands;
  canOpenTerminal: boolean;
}

export const LABELS: Record<ProviderId, string> = { claude: "Claude via Claude Code", codex: "ChatGPT via Codex" };

export const TEST_PROMPT = "Reply with one short sentence that confirms this connection test from 0rqestra works.";
export const MAX_LOG_LINES = 14;
export const POLL_MS = 3000;
export const SIGN_IN_WAIT_MS = 10 * 60_000;
export const INSTALL_WAIT_MS = 15 * 60_000;
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
export const TEST_TIMEOUT_MS = 3 * 60_000;

export function setupState(status: ProviderStatus, lastTest: TestResult | null): SetupState {
  if (!status.installed) return "missing";
  if (status.checkFailed) return "failed";
  if (!status.signedIn) return "signed_out";
  if (!status.subscription) return "api_key";
  if (lastTest && !lastTest.ok) return "failed";
  return "signed_in";
}

// What to tell the user when the official installer fails. Matches the installer's own messages.
export function installAdvice(output: string, code: number | null, timedOut = false): string {
  if (timedOut) return "The installer took longer than 10 minutes and was stopped. Check your internet connection, then try again, or run the command in a terminal.";
  if (/could not be resolved|no such host|unable to connect|could not resolve|timed out|connection (was )?(closed|reset|refused)|ssl|tls|network/i.test(output)) {
    return "The download did not work. Check your internet connection (and proxy or firewall), then try again.";
  }
  if (/execution polic|is disabled on this system|not digitally signed/i.test(output)) {
    return "PowerShell blocked the installer script. Choose Open in terminal and run the command there, or copy it into PowerShell yourself.";
  }
  if (/being used by another process|access (to the path .* )?is denied|access denied|eperm|ebusy|permission denied/i.test(output)) {
    return "Windows refused to write the files. Close any open Claude Code or Codex windows, then try again.";
  }
  if (/unsupported|not supported|requires windows|architecture/i.test(output)) {
    return "The installer says this computer is not supported. See the provider's system requirements.";
  }
  return `The installer stopped${code === null ? "" : ` with exit code ${code}`}. Choose Open in terminal to run the official command yourself and see its full message.`;
}

export function signInHint(provider: ProviderId): string {
  return provider === "claude"
    ? "In the terminal, choose your Claude account (Pro, Max, Team or Enterprise) in the browser, not Anthropic Console. When the terminal says Login successful, come back here."
    : "In the browser that opens, choose Sign in with ChatGPT, not an API key. When the terminal says you are logged in, come back here.";
}

// Terminal colour and title codes in installer output; matching them needs control characters.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

export interface InstallProcess {
  child: ChildProcess;
}

export interface TerminalRequest {
  title: string;
  intro: string[];
  // The official command, shown and run in the window. Fixed text from commands.ts, never from the window.
  command: string;
  // True: the window waits for Enter before running it.
  confirm: boolean;
}

export interface AccountsDeps {
  adapters: Record<ProviderId, ProviderAdapter>;
  // Reads the PATH again (tool-env.ts). Called before every check.
  refreshPath: () => Promise<unknown>;
  // Drops the chat's cached statuses so the chat sees a change at once.
  invalidate: () => void;
  // Starts the official installer for a provider, hidden, with output on stdout and stderr.
  startInstaller: (provider: ProviderId) => ChildProcess;
  // Opens a terminal window. Returns false where that is not possible (the copy fallback remains).
  openTerminal: ((request: TerminalRequest) => boolean) | null;
  cwd: () => string;
  emit: (accounts: AccountView[]) => void;
  platform?: NodeJS.Platform;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  killTree?: (child: ChildProcess) => void;
}

interface Entry {
  status: ProviderStatus;
  lastTest: TestResult | null;
  activity: Activity | null;
  error: AccountError | null;
  stopActivity: (() => void) | null;
}

const blank = (provider: ProviderId): ProviderStatus => ({
  provider, name: provider === "claude" ? "Claude Code" : "Codex", installed: false, version: null, signedIn: false, plan: null,
  subscription: false, models: [], limits: [], problem: null,
});

export function parseProvider(value: unknown): ProviderId {
  if (typeof value !== "string" || !PROVIDER_IDS.includes(value as ProviderId)) throw new Error("Unknown provider.");
  return value as ProviderId;
}

export function parseKind(value: unknown): CommandKind {
  if (value !== "install" && value !== "signIn") throw new Error("Unknown command.");
  return value;
}

export class AccountsService {
  private entries: Record<ProviderId, Entry>;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };

  constructor(private readonly deps: AccountsDeps) {
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(t) };
    });
    this.entries = Object.fromEntries(PROVIDER_IDS.map((id) => [id, { status: blank(id), lastTest: null, activity: null, error: null, stopActivity: null }])) as Record<ProviderId, Entry>;
  }

  view(): AccountView[] {
    return PROVIDER_IDS.map((id) => {
      const e = this.entries[id];
      return {
        ...e.status,
        label: LABELS[id],
        setup: setupState(e.status, e.lastTest),
        lastTest: e.lastTest,
        activity: e.activity ? { ...e.activity, log: [...e.activity.log] } : null,
        error: e.error,
        commands: officialCommands(id, this.platform, e.status.binaryPath ?? null, e.status.source ?? null),
        canOpenTerminal: this.deps.openTerminal !== null,
      };
    });
  }

  private publish(): void {
    this.deps.emit(this.view());
  }

  private async check(provider: ProviderId): Promise<ProviderStatus> {
    const status = await this.deps.adapters[provider].status().catch((error: unknown) => ({
      ...blank(provider), problem: error instanceof Error ? error.message : String(error),
    }));
    const entry = this.entries[provider];
    // A different sign-in makes an earlier test result meaningless.
    if (entry.status.signedIn !== status.signedIn || entry.status.authMethod !== status.authMethod || entry.status.installed !== status.installed) entry.lastTest = null;
    entry.status = status;
    return status;
  }

  // Checks both tools again (with a freshly read PATH) and returns what the cards show.
  async refresh(): Promise<AccountView[]> {
    await this.deps.refreshPath();
    await Promise.all(PROVIDER_IDS.map((id) => this.check(id)));
    this.deps.invalidate();
    return this.view();
  }

  private begin(provider: ProviderId, kind: ActivityKind, stop: (() => void) | null = null): Activity {
    const entry = this.entries[provider];
    entry.stopActivity?.();
    entry.activity = { kind, startedAt: this.now(), log: [] };
    entry.error = null;
    entry.stopActivity = stop;
    this.publish();
    return entry.activity;
  }

  private end(provider: ProviderId, error: AccountError | null = null): void {
    const entry = this.entries[provider];
    entry.activity = null;
    entry.stopActivity = null;
    entry.error = error;
    this.publish();
  }

  private busy(provider: ProviderId): boolean {
    return this.entries[provider].activity !== null;
  }

  // Runs the official installer in the background and checks again when it ends.
  install(raw: unknown): boolean {
    const provider = parseProvider(raw);
    if (this.busy(provider)) throw new Error("Something is already running for this tool.");
    if (this.entries[provider].status.installed) throw new Error("This tool is already installed.");
    let child: ChildProcess;
    try {
      child = this.deps.startInstaller(provider);
    } catch (error) {
      this.end(provider, { message: `The installer could not start: ${error instanceof Error ? error.message : String(error)}`, advice: installAdvice("", null) });
      return false;
    }
    let output = "";
    let timedOut = false;
    let stopped = false;
    const activity = this.begin(provider, "installing", () => {
      stopped = true;
      this.deps.killTree?.(child);
    });
    const timer = this.setTimer(() => {
      timedOut = true;
      this.deps.killTree?.(child);
    }, INSTALL_TIMEOUT_MS);
    const onData = (chunk: Buffer | string) => {
      const text = stripAnsi(String(chunk));
      output = (output + text).slice(-20_000);
      // PowerShell writes "#< CLIXML" and serialized progress records to stderr; they are not for people.
      const lines = text.split(/\r?\n|\r/).map((l) => l.trim()).filter((l) => l && !/^#< CLIXML$|^<Objs\b/.test(l));
      if (!lines.length || this.entries[provider].activity !== activity) return;
      activity.log.push(...lines);
      activity.log.splice(0, Math.max(0, activity.log.length - MAX_LOG_LINES));
      this.publish();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let settled = false;
    const finish = async (code: number | null, spawnError: string | null) => {
      if (settled) return;
      settled = true;
      timer.cancel();
      if (this.entries[provider].activity !== activity) return;
      if (stopped) return this.end(provider, { message: "The installation was stopped.", advice: "Choose Install to start again." });
      await this.deps.refreshPath();
      const status = await this.check(provider);
      this.deps.invalidate();
      if (status.installed) return this.end(provider);
      if (spawnError) return this.end(provider, { message: `The installer could not start: ${spawnError}`, advice: installAdvice(spawnError, code) });
      if (code === 0) {
        return this.end(provider, {
          message: `The installer finished, but 0rqestra cannot find ${status.name} yet.`,
          advice: "Choose Check again in a moment. If it still is not found, open a new terminal and run the version command shown below.",
        });
      }
      const last = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-1)[0] ?? "";
      this.end(provider, { message: `The installation did not finish${last ? `: ${last.slice(0, 300)}` : "."}`, advice: installAdvice(output, code, timedOut) });
    };
    child.on("error", (error) => void finish(null, error.message));
    child.on("close", (code) => void finish(code, null));
    return true;
  }

  // Polls one tool until `done` says the user's step in the terminal has had its effect.
  private watch(provider: ProviderId, kind: ActivityKind, limitMs: number, done: (s: ProviderStatus) => boolean, onTimeout: AccountError): void {
    let timer: { cancel(): void } | null = null;
    let cancelled = false;
    const activity = this.begin(provider, kind, () => {
      cancelled = true;
      timer?.cancel();
    });
    const tick = async () => {
      if (cancelled || this.entries[provider].activity !== activity) return;
      await this.deps.refreshPath();
      const status = await this.check(provider);
      if (cancelled || this.entries[provider].activity !== activity) return;
      if (done(status)) {
        this.deps.invalidate();
        return this.end(provider);
      }
      if (this.now() - activity.startedAt >= limitMs) return this.end(provider, onTimeout);
      this.publish();
      timer = this.setTimer(() => void tick(), POLL_MS);
    };
    timer = this.setTimer(() => void tick(), POLL_MS);
  }

  // Opens a terminal with the official command (install or sign-in) and then watches for the result.
  openTerminal(rawProvider: unknown, rawKind: unknown): boolean {
    const provider = parseProvider(rawProvider);
    const kind = parseKind(rawKind);
    const entry = this.entries[provider];
    if (entry.activity?.kind === "installing" || entry.activity?.kind === "testing") throw new Error("Something is already running for this tool.");
    if (kind === "signIn" && !entry.status.installed) throw new Error("Install the tool first.");
    const commands = officialCommands(provider, this.platform, entry.status.binaryPath ?? null, entry.status.source ?? null);
    const open = this.deps.openTerminal;
    const name = entry.status.name;
    const opened = open !== null && open(kind === "install"
      ? { title: `0rqestra: install ${name}`, intro: [`This window runs the official ${name} installer from ${provider === "claude" ? "Anthropic" : "OpenAI"}:`], command: commands.terminalInstall, confirm: true }
      : { title: `0rqestra: sign in to ${name}`, intro: [`This window runs ${name}'s own sign-in. 0rqestra never sees your password or tokens.`, signInHint(provider)], command: commands.terminalSignIn, confirm: false });
    if (kind === "install") {
      this.watch(provider, "waiting_install", INSTALL_WAIT_MS, (s) => s.installed, {
        message: `${name} was not found after 15 minutes.`, advice: "If the installer finished, choose Check again. Otherwise run the command again.",
      });
    } else {
      this.watch(provider, "waiting_sign_in", SIGN_IN_WAIT_MS, (s) => s.signedIn, {
        message: "No sign-in was seen within 10 minutes.", advice: "Choose Sign in to open the window again, or run the command below yourself.",
      });
    }
    // Waiting goes on: the user can run the copied command, and the card still notices the result.
    if (!opened) {
      entry.error = { message: "0rqestra could not open a terminal window here.", advice: "Copy the command below and run it in a terminal yourself. This card checks again by itself." };
      this.publish();
    }
    return opened;
  }

  signIn(raw: unknown): boolean {
    return this.openTerminal(raw, "signIn");
  }

  // Stops whatever runs for a tool: an installer, or waiting for the terminal.
  cancel(raw: unknown): boolean {
    const provider = parseProvider(raw);
    const entry = this.entries[provider];
    if (!entry.activity || entry.activity.kind === "testing") return false;
    const stop = entry.stopActivity;
    const wasInstalling = entry.activity.kind === "installing";
    entry.stopActivity = null;
    stop?.();
    // A running installer reports its own end (close event); waiting just stops.
    if (!wasInstalling) this.end(provider);
    return true;
  }

  // Sends one short real request through the tool and remembers the outcome.
  async test(raw: unknown): Promise<TestResult> {
    const provider = parseProvider(raw);
    if (this.busy(provider)) throw new Error("Something is already running for this tool.");
    const entry = this.entries[provider];
    if (!entry.status.installed) throw new Error("Install the tool first.");
    const handle = this.deps.adapters[provider].chat({ provider, model: null, effort: null, history: [], text: TEST_PROMPT, cwd: this.deps.cwd(), raw: true });
    const activity = this.begin(provider, "testing", () => handle.stop());
    const timer = this.setTimer(() => handle.stop(), TEST_TIMEOUT_MS);
    let last: ChatEvent | null = null;
    let model: string | null = null;
    try {
      for await (const event of handle.events) {
        if (event.type === "started") model = event.model;
        last = event;
      }
    } catch (error) {
      last = { type: "failed", reason: "crashed", message: error instanceof Error ? error.message : String(error), text: "" };
    } finally {
      timer.cancel();
    }
    const result: TestResult = last?.type === "completed"
      ? { ok: true, at: this.now(), text: last.text.trim().slice(0, 500), model, message: null, reason: null }
      : last?.type === "failed"
        ? { ok: false, at: this.now(), text: "", model, message: last.message, reason: last.reason }
        : { ok: false, at: this.now(), text: "", model, message: last?.type === "cancelled" ? "No answer within 3 minutes, so the test was stopped." : "The tool ended without an answer.", reason: "timeout" };
    if (entry.activity === activity) {
      entry.lastTest = result;
      // A sign-in problem found by the test is shown from the tool's own status.
      if (!result.ok && (result.reason === "not_signed_in" || result.reason === "not_subscription" || result.reason === "not_installed")) {
        await this.check(provider);
        entry.lastTest = null;
      }
      this.deps.invalidate();
      this.end(provider);
    }
    return result;
  }

  stopAll(): void {
    for (const id of PROVIDER_IDS) {
      const entry = this.entries[id];
      entry.stopActivity?.();
      entry.stopActivity = null;
    }
  }
}
