import fs from "node:fs";
import path from "node:path";
import { findBinary, killTree, spawnTool, type ToolBinary } from "../providers/process";
import { toolEnvironment } from "../providers/tool-env";

// Your own GitHub repositories, through GitHub's official command line tool `gh` (cli.github.com), which
// the user signs in to once (`gh auth login`, in the browser). 0rqestra never sees a password or a token:
// it never asks `gh` for one (no `gh auth token`) and does not store anything. `gh` also sets up git to
// use that sign-in, so the later push in Computer access works with it.
//
// What the window can ask for is narrow: the status, the list of repositories, and cloning one
// repository ("owner/name", checked) into a folder the user chose in the system's folder picker.

export interface RepoInfo {
  fullName: string;
  description: string;
  private: boolean;
  pushedAt: string | null;
  fork: boolean;
  archived: boolean;
}

export interface GithubStatus {
  installed: boolean;
  version: string | null;
  signedIn: boolean;
  account: string | null;
  problem: string | null;
  // What the user can run in a terminal themselves.
  commands: { install: string; signIn: string };
}

export type GhRun = (args: string[], options?: { cwd?: string; timeoutMs?: number; maxChars?: number }) => Promise<{ code: number | null; stdout: string; stderr: string; error: string | null }>;

export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_REPOS = 500;

// gh's own environment: the app's, without what belongs to Electron and 0rqestra. A GH_TOKEN the user
// set themselves stays, since that is how they chose to sign in to gh.
export function ghEnv(source: NodeJS.ProcessEnv = toolEnvironment.env()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && !/^(ELECTRON_|ORQESTRA_)/.test(k) && k !== "NODE_OPTIONS") env[k] = v;
  env.GH_PROMPT_DISABLED = "1";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  env.NO_COLOR = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export function findGh(env: NodeJS.ProcessEnv = toolEnvironment.env(), platform: NodeJS.Platform = process.platform): ToolBinary | null {
  const found = findBinary("gh", env, platform);
  if (found) return found;
  // WinGet and the installer from cli.github.com put it here.
  if (platform === "win32") {
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")]) {
      if (!base) continue;
      const file = path.join(base, "GitHub CLI", "gh.exe");
      if (fs.existsSync(file)) return { path: file, viaCmd: false, source: "native" };
    }
  }
  return null;
}

// Is this folder inside a folder that OneDrive (or a similar service) keeps in sync? A repository there is slow:
// node_modules and .git hold thousands of small files that all get uploaded.
export function isSyncedFolder(folder: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => path.resolve(p).toLowerCase();
  const target = norm(folder);
  if (platform === "win32") {
    for (const key of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
      const root = env[key];
      if (root && (target === norm(root) || target.startsWith(`${norm(root)}${path.sep}`))) return true;
    }
  }
  return /[\\/](onedrive|dropbox|google drive|icloud drive|box)([^\\/]*)([\\/]|$)/i.test(folder) || (platform === "darwin" && /[\\/]library[\\/]mobile documents[\\/]/i.test(folder));
}

export function installCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? "winget install --id GitHub.cli" : platform === "darwin" ? "brew install gh" : "See https://github.com/cli/cli#installation";
}

// What `gh api user/repos --jq` prints: one JSON object per line.
export function parseRepos(output: string): RepoInfo[] {
  const out: RepoInfo[] = [];
  for (const line of output.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const r = JSON.parse(text) as Record<string, unknown>;
      if (typeof r.full_name !== "string" || !REPO_NAME.test(r.full_name)) continue;
      out.push({
        fullName: r.full_name,
        description: typeof r.description === "string" ? r.description.slice(0, 200) : "",
        private: r.private === true,
        pushedAt: typeof r.pushed_at === "string" ? r.pushed_at : null,
        fork: r.fork === true,
        archived: r.archived === true,
      });
    } catch {
      /* not a repository line */
    }
  }
  return out.slice(0, MAX_REPOS);
}

export function parseAccount(output: string): string | null {
  const m = /Logged in to github\.com (?:account|as) (\S+)/i.exec(output);
  return m ? m[1]!.replace(/[^A-Za-z0-9_-]/g, "") || null : null;
}

