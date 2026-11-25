import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ghEnv, GithubClient, installCommand, parseAccount, parseRepos, realGhRun, REPO_NAME } from "./github.js";

const fake = path.join(__dirname, "fake-gh.mjs");
let dir: string;
let log: string;
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "orq-gh-")));
  log = path.join(dir, "log.jsonl");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));

// realGhRun starts the binary with only the arguments given, so the fake script is the first one.
const withScript = (mode = "signed-in", extra: Record<string, string> = {}) => {
  const run = realGhRun(() => ({ path: process.execPath, viaCmd: false }), () => ({ ...ghEnv(process.env), FAKE_GH: mode, FAKE_LOG: log, ...extra }));
  return new GithubClient((args, options) => run([fake, ...args], options), "win32");
};

describe("GitHub through gh", () => {
  it("reads the status: installed, signed in as someone, or not", async () => {
    expect(await withScript().status()).toMatchObject({ installed: true, version: "2.89.0", signedIn: true, account: "philip-s", problem: null, commands: { install: "winget install --id GitHub.cli", signIn: "gh auth login" } });
    expect(await withScript("signed-out").status()).toMatchObject({ installed: true, signedIn: false, account: null, problem: "Not signed in to GitHub." });
    const none = await new GithubClient(async () => ({ code: null, stdout: "", stderr: "", error: "gh is not installed" }), "darwin").status();
    expect(none).toMatchObject({ installed: false, signedIn: false, commands: { install: "brew install gh" } });
  });

  it("lists the repositories, keeps only well-formed ones, and asks gh in a safe way", async () => {
    const repos = await withScript().repos();
    expect(repos.map((r) => r.fullName)).toEqual(["SEASTICK/0rqestra", "SEASTICK/quantbot", "school-org/lab"]);
    expect(repos[1]).toMatchObject({ private: true, description: "" });
    expect(repos[2]).toMatchObject({ fork: true, archived: true, pushedAt: null });
    expect(repos[2]!.description.length).toBe(200);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls.at(-1).args.slice(0, 3)).toEqual(["api", "--paginate", "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member"]);
    // gh never prompts, and a token is never asked for.
    expect(calls.at(-1).prompt).toBe("1");
    expect(JSON.stringify(calls)).not.toContain("auth token");
  });

  it("explains a missing sign-in when listing", async () => {
    await expect(withScript("signed-out").repos()).rejects.toThrow(/Not signed in to GitHub/);
    expect(await withScript("none-found").repos()).toEqual([]);
  });

  it("clones into the chosen folder, reuses an existing clone of the same repository, and refuses any other folder", async () => {
    const c = withScript();
    const first = await c.clone("SEASTICK/0rqestra", dir);
    expect(first).toEqual({ path: path.join(dir, "0rqestra"), reused: false });
    expect(fs.readFileSync(path.join(first.path, "README.md"), "utf8")).toContain("SEASTICK/0rqestra");
    expect(await c.clone("seastick/0rqestra", dir)).toEqual({ path: first.path, reused: true });
    // Another repository with the same name, a plain folder with files, and a file.
    await expect(c.clone("someone-else/0rqestra", dir)).rejects.toThrow(/not a clone of someone-else\/0rqestra/);
    fs.mkdirSync(path.join(dir, "lab"));
    fs.writeFileSync(path.join(dir, "lab", "notes.txt"), "mine");
    await expect(c.clone("school-org/lab", dir)).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(path.join(dir, "lab", "notes.txt"), "utf8")).toBe("mine");
    fs.writeFileSync(path.join(dir, "file"), "x");
    await expect(c.clone("a/file", dir)).rejects.toThrow(/is a file/);
    // An empty folder is cloned into.
    fs.mkdirSync(path.join(dir, "quantbot"));
    expect((await c.clone("SEASTICK/quantbot", dir)).reused).toBe(false);
  });

  it("removes a failed clone and says why, and refuses anything that is not owner/name", async () => {
    await expect(withScript("fail-clone").clone("SEASTICK/0rqestra", dir)).rejects.toThrow(/Cloning failed.*Username/);
    expect(fs.existsSync(path.join(dir, "0rqestra"))).toBe(false);
    const c = withScript();
    for (const bad of ["../x", "a/b/c", "a b/c", "--upload-pack=x/y", "", 5, null, "owner/..", "-x/y"]) await expect(c.clone(bad, dir)).rejects.toThrow(/Choose a repository/);
    await expect(c.clone("a/b", "relative/folder")).rejects.toThrow(/Choose a folder/);
    await expect(c.clone("a/b", path.join(dir, "nope"))).rejects.toThrow(/Choose a folder/);
  });

  it("has small pure helpers that are safe", () => {
    expect(REPO_NAME.test("SEASTICK/0rqestra")).toBe(true);
    expect(REPO_NAME.test("-flag/x")).toBe(false);
    expect(parseAccount("✓ Logged in to github.com account philip-s (keyring)")).toBe("philip-s");
    expect(parseAccount("Logged in to github.com as old-style-user (oauth_token)")).toBe("old-style-user");
    expect(parseAccount("nothing")).toBeNull();
    expect(parseRepos('{"full_name":"a/b","private":true}\n{broken\n')).toEqual([{ fullName: "a/b", description: "", private: true, pushedAt: null, fork: false, archived: false }]);
    expect(installCommand("linux")).toMatch(/cli\/cli/);
    const env = ghEnv({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", ORQESTRA_X: "1", NODE_OPTIONS: "--x", GH_TOKEN: "mine" });
    expect(env).toMatchObject({ PATH: "/bin", GH_TOKEN: "mine", GH_PROMPT_DISABLED: "1" });
    expect(Object.keys(env).some((k) => /^(ELECTRON_|ORQESTRA_)/.test(k) || k === "NODE_OPTIONS")).toBe(false);
  });
});

describe("Folders that a cloud service keeps in sync", () => {
  it("knows OneDrive on Windows and other sync folders, and not a plain folder", async () => {
    const { isSyncedFolder } = await import("./github.js");
    const env = { OneDrive: "C:\\Users\\philip\\OneDrive - Personligt", OneDriveConsumer: "C:\\Users\\philip\\OneDrive" };
    expect(isSyncedFolder("C:\\Users\\philip\\OneDrive - Personligt\\Dokument", env, "win32")).toBe(true);
    expect(isSyncedFolder("C:\\Users\\philip\\repos", env, "win32")).toBe(false);
    expect(isSyncedFolder("/Users/p/Dropbox/work", {}, "darwin")).toBe(true);
    expect(isSyncedFolder("/Users/p/Library/Mobile Documents/com~apple~CloudDocs/x", {}, "darwin")).toBe(true);
    expect(isSyncedFolder("/home/p/repos", {}, "linux")).toBe(false);
  });
});
