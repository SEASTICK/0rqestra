import fs from "node:fs";
import path from "node:path";
import type { Plan } from "../team/plan";
import type { TeamEvent } from "../team/runner";

// Work briefs (Teams phase 3): when an approved team run actually starts in a project linked to a
// shared project, its owner's app publishes one short brief, and updates the same brief when the
// scope changes, the run becomes blocked, or it finishes. The brief holds a short summary and
// repository-relative paths only: never prompts, chat, file contents, credentials or local paths.
//
// Every state gets a higher sequence number, and only the newest state of a run is sent. The
// database applies it only if it is newer and the brief is not finished yet, so retries and late
// deliveries are harmless. States wait in an outbox on disk until the server has them.
// Presence has nothing to do with this: going idle or offline never finishes a run.

export type BriefStatus = "in_progress" | "blocked" | "completed" | "stopped" | "failed";
export const TERMINAL: BriefStatus[] = ["completed", "stopped", "failed"];

export interface BriefState {
  projectId: string;
  runId: string;
  userId: string;
  seq: number;
  status: BriefStatus;
  title: string;
  branch: string | null;
  paths: string[];
  outcome: string | null;
  updatedAt: number;
  sync: "pending" | "synced" | "failed";
  error: string | null;
}

export interface RunInfo {
  runId: string;
  localProjectId: string;
  plan: Plan;
}

export interface PublishResult {
  applied: boolean;
  status: string;
  seq: number;
}

type Timer = unknown;

export interface PublisherDeps {
  // The shared project a local project is linked to on this computer, for the signed-in account.
  linkFor: (localProjectId: string) => { sharedProjectId: string; userId: string; path: string } | null;
  branchOf: (folder: string) => Promise<string | null>;
  send: (state: BriefState) => Promise<PublishResult>;
  // Who is signed in now; states of another account wait until that account signs in again.
  currentUserId: () => string | null;
  load: () => BriefState[];
  save: (states: BriefState[]) => void;
  onChange: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
}

const RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
const KEEP_FINISHED_MS = 7 * 24 * 3600_000;
const MAX_PATHS = 50;