export function realGhRun(find: () => ToolBinary | null = () => findGh(), env: () => NodeJS.ProcessEnv = () => ghEnv()): GhRun {
  return (args, options = {}) => new Promise((resolve) => {
    const bin = find();
    if (!bin) return resolve({ code: null, stdout: "", stderr: "", error: "gh is not installed" });
    let child;
    try {
      child = spawnTool({ bin, args, cwd: options.cwd, env: env() });
    } catch (error) {
      return resolve({ code: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) });
    }
    const cap = options.maxChars ?? 4_000_000;
    let stdout = "";
    let stderr = "";
    let error: string | null = null;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { if (stdout.length < cap) stdout += d; });
    child.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.stdin?.end();
    const timer = setTimeout(() => { error = `timed out after ${Math.round((options.timeoutMs ?? 60_000) / 1000)} seconds`; killTree(child); }, options.timeoutMs ?? 60_000);
    child.on("error", (e) => (error = e.message));
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, error }); });
  });
}

export class GithubClient {
  private cache: { at: number; repos: RepoInfo[] } | null = null;

  constructor(private readonly run: GhRun = realGhRun(), private readonly platform: NodeJS.Platform = process.platform, private readonly now: () => number = Date.now) {}

  async status(): Promise<GithubStatus> {
    const commands = { install: installCommand(this.platform), signIn: "gh auth login" };
    const version = await this.run(["--version"], { timeoutMs: 15_000 });
    if (version.error || version.code !== 0) {
      const missing = !version.error || /not installed|ENOENT/i.test(version.error);
      return { installed: !missing, version: null, signedIn: false, account: null, commands, problem: missing ? "GitHub CLI (gh) is not installed." : `gh did not start (${version.error ?? `exit ${version.code}`}).` };
    }
    const v = /gh version (\S+)/.exec(version.stdout)?.[1] ?? null;
    const auth = await this.run(["auth", "status", "--hostname", "github.com"], { timeoutMs: 20_000 });
    const text = `${auth.stdout}\n${auth.stderr}`;
    const signedIn = auth.code === 0;
    return { installed: true, version: v, signedIn, account: signedIn ? parseAccount(text) : null, commands, problem: signedIn ? null : "Not signed in to GitHub." };
  }

  // Every repository the account can see (own, shared with it, and its organisations'), newest push first.
  async repos(refresh = false): Promise<RepoInfo[]> {
    if (!refresh && this.cache && this.now() - this.cache.at < 120_000) return this.cache.repos;
    const r = await this.run([
      "api", "--paginate", "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
      "--jq", ".[] | {full_name, description, private, pushed_at, fork, archived}",
    ], { timeoutMs: 90_000 });
    const repos = parseRepos(r.stdout);
    if (r.code !== 0 && !repos.length) {
      const why = `${r.stderr} ${r.error ?? ""}`;
      throw new Error(/auth|login|401|token/i.test(why) ? "Not signed in to GitHub. Sign in, then try again." : `GitHub did not answer: ${why.trim().slice(0, 200) || `exit ${r.code}`}`);
    }
    this.cache = { at: this.now(), repos };
    return repos;
  }

  forget(): void {
    this.cache = null;
  }

  // Clones "owner/name" into <parent>/<name>. A folder that already holds a clone of the same repository is
  // used as it is; any other existing folder is refused.
  async clone(fullName: unknown, parent: string): Promise<{ path: string; reused: boolean }> {
    if (typeof fullName !== "string" || !REPO_NAME.test(fullName)) throw new Error("Choose a repository from the list.");
    if (typeof parent !== "string" || !path.isAbsolute(parent) || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error("Choose a folder to put the repository in.");
    const name = fullName.split("/")[1]!;
    if (name === "." || name === "..") throw new Error("Choose a repository from the list.");
    const dest = path.join(parent, name);
    if (fs.existsSync(dest)) {
      if (!fs.statSync(dest).isDirectory()) throw new Error(`${dest} is a file, not a folder.`);
      if (fs.readdirSync(dest).length === 0) {
        /* an empty folder: clone into it */
      } else {
        const origin = await this.run(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: dest, timeoutMs: 30_000 });
        if (origin.code === 0 && origin.stdout.trim().toLowerCase() === fullName.toLowerCase()) return { path: dest, reused: true };
        throw new Error(`The folder ${dest} already exists and is not a clone of ${fullName}. Choose another folder.`);
      }
    }
    const r = await this.run(["repo", "clone", fullName, dest], { timeoutMs: 15 * 60_000 });
    if (r.code !== 0) {
      fs.rmSync(dest, { recursive: true, force: true });
      const why = `${r.stderr} ${r.error ?? ""}`.trim();
      throw new Error(/git.*(not found|not recognized|ENOENT)|command not found/i.test(why) ? "git is not installed on this computer, so the repository could not be cloned." : `Cloning failed: ${why.slice(0, 300) || `exit ${r.code}`}`);
    }
    return { path: dest, reused: false };
  }
}
