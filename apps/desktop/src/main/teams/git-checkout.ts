import { execFile } from "node:child_process";
import type { RemoteInfo } from "./repo-identity";

// Reads what Teams needs from a local checkout with plain Git commands that only read configuration:
// the top folder, the current branch, and the remotes. Nothing is fetched, changed or checked out.

export type GitRunner = (cwd: string, args: string[]) => Promise<{ ok: true; stdout: string } | { ok: false; error: string; missingGit?: boolean }>;

export interface CheckoutFacts {
  root: string;
  // null when HEAD is detached.
  branch: string | null;
  remotes: RemoteInfo[];
}

export type CheckoutRead = { ok: true; facts: CheckoutFacts } | { ok: false; problem: string };

export function gitRunner(env: () => NodeJS.ProcessEnv): GitRunner {
  return (cwd, args) =>
    new Promise((resolve) => {
      execFile("git", ["-C", cwd, ...args], { env: { ...env(), GIT_TERMINAL_PROMPT: "0" }, windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout: String(stdout) });
        const code = (error as NodeJS.ErrnoException).code;
        resolve({ ok: false, error: String(stderr || error.message).trim(), missingGit: code === "ENOENT" });
      });
    });
}

export async function readCheckout(dir: string, git: GitRunner): Promise<CheckoutRead> {
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    if (top.missingGit) return { ok: false, problem: "Git was not found on this computer. Install Git (git-scm.com) and try again." };
    if (/dubious ownership/i.test(top.error)) {
      return { ok: false, problem: "Git refuses to read this folder because it belongs to another user (\"dubious ownership\"). Mark it as safe with git config --global --add safe.directory <folder>, then try again." };
    }
    return { ok: false, problem: "This folder is not a Git checkout. Choose the folder you cloned the repository into." };
  }
  const root = top.stdout.trim();
  const names = await git(root, ["remote"]);
  if (!names.ok) return { ok: false, problem: `Git could not list the remotes: ${names.error}` };
  const remotes: RemoteInfo[] = [];
  for (const name of names.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    // get-url applies url.<base>.insteadOf rewrites, as a fetch would.
    const url = await git(root, ["remote", "get-url", name]);
    if (url.ok) remotes.push({ name, url: url.stdout.trim() });
  }
  const head = await git(root, ["branch", "--show-current"]);
  const branch = head.ok && head.stdout.trim() ? head.stdout.trim() : null;
  return { ok: true, facts: { root, branch, remotes } };
}