// Absolute local paths never leave this computer, even inside a sentence.
export function scrubLocalPaths(text: string): string {
  return text
    .replace(/[A-Za-z]:[\\/][^\s"'`)]*/g, "[local path]")
    .replace(/\\\\[^\s"'`)]+/g, "[local path]")
    .replace(/(^|[\s("'`])(?:~|\/(?:Users|home|var|tmp|private|mnt|opt|Volumes|root|etc))\/[^\s"'`)]*/g, "$1[local path]");
}

export function shortText(text: string, max: number): string {
  const clean = scrubLocalPaths(String(text)).replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

const REPO_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\/?$/;
export function repoPaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const n = p.replace(/\\/g, "/");
    if (n.length <= 300 && REPO_PATH.test(n) && !n.split("/").some((s) => s === ".." || s === ".") && !out.includes(n)) out.push(n);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

const OUTCOME: Record<"done" | "failed" | "stopped", BriefStatus> = { done: "completed", failed: "failed", stopped: "stopped" };

export class BriefPublisher {
  private states = new Map<string, BriefState>();
  private runs = new Map<string, { key: string; failedTasks: Set<string> }>();
  private inFlight = new Set<string>();
  // Runs whose branch is still being read: nothing is sent for them until it is known.
  private starting = new Set<string>();
  private attempts = new Map<string, number>();
  private retryTimer: Timer | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;

  constructor(private readonly deps: PublisherDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    for (const s of deps.load()) this.states.set(`${s.projectId}:${s.runId}`, s);
    this.prune();
  }

  // The owner's own briefs for a shared project, newest first, for the bridge.
  forProject(projectId: string): BriefState[] {
    return [...this.states.values()].filter((s) => s.projectId === projectId && s.userId === this.deps.currentUserId()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async onRunEvent(info: RunInfo, event: TeamEvent): Promise<void> {
    if (event.type === "run-started") {
      const link = this.deps.linkFor(info.localProjectId);
      // A solo project, or a shared project not linked here: no brief.
      if (!link) return;
      const key = `${link.sharedProjectId}:${info.runId}`;
      if (this.states.has(key)) return;
      // Registered before reading the branch, so events that arrive meanwhile are not lost.
      this.runs.set(info.runId, { key, failedTasks: new Set() });
      this.states.set(key, {
        projectId: link.sharedProjectId,
        runId: info.runId,
        userId: link.userId,
        seq: 1,
        status: "in_progress",
        title: shortText(info.plan.goal, 160) || "Team run",
        branch: null,
        paths: repoPaths(info.plan.tasks.flatMap((t) => t.deliverables)),
        outcome: null,
        updatedAt: this.now(),
        sync: "pending",
        error: null,
      });
      this.starting.add(key);
      const branch = await this.deps.branchOf(link.path).catch(() => null);
      this.starting.delete(key);
      const current = this.states.get(key)!;
      this.states.set(key, { ...current, branch: branch ? shortText(branch, 250) : null });
      this.persist();
      return this.flush();
    }
    const run = this.runs.get(info.runId);
    const state = run ? this.states.get(run.key) : undefined;
    if (!run || !state) return;
    if (event.type === "task" && (event.status === "failed" || event.status === "blocked")) {
      run.failedTasks.add(event.taskId);
      if (state.status === "in_progress") {
        const task = info.plan.tasks.find((t) => t.id === event.taskId);
        this.update(run.key, { status: "blocked", outcome: shortText(`${task?.title ?? "A task"}: ${event.note ?? event.status}`, 300) });
      }
    } else if (event.type === "files") {
      // The run delivered files outside the planned scope: the brief's paths follow.
      const added = repoPaths(event.files.map((f) => f.path)).filter((p) => !state.paths.includes(p));
      if (added.length) this.update(run.key, { paths: repoPaths([...state.paths, ...added]) });
    } else if (event.type === "run-finished") {
      this.update(run.key, { status: OUTCOME[event.status], outcome: shortText(event.summary, 300) });
      this.runs.delete(info.runId);
    }
  }

  private update(key: string, patch: Partial<Pick<BriefState, "status" | "paths" | "outcome">>): void {
    const state = this.states.get(key);
    // A finished run's brief never changes again, here or on the server.
    if (!state || TERMINAL.includes(state.status)) return;
    this.states.set(key, { ...state, ...patch, seq: state.seq + 1, updatedAt: this.now(), sync: "pending", error: null });
    this.persist();
    void this.flush();
  }

  // Sends every state the server does not have yet. Called after changes, when the connection
  // returns, and on a retry timer.
  async flush(): Promise<void> {
    const me = this.deps.currentUserId();
    const due = [...this.states.entries()].filter(([key, s]) => s.sync !== "synced" && s.userId === me && !this.inFlight.has(key) && !this.starting.has(key));
    await Promise.all(due.map(([key]) => this.sendOne(key)));
  }

  private async sendOne(key: string): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;
    this.inFlight.add(key);
    try {
      await this.deps.send(state);
      const now = this.states.get(key);
      if (now && now.seq === state.seq) {
        this.states.set(key, { ...now, sync: "synced", error: null });
        this.attempts.delete(key);
      }
    } catch (error) {
      const now = this.states.get(key);
      if (now && now.seq === state.seq) this.states.set(key, { ...now, sync: "failed", error: error instanceof Error ? error.message : String(error) });
      this.scheduleRetry(key);
    } finally {
      this.inFlight.delete(key);
      this.persist();
    }
    // A newer state arrived while this one was being sent.
    const latest = this.states.get(key);
    if (latest && latest.sync === "pending" && latest.seq !== state.seq) await this.sendOne(key);
  }

  private scheduleRetry(key: string): void {
    const n = this.attempts.get(key) ?? 0;
    this.attempts.set(key, n + 1);
    if (this.retryTimer) return;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      void this.flush();
    }, RETRY_MS[Math.min(n, RETRY_MS.length - 1)]!);
  }

  private prune(): void {
    const cutoff = this.now() - KEEP_FINISHED_MS;
    for (const [key, s] of this.states) if (s.sync === "synced" && TERMINAL.includes(s.status) && s.updatedAt < cutoff) this.states.delete(key);
  }

  private persist(): void {
    this.prune();
    this.deps.save([...this.states.values()]);
    this.deps.onChange();
  }
}

// The outbox on disk, so a brief that could not be sent survives a restart.
export function fileOutbox(file: string): Pick<PublisherDeps, "load" | "save"> {
  return {
    load: () => {
      try {
        const v = JSON.parse(fs.readFileSync(file, "utf8")) as { briefs?: unknown };
        return Array.isArray(v.briefs) ? (v.briefs as BriefState[]).filter((b) => typeof b?.projectId === "string" && typeof b.runId === "string" && typeof b.seq === "number") : [];
      } catch {
        return [];
      }
    },
    save: (states) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, briefs: states }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}
