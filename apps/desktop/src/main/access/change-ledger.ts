import fs from "node:fs";
import path from "node:path";

// What each team run delivered to the project workspace, file by file, and what the app saw while it
// ran (each task's outcome, and every approved check that actually ran). Kept on this computer only
// (userData/access/changes/<project>.json) so a run's "Review changes" still works after a restart.
// Each delivery stores the hash of the workspace file right after the run wrote it, so a review can
// tell when a later run (or Undo) changed that file since; the content itself stays in the workspace.

export type ChangeState = "pending" | "applied" | "dismissed";

export interface ChangeEntry {
  path: string;
  runId: string;
  taskId: string;
  agentKey: string | undefined;
  agentName: string;
  // sha256 of the workspace file right after this run wrote it; null when it could not be read.
  hash: string | null;
  // Order of deliveries in the project: a higher seq is a later delivery.
  seq: number;
  at: string;
  state: ChangeState;
  appliedTo?: string;
}

export interface TaskOutcome { status: string; note?: string; approved?: boolean; problems?: string[] }
export interface CheckRecord { commandId: string; label: string; command: string; cwd: string; agent: string; exitCode: number | null; ended: string | null; at: string }
export interface RunRecord { tasks: Record<string, TaskOutcome>; checks: CheckRecord[]; finished?: string }

interface LedgerFile { version: 1; seq: number; files: ChangeEntry[]; runs: Record<string, RunRecord> }

const MAX_ENTRIES = 600;
const MAX_RUNS = 200;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;

export class ChangeLedger {
  private readonly cache = new Map<string, LedgerFile>();

  // Without a folder the ledger lives in memory only (tests).
  constructor(private readonly dir: string | null) {}

  private file(projectId: string): string | null {
    if (!PROJECT_ID.test(projectId)) throw new Error("Unknown project.");
    return this.dir ? path.join(this.dir, `${projectId}.json`) : null;
  }

  private load(projectId: string): LedgerFile {
    const cached = this.cache.get(projectId);
    if (cached) return cached;
    let data: LedgerFile = { version: 1, seq: 0, files: [], runs: {} };
    const file = this.file(projectId);
    if (file) {
      try {
        const v = JSON.parse(fs.readFileSync(file, "utf8")) as LedgerFile;
        if (v && v.version === 1 && Array.isArray(v.files) && v.runs && typeof v.runs === "object") data = v;
      } catch {
        // Nothing recorded yet.
      }
    }
    this.cache.set(projectId, data);
    return data;
  }

  private save(projectId: string, data: LedgerFile): void {
    // Old, settled entries go first; pending ones are kept as long as possible.
    if (data.files.length > MAX_ENTRIES) {
      const settled = data.files.filter((f) => f.state !== "pending").sort((a, b) => a.seq - b.seq);
      const drop = new Set(settled.slice(0, data.files.length - MAX_ENTRIES));
      data.files = data.files.filter((f) => !drop.has(f));
    }
    const runIds = Object.keys(data.runs);
    if (runIds.length > MAX_RUNS) {
      const used = new Set(data.files.map((f) => f.runId));
      for (const id of runIds.slice(0, runIds.length - MAX_RUNS)) if (!used.has(id)) delete data.runs[id];
    }
    const file = this.file(projectId);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data), "utf8");
    fs.renameSync(temp, file);
  }

  private run(data: LedgerFile, runId: string): RunRecord {
    const r = data.runs[runId] ?? { tasks: {}, checks: [] };
    data.runs[runId] = r;
    return r;
  }

  // A delivery: a retry within the same run replaces that run's entry for the path.
  deliver(projectId: string, entry: Omit<ChangeEntry, "seq" | "at" | "state">): void {
    const data = this.load(projectId);
    data.seq += 1;
    const key = entry.path.toLowerCase();
    data.files = data.files.filter((f) => !(f.runId === entry.runId && f.path.toLowerCase() === key));
    data.files.push({ ...entry, seq: data.seq, at: new Date().toISOString(), state: "pending" });
    this.save(projectId, data);
  }

  task(projectId: string, runId: string, taskId: string, outcome: Partial<TaskOutcome>): void {
    const data = this.load(projectId);
    const r = this.run(data, runId);
    r.tasks[taskId] = { ...(r.tasks[taskId] ?? { status: "waiting" }), ...outcome };
    this.save(projectId, data);
  }

  check(projectId: string, runId: string, record: CheckRecord): void {
    const data = this.load(projectId);
    const r = this.run(data, runId);
    r.checks = [...r.checks, record].slice(-30);
    this.save(projectId, data);
  }

  finished(projectId: string, runId: string, status: string): void {
    const data = this.load(projectId);
    this.run(data, runId).finished = status;
    this.save(projectId, data);
  }

  runRecord(projectId: string, runId: string): RunRecord {
    return this.load(projectId).runs[runId] ?? { tasks: {}, checks: [] };
  }

  entries(projectId: string): ChangeEntry[] {
    return this.load(projectId).files;
  }

  // A later delivery of the same path by another run, if any (pending or already applied).
  newer(projectId: string, entry: ChangeEntry): ChangeEntry | null {
    const key = entry.path.toLowerCase();
    let found: ChangeEntry | null = null;
    for (const f of this.load(projectId).files) {
      if (f.path.toLowerCase() === key && f.seq > entry.seq && f.runId !== entry.runId && f.state !== "dismissed" && (!found || f.seq > found.seq)) found = f;
    }
    return found;
  }

  settle(projectId: string, runId: string, filePath: string, state: Exclude<ChangeState, "pending">, appliedTo?: string): void {
    const data = this.load(projectId);
    const key = filePath.toLowerCase();
    for (const f of data.files) {
      if (f.runId === runId && f.path.toLowerCase() === key && f.state === "pending") {
        f.state = state;
        if (appliedTo) f.appliedTo = appliedTo;
      }
    }
    this.save(projectId, data);
  }

  // Undo put the workspace back: nothing from that run is waiting any more.
  dismissRun(projectId: string, runId: string): void {
    const data = this.load(projectId);
    for (const f of data.files) if (f.runId === runId && f.state === "pending") f.state = "dismissed";
    this.save(projectId, data);
  }

  forget(projectId: string): void {
    this.cache.delete(projectId);
    const file = this.file(projectId);
    if (file) fs.rmSync(file, { force: true });
  }
}
