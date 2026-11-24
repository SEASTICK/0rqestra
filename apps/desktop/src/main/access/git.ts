import { spawn } from "node:child_process";
import fs from "node:fs";
import { liveRoot, relativeParts } from "./paths";

// Commit and push what the user applied to a granted folder. Only the user starts these, with a
// button, never an agent. git runs without a shell (arguments, not a command line), never asks in a
// terminal, and with the repository's hooks switched off: a hook is code in the repository, and the
// files that just arrived there were written by agents. Pushing uses the user's own git sign-in
// (their credential helper), as when they push in a terminal.

export interface GitResult { code: number | null; out: string }
export type GitRunner = (cwd: string, args: string[], timeoutMs?: number) => Promise<GitResult>;

export interface GitState {
  repo: boolean;
  branch: string | null;
  upstream: string | null;
  // Commits on this branch that are not on its upstream yet.
  ahead: number;
  remote: boolean;
  problem: string | null;
}

const OUTPUT = 8000;

// True for a path inside a .git folder (any of its parts). Such files are never applied or committed.
export function insideGitFolder(rel: string): boolean {
  return rel.replace(/\\/g, "/").split("/").some((p) => p.toLowerCase() === ".git");
}

export function gitRunner(noHooksDir: string): GitRunner {
  return (cwd, args, timeoutMs = 60_000) => new Promise((resolve) => {
    fs.mkdirSync(noHooksDir, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_PAGER: "cat", LC_ALL: "C" };
    let out = "";
    let child;
    try {
      child = spawn("git", ["-c", `core.hooksPath=${noHooksDir}`, ...args], { cwd, env, windowsHide: true, shell: false });
    } catch (error) {
      resolve({ code: null, out: (error as Error).message });
      return;
    }
    const add = (b: Buffer) => { if (out.length < OUTPUT * 2) out += b.toString("utf8"); };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const timer = setTimeout(() => { out += "\nStopped: git took too long."; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (error) => { out += `\n${error.message.includes("ENOENT") ? "git is not installed on this computer." : error.message}`; });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out: out.length > OUTPUT ? out.slice(-OUTPUT) : out }); });
  });
}

export async function gitState(run: GitRunner, folder: string): Promise<GitState> {
  const none = (problem: string | null): GitState => ({ repo: false, branch: null, upstream: null, ahead: 0, remote: false, problem });
  let cwd: string;
  try {
    cwd = liveRoot(folder);
  } catch (error) {
    return none((error as Error).message);
  }
  const inside = await run(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out.trim() !== "true") return none(/not installed/.test(inside.out) ? "git is not installed on this computer." : null);
  const branch = (await run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).out.trim() || null;
  const up = await run(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const upstream = up.code === 0 ? up.out.trim() : null;
  const ahead = upstream ? Number((await run(cwd, ["rev-list", "--count", "@{u}..HEAD"])).out.trim()) || 0 : 0;
  const remote = (await run(cwd, ["remote"])).out.trim().length > 0;
  return { repo: true, branch: branch === "HEAD" ? null : branch, upstream, ahead, remote, problem: null };
}

// Commits exactly these files (paths inside the folder), with the user's message.
export async function gitCommit(run: GitRunner, folder: string, paths: unknown, message: unknown): Promise<{ commit: string; branch: string | null }> {
  const cwd = liveRoot(folder);
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) throw new Error("Write a commit message.");
  if (text.length > 5000) throw new Error("The commit message is too long.");
  const files = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
  if (!files.length || files.length > 500) throw new Error("Choose the files to commit.");
  for (const f of files) {
    if (!relativeParts(f)?.length || insideGitFolder(f)) throw new Error(`"${f}" cannot be committed.`);
  }
  const state = await gitState(run, folder);
  if (!state.repo) throw new Error(state.problem ?? "This folder is not a git repository.");
  const add = await run(cwd, ["add", "--", ...files]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.out.trim()}`);
  const commit = await run(cwd, ["commit", "-m", text, "--", ...files]);
  if (commit.code !== 0) throw new Error(/nothing to commit|no changes added/i.test(commit.out) ? "Nothing to commit: these files are already the same in git." : `git commit failed: ${commit.out.trim()}`);
  const sha = (await run(cwd, ["rev-parse", "--short", "HEAD"])).out.trim();
  return { commit: sha, branch: state.branch };
}

// Pushes the current branch: to its upstream, or to origin (and sets it as the upstream).
export async function gitPush(run: GitRunner, folder: string): Promise<{ branch: string | null; output: string }> {
  const cwd = liveRoot(folder);
  const state = await gitState(run, folder);
  if (!state.repo) throw new Error(state.problem ?? "This folder is not a git repository.");
  if (!state.branch) throw new Error("No branch is checked out, so there is nothing to push.");
  if (!state.upstream && !state.remote) throw new Error("This repository has no remote to push to.");
  const args = state.upstream ? ["push"] : ["push", "-u", "origin", "HEAD"];
  const r = await run(cwd, args, 120_000);
  if (r.code !== 0) {
    const auth = /authentication|permission denied|could not read username|403|401/i.test(r.out);
    throw new Error(auth ? `git could not sign in to push. Push once in a terminal to sign in, then try again.\n${r.out.trim()}` : `git push failed: ${r.out.trim()}`);
  }
  return { branch: state.branch, output: r.out.trim() };
}
