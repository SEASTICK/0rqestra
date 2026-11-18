import fs from "node:fs";
import path from "node:path";
import { safeRelativePath } from "./plan";

// The project's folder, where agents' files are written. Only the main process writes here, only
// paths that passed safeRelativePath, and never through a symbolic link.

export const MAX_FILE_BYTES = 400_000;

export function projectWorkspace(base: string, projectId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) throw new Error("Invalid project id.");
  const dir = path.join(base, "projects", projectId, "workspace");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function inside(root: string, rel: string): string {
  const safe = safeRelativePath(rel);
  if (!safe) throw new Error(`Refused file path: ${rel}`);
  const full = path.resolve(root, ...safe.split("/"));
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) throw new Error(`Refused file path: ${rel}`);
  // No part of the path may already be a symbolic link.
  let current = rootResolved;
  for (const part of safe.split("/")) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refused file path (link): ${rel}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
  return full;
}

export function writeFiles(root: string, files: { path: string; content: string }[]): { path: string; bytes: number }[] {
  const prepared = files.map((f) => {
    const bytes = Buffer.byteLength(f.content, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new Error(`${f.path} is larger than ${MAX_FILE_BYTES} bytes.`);
    return { full: inside(root, f.path), path: f.path, content: f.content, bytes };
  });
  for (const f of prepared) {
    fs.mkdirSync(path.dirname(f.full), { recursive: true });
    const temp = `${f.full}.orqestra-tmp`;
    fs.writeFileSync(temp, f.content, "utf8");
    fs.renameSync(temp, f.full);
  }
  return prepared.map((f) => ({ path: f.path, bytes: f.bytes }));
}

export function readFiles(root: string, paths: string[], maxChars: number): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  let used = 0;
  for (const rel of paths) {
    try {
      const content = fs.readFileSync(inside(root, rel), "utf8");
      const room = Math.max(0, maxChars - used);
      if (room === 0) break;
      out.push({ path: rel, content: content.length > room ? `${content.slice(0, room)}\n[... cut to fit ...]` : content });
      used += Math.min(content.length, room);
    } catch {
      // A file a dependency did not deliver is simply not included.
    }
  }
  return out;
}

// The files in the project folder, as plain relative paths (links are skipped).
export function listFiles(root: string, max = 200): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 6 || out.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max || e.isSymbolicLink() || e.name.endsWith(".orqestra-tmp")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel, depth + 1);
      else if (e.isFile() && safeRelativePath(rel)) out.push(rel);
    }
  };
  walk(root, "", 0);
  return out;
}
