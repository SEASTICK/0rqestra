import fs from "node:fs";
import path from "node:path";

// The container works on a copy of the product's folder, so it can never change the project's own files.
// The copy keeps its node_modules between runs (installing is slow); everything else follows the source.

export const MAX_FILES = 3000;
const SKIP = new Set(["node_modules", ".git"]);
const OWN = /^\.orqestra-/;

// Regular files only, as relative paths with "/". Links are never followed or copied.
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 12 || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES || e.isSymbolicLink() || SKIP.has(e.name) || OWN.test(e.name) || e.name.endsWith(".orqestra-tmp")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel, depth + 1);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(root, "", 0);
  return out;
}

// Makes `dest` hold the same files as `src` (plus its own node_modules and markers). Returns the files copied.
export function syncFolder(src: string, dest: string): string[] {
  fs.mkdirSync(dest, { recursive: true });
  const wanted = sourceFiles(src);
  const keep = new Set(wanted);
  // Remove what the source no longer has.
  for (const rel of sourceFiles(dest)) {
    if (!keep.has(rel)) fs.rmSync(path.join(dest, ...rel.split("/")), { force: true });
  }
  const copied: string[] = [];
  for (const rel of wanted) {
    const from = path.join(src, ...rel.split("/"));
    const to = path.join(dest, ...rel.split("/"));
    let same: boolean;
    try {
      const a = fs.statSync(from);
      const b = fs.lstatSync(to);
      same = b.isFile() && a.size === b.size && a.mtimeMs <= b.mtimeMs;
    } catch {
      same = false;
    }
    if (same) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.rmSync(to, { force: true, recursive: true });
    fs.copyFileSync(from, to);
    copied.push(rel);
  }
  return copied;
}
