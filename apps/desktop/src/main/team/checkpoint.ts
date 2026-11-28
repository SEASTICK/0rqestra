import fs from "node:fs";
import path from "node:path";
import type { Plan, PlanTask } from "./plan";
import type { ReturnBrief } from "./return-brief";

// A small checkpoint per task, so a backup agent can continue where the primary stopped (for example
// when its provider's usage limit is reached), and so a run can be resumed after the app restarts.
// It holds references, never file contents: the files themselves are in the project workspace and are
// read again (and only the ones still valid) when the task continues. Kept on this computer only.

export type CheckpointStep = "started" | "delivered" | "reviewed" | "switching";

export interface AgentSwitch { fromId: string; fromName: string; toId: string; toName: string; reason: string; at: string }

export interface TaskCheckpoint {
  taskId: string;
  title: string;
  role: string;
  goal: string;
  acceptance: string[];
  // The last step that finished: started (nothing delivered yet), delivered (files written and checked),
  // reviewed (approved), or switching (saved right before another agent takes over).
  step: CheckpointStep;
  agentId: string | null;
  agentName: string | null;
  attempt: number;
  decisions: string[];
  completed: string[];
  pending: string[];
  // The latest files that passed the app's checks (paths in the workspace).
  files: string[];
  // The reviewer's (or the app's) last findings, still to fix.
  findings: string[];
  summary: string | null;
  switches: AgentSwitch[];
  updatedAt: string;
}

// What the runner needs to continue a run: each task's status, what finished tasks produced (for the
// handoffs of later tasks), the task checkpoints and the files written so far.
export interface RunState {
  status: Record<string, string>;
  outputs: Record<string, { title: string; role: string; summary: string; files: string[]; brief?: ReturnBrief }>;
  tasks: Record<string, TaskCheckpoint>;
  written: { path: string; bytes: number }[];
}

export interface RunCheckpoint extends RunState {
  version: 1;
  runId: string;
  projectId: string;
  plan: Plan;
  savedAt: string;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const KEEP = 30;
const MAX_ITEMS = 20;
const MAX_TEXT = 600;

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const list = (items: string[], n = MAX_ITEMS) => [...new Set(items.map((x) => clip(String(x).trim())).filter(Boolean))].slice(0, n);

export function acceptanceOf(task: PlanTask): string[] {
  const own = task.handoff?.acceptance ?? [];
  return list(own.length ? own : task.deliverables.map((d) => `${d} is delivered and passes review.`));
}

// A task's checkpoint, with the lists kept short.
export function makeCheckpoint(task: PlanTask, patch: Partial<TaskCheckpoint>, previous?: TaskCheckpoint): TaskCheckpoint {
  const base: TaskCheckpoint = previous ?? {
    taskId: task.id, title: task.title, role: task.role, goal: clip(task.goal, 2000), acceptance: acceptanceOf(task),
    step: "started", agentId: null, agentName: null, attempt: 0, decisions: list(task.handoff?.decisions ?? []), completed: [],
    pending: [], files: [], findings: [], summary: null, switches: [], updatedAt: new Date(0).toISOString(),
  };
  const next = { ...base, ...patch, updatedAt: new Date().toISOString() };
  return {
    ...next,
    decisions: list(next.decisions), completed: list(next.completed), pending: list(next.pending),
    files: list(next.files, 50), findings: list(next.findings), switches: next.switches.slice(-10),
    summary: next.summary ? clip(next.summary, 1200) : null,
  };
}

// The compact text a backup agent (or the same task after a restart) gets with its handoff. Files are
// named, not included: the worker prompt already carries the latest valid versions it needs to fix.
export function checkpointPrompt(cp: TaskCheckpoint): string {
  const section = (title: string, items: string[]) => (items.length ? [`${title}:`, ...items.map((i) => `- ${i}`)] : []);
  const last = cp.switches.at(-1);
  return [
    "## Checkpoint: continue from here",
    last ? `${last.fromName} stopped (${last.reason}). You continue the same task from its last saved step; do not start over.` : "This task was interrupted. Continue from its last saved step; do not start over.",
    `Task: ${cp.title} (${cp.role})`,
    `Goal: ${cp.goal}`,
    ...section("Acceptance criteria", cp.acceptance),
    ...section("Decisions already made", cp.decisions),
    ...section("Completed", cp.completed),
    ...section("Still to do", cp.pending),
    ...section("Latest valid files (in the project; ask for one if you need its contents)", cp.files),
    ...section("Review findings to fix", cp.findings),
    cp.summary ? `Last summary: ${cp.summary}` : "",
    "Anything an earlier agent wrote after the last saved step was not checked and is not part of the result.",
  ].filter(Boolean).join("\n");
}

// Run checkpoints on disk, one JSON file per run, written atomically. Old ones are pruned.
export class CheckpointStore {
  constructor(private readonly dir: string) {}

  private file(runId: string): string {
    if (!ID.test(runId)) throw new Error("Invalid run id.");
    return path.join(this.dir, `${runId}.json`);
  }

  save(cp: RunCheckpoint): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.file(cp.runId);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cp));
    fs.renameSync(tmp, target);
    this.prune();
  }

  load(runId: string): RunCheckpoint | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(runId), "utf8")) as RunCheckpoint;
      if (raw?.version !== 1 || raw.runId !== runId || !raw.plan || typeof raw.status !== "object" || typeof raw.tasks !== "object") return null;
      return { ...raw, outputs: raw.outputs ?? {}, written: Array.isArray(raw.written) ? raw.written : [] };
    } catch {
      return null;
    }
  }

  remove(runId: string): void {
    try {
      fs.rmSync(this.file(runId), { force: true });
    } catch {
      /* already gone */
    }
  }

  private prune(): void {
    try {
      const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")).map((f) => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const old of files.slice(KEEP)) fs.rmSync(path.join(this.dir, old.f), { force: true });
    } catch {
      /* pruning never affects a run */
    }
  }
}
