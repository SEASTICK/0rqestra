import fs from "node:fs";
import path from "node:path";

// What a granted folder holds, for the Manager and the Planner: the names of its files and folders (two
// levels, never their contents), so plans name real paths. And the checks the folder's own setup offers
// (package.json scripts, Cargo, pytest), which the user may approve with one click when adding it.

const SKIP = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", "target", "__pycache__", ".venv", "venv", "coverage", ".turbo", ".cache", "release"]);
const MAX_ENTRIES = 120;

const list = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !SKIP.has(e.name) && !e.isSymbolicLink()).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
};

export function folderOutline(root: string): string[] {
  const out: string[] = [];
  for (const e of list(root)) {
    if (out.length >= MAX_ENTRIES) break;
    if (!e.isDirectory()) { out.push(e.name); continue; }
    out.push(`${e.name}/`);
    for (const c of list(path.join(root, e.name))) {
      if (out.length >= MAX_ENTRIES) break;
      out.push(`  ${e.name}/${c.name}${c.isDirectory() ? "/" : ""}`);
    }
  }
  if (out.length >= MAX_ENTRIES) out.push("  …");
  return out;
}

export interface SuggestedCheck { label: string; command: string; cwd: string }

const SCRIPT_ORDER: [string, string][] = [["check", "All checks"], ["typecheck", "Typecheck"], ["lint", "Lint"], ["test", "Tests"]];

export function suggestedChecks(root: string): SuggestedCheck[] {
  const found: SuggestedCheck[] = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    for (const [name, label] of SCRIPT_ORDER) if (typeof scripts[name] === "string") found.push({ label, command: `npm run ${name}`, cwd: "" });
  } catch {
    /* no package.json */
  }
  if (fs.existsSync(path.join(root, "Cargo.toml"))) found.push({ label: "Cargo tests", command: "cargo test", cwd: "" });
  if (["pyproject.toml", "pytest.ini", "setup.cfg"].some((f) => fs.existsSync(path.join(root, f))) && fs.existsSync(path.join(root, "tests"))) found.push({ label: "Python tests", command: "python -m pytest", cwd: "" });
  return found.slice(0, 4);
}
