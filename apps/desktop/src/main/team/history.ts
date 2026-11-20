import fs from "node:fs";
import path from "node:path";
import { inside } from "./workspace";

// Undo for team runs. Before a run writes a file for the first time, the file as it was (or the fact
// that it did not exist) is kept in `<project>/history/<runId>/`. Undo puts those files back, newest
// run first, so a later run's changes are never overwritten by undoing an earlier one.

export const KEEP_RUNS = 20;
const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;

interface Entry {
  path: string;
  existed: boolean;
  copy?: string;
}

export interface Manifest {
  runId: string;
  goal: string;
  createdAt: number;
  undone: boolean;
  files: Entry[];
}

export function historyRoot(workspace: string): string {
  return path.join(path.dirname(workspace), "history");
}

function readManifest(dir: string): Manifest | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
    return value && typeof value.runId === "string" && Array.isArray(value.files) ? value : null;
  } catch {
    return null;
  }
}

function writeManifest(dir: string, manifest: Manifest): void {
  const temp = path.join(dir, "manifest.json.tmp");
  fs.writeFileSync(temp, JSON.stringify(manifest));
  fs.renameSync(temp, path.join(dir, "manifest.json"));
}

// Keeps what a run is about to change. One per run; `before` is called with the paths of each write.
export class RunSnapshot {
  private readonly dir: string;
  private manifest: Manifest | null = null;

  constructor(private readonly workspace: string, runId: string, private readonly goal: string, private readonly now: () => number = Date.now) {
    if (!RUN_ID.test(runId)) throw new Error("Invalid run id.");
    this.dir = path.join(historyRoot(workspace), runId);
  }

  before(paths: string[]): void {
    if (!this.manifest) {
      fs.mkdirSync(this.dir, { recursive: true });
      this.manifest = readManifest(this.dir) ?? { runId: path.basename(this.dir), goal: this.goal.slice(0, 300), createdAt: this.now(), undone: false, files: [] };
    }
    const manifest = this.manifest;
    let changed = false;
    for (const rel of paths) {
      if (manifest.files.some((f) => f.path.toLowerCase() === rel.toLowerCase())) continue;
      const full = inside(this.workspace, rel);
      let existed: boolean;
      try {
        existed = fs.lstatSync(full).isFile();
      } catch {
        existed = false;
      }
      const entry: Entry = { path: rel, existed };
      if (existed) {
        entry.copy = `f${manifest.files.length}`;
        fs.copyFileSync(full, path.join(this.dir, entry.copy));
      }
      manifest.files.push(entry);
      changed = true;
    }
    if (changed) writeManifest(this.dir, manifest);
  }
}

export function listHistory(workspace: string): Manifest[] {
  const root = historyRoot(workspace);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((n) => RUN_ID.test(n)).map((n) => readManifest(path.join(root, n))).filter((m): m is Manifest => m !== null).sort((a, b) => a.createdAt - b.createdAt);
}

// Puts back the files a run changed. Refuses when a newer run that changed files is not undone yet.
export function undoRun(workspace: string, runId: string): { restored: string[]; removed: string[] } {
  if (!RUN_ID.test(runId)) throw new Error("Invalid run id.");
  const all = listHistory(workspace);
  const target = all.find((m) => m.runId === runId);
  if (!target || !target.files.length) throw new Error("This run changed no files, so there is nothing to undo.");
  if (target.undone) throw new Error("This run's changes are already undone.");
  const newer = all.filter((m) => m.createdAt > target.createdAt && !m.undone && m.files.length);
  if (newer.length) throw new Error(`Undo the newer change first: "${newer[newer.length - 1]!.goal}".`);
  const dir = path.join(historyRoot(workspace), runId);
  const restored: string[] = [];
  const removed: string[] = [];
  for (const entry of target.files) {
    const full = inside(workspace, entry.path);
    if (entry.existed && entry.copy && /^f\d+$/.test(entry.copy)) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const temp = `${full}.orqestra-tmp`;
      fs.copyFileSync(path.join(dir, entry.copy), temp);
      fs.renameSync(temp, full);
      restored.push(entry.path);
    } else {
      try {
        if (fs.lstatSync(full).isFile()) {
          fs.unlinkSync(full);
          removed.push(entry.path);
        }
      } catch {
        // Already gone.
      }
    }
  }
  writeManifest(dir, { ...target, undone: true });
  return { restored, removed };
}

// Only the newest runs are kept, so the history does not grow without end.
export function pruneHistory(workspace: string, keep = KEEP_RUNS): void {
  const all = listHistory(workspace);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    fs.rmSync(path.join(historyRoot(workspace), old.runId), { recursive: true, force: true });
  }
}
