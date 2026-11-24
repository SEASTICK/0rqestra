import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessService } from "./access-service.js";
import { AccessStore } from "./access-store.js";
import { gitCommit, gitPush, gitRunner, gitState, insideGitFolder } from "./git.js";

let dir: string;
let repo: string;
let remote: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=" + path.join(dir, "none"), ...args], { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orq-git-")));
  remote = path.join(dir, "remote.git");
  repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "dev@example.com");
  git(repo, "config", "user.name", "Dev");
  git(repo, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "# App\n");
  fs.writeFileSync(path.join(repo, "other.txt"), "other\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  git(repo, "remote", "add", "origin", remote);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("commit and push what the user applied", () => {
  it("commits only the chosen files, with the message, and never runs the repository's hooks", async () => {
    const run = gitRunner(path.join(dir, "no-hooks"));
    const marker = path.join(dir, "hook-ran.txt");
    fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho ran > "${marker.replace(/\\/g, "/")}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(repo, "README.md"), "# Better app\n");
    fs.writeFileSync(path.join(repo, "other.txt"), "my own edit, not for this commit\n");
    fs.writeFileSync(path.join(repo, "new.md"), "new\n");
    const r = await gitCommit(run, repo, ["README.md", "new.md"], "Tydligare rubrik");
    expect(r.branch).toBe("main");
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Tydligare rubrik");
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["README.md", "new.md"]);
    expect(git(repo, "status", "--porcelain")).toContain("other.txt");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses paths outside the folder or inside .git, and an empty message", async () => {
    const run = gitRunner(path.join(dir, "no-hooks"));
    await expect(gitCommit(run, repo, ["../x"], "m")).rejects.toThrow(/cannot be committed/);
    await expect(gitCommit(run, repo, [".git/config"], "m")).rejects.toThrow(/cannot be committed/);
    await expect(gitCommit(run, repo, ["README.md"], "  ")).rejects.toThrow(/message/);
    await expect(gitCommit(run, repo, ["README.md"], "same")).rejects.toThrow(/Nothing to commit/);
    expect(insideGitFolder("sub/.GIT/hooks/x")).toBe(true);
    expect(insideGitFolder("src/gitignore.md")).toBe(false);
  });

  it("pushes to origin, then to the upstream it set", async () => {
    const run = gitRunner(path.join(dir, "no-hooks"));
    expect(await gitState(run, repo)).toMatchObject({ repo: true, branch: "main", upstream: null, remote: true });
    await gitPush(run, repo);
    expect(git(repo, "rev-parse", "HEAD")).toBe(execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf8" }).trim());
    fs.writeFileSync(path.join(repo, "README.md"), "# Two\n");
    await gitCommit(run, repo, ["README.md"], "two");
    expect(await gitState(run, repo)).toMatchObject({ upstream: "origin/main", ahead: 1 });
    await gitPush(run, repo);
    expect(await gitState(run, repo)).toMatchObject({ ahead: 0 });
  });

  it("says when a folder is no repository", async () => {
    const plain = path.join(dir, "plain");
    fs.mkdirSync(plain);
    expect(await gitState(gitRunner(path.join(dir, "no-hooks")), plain)).toMatchObject({ repo: false });
  });

  it("never applies an agent's file inside .git, and commits only in a folder that accepts changes", async () => {
    const store = new AccessStore(path.join(dir, "data"));
    const workspace = path.join(dir, "ws");
    fs.mkdirSync(path.join(workspace, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".git", "hooks", "pre-push"), "evil");
    const service = new AccessService(store, () => workspace, () => {}, () => null, gitRunner(path.join(dir, "no-hooks")));
    const folder = store.addFolder("p1", repo).folders[0]!;
    store.setAgent("p1", "builder", { write: true });
    await expect(service.commit("p1", folder.id, ["README.md"], "m")).rejects.toThrow(/Allow changes/);
    store.setFolderWrite("p1", folder.id, true);
    service.recordFiles("p1", "r1", "t1", "builder", "Bob", [".git/hooks/pre-push"]);
    const preview = service.previewApply("p1", folder.id);
    expect(preview.items[0]).toMatchObject({ status: "blocked" });
    expect(service.apply("p1", preview.previewId, [".git/hooks/pre-push"]).applied).toEqual([]);
    expect(fs.existsSync(path.join(repo, ".git", "hooks", "pre-push"))).toBe(false);
  });
});
