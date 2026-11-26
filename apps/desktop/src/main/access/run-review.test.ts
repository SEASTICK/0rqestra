import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessService } from "./access-service.js";
import { AccessStore } from "./access-store.js";

// Review changes from a run card: one run's files only, re-checked when applied.

let dir: string;
let checkout: string;
let workspace: string;
let branch: string | null;
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "orq-review-")));
  checkout = path.join(dir, "checkout");
  workspace = path.join(dir, "workspace");
  for (const d of [checkout, workspace]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(checkout, "app.ts"), "export const app = 1;\n");
  branch = "main";
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(opts: { write?: boolean; reserved?: string | null; ledgerDir?: string } = {}) {
  const store = new AccessStore(path.join(dir, "data"));
  const service = new AccessService(store, () => workspace, () => {}, () => opts.reserved ?? null, {
    ...(opts.ledgerDir ? { ledgerDir: opts.ledgerDir } : {}),
    checkoutFor: () => checkout,
    branchOf: async () => branch,
  });
  const folder = store.addFolder("p1", checkout).folders[0]!;
  if (opts.write !== false) store.setFolderWrite("p1", folder.id, true);
  store.setAgent("p1", "builder", { write: true });
  return { store, service, folder };
}

// What a run does to the workspace and tells the access service.
function deliver(service: AccessService, runId: string, taskId: string, files: Record<string, string>, outcome: { status: string; approved?: boolean; note?: string } = { status: "done", approved: true, note: "Approved by Vera." }) {
  for (const [p, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(workspace, p)), { recursive: true });
    fs.writeFileSync(path.join(workspace, p), content);
  }
  service.recordFiles("p1", runId, taskId, "builder", "Bob", Object.keys(files));
  if (outcome.approved !== undefined) service.runEvent("p1", runId, { type: "review", taskId, approved: outcome.approved, problems: [] });
  service.runEvent("p1", runId, { type: "task", taskId, status: outcome.status, ...(outcome.note ? { note: outcome.note } : {}) });
  service.runEvent("p1", runId, { type: "run-finished", status: "done" });
}

const read = (p: string) => fs.readFileSync(path.join(checkout, p), "utf8");

describe("reviewing one run's changes", () => {
  it("shows the run's files with the linked checkout, branch and review status, and applies one chosen file", async () => {
    const { service, folder } = setup();
    deliver(service, "r1", "t1", { "app.ts": "export const app = 2;\n", "new.ts": "export const n = 1;\n" });
    expect(service.pendingByRun("p1")).toEqual({ r1: { pending: 2, current: 2 } });
    const review = await service.reviewRun("p1", "r1");
    expect(review.destination).toMatchObject({ id: folder.id, path: checkout, write: true, isCheckout: true });
    expect(review.branch).toBe("main");
    expect(review.needsAccess).toBe(false);
    expect(review.checks).toEqual([]);
    const byPath = Object.fromEntries(review.files.map((f) => [f.path, f]));
    expect(byPath["app.ts"]).toMatchObject({ status: "ready", isNew: false, verification: { state: "reviewed" } });
    expect(byPath["app.ts"]!.diff).toContain("+export const app = 2;");
    expect(byPath["new.ts"]).toMatchObject({ status: "ready", isNew: true });
    const r = await service.applyRun("p1", "r1", review.previewId, ["app.ts"]);
    expect(r).toMatchObject({ applied: ["app.ts"], conflicts: [], blocked: [], stale: null, remaining: { pending: 1, current: 1 } });
    expect(read("app.ts")).toBe("export const app = 2;\n");
    expect(fs.existsSync(path.join(checkout, "new.ts"))).toBe(false);
    // The applied file is no longer offered; the other one still is.
    expect((await service.reviewRun("p1", "r1")).files.map((f) => f.path)).toEqual(["new.ts"]);
  });

  it("keeps each run's review to its own files, and an older run never applies a later run's version", async () => {
    const { service } = setup();
    deliver(service, "r1", "t1", { "app.ts": "export const app = 'r1';\n", "only-r1.ts": "r1" });
    deliver(service, "r2", "t1", { "app.ts": "export const app = 'r2';\n", "only-r2.ts": "r2" });
    const one = await service.reviewRun("p1", "r1");
    const two = await service.reviewRun("p1", "r2");
    expect(one.files.map((f) => f.path)).toEqual(["app.ts", "only-r1.ts"]);
    expect(two.files.map((f) => f.path)).toEqual(["app.ts", "only-r2.ts"]);
    const oldApp = one.files.find((f) => f.path === "app.ts")!;
    expect(oldApp.status).toBe("replaced");
    expect(oldApp.reason).toMatch(/later run/);
    expect(oldApp.diff).toBe("");
    expect(service.pendingByRun("p1")).toEqual({ r1: { pending: 2, current: 1 }, r2: { pending: 2, current: 2 } });
    // Even when asked for directly, r1's review refuses app.ts and another run's file.
    const r = await service.applyRun("p1", "r1", one.previewId, ["app.ts", "only-r2.ts", "only-r1.ts"]);
    expect(r.applied).toEqual(["only-r1.ts"]);
    expect(r.blocked.map((b) => b.path).sort()).toEqual(["app.ts", "only-r2.ts"]);
    expect(read("app.ts")).toBe("export const app = 1;\n");
    expect(fs.existsSync(path.join(checkout, "only-r2.ts"))).toBe(false);
    // A preview of one run cannot be used for another.
    await expect(service.applyRun("p1", "r2", one.previewId, ["app.ts"])).rejects.toThrow(/review again/);
  });

  it("notices a later run that changed a file after the older review was opened", async () => {
    const { service } = setup();
    deliver(service, "r1", "t1", { "app.ts": "export const app = 'r1';\n" });
    const one = await service.reviewRun("p1", "r1");
    expect(one.files[0]!.status).toBe("ready");
    deliver(service, "r2", "t1", { "app.ts": "export const app = 'r2';\n" });
    const r = await service.applyRun("p1", "r1", one.previewId, ["app.ts"]);
    expect(r.applied).toEqual([]);
    expect(r.blocked[0]!.reason).toMatch(/later run/);
    expect(r.stale).toBeTruthy();
    expect(read("app.ts")).toBe("export const app = 1;\n");
  });

  it("keeps a local edit made after the diff was opened and marks the review stale", async () => {
    const { service } = setup();
    deliver(service, "r1", "t1", { "app.ts": "export const app = 2;\n" });
    const review = await service.reviewRun("p1", "r1");
    fs.writeFileSync(path.join(checkout, "app.ts"), "my local edit\n");
    const r = await service.applyRun("p1", "r1", review.previewId, ["app.ts"]);
    expect(r.applied).toEqual([]);
    expect(r.conflicts.map((c) => c.path)).toEqual(["app.ts"]);
    expect(r.stale).toMatch(/Refresh/);
    expect(read("app.ts")).toBe("my local edit\n");
    // Still waiting, with a fresh diff against the local edit.
    const again = await service.reviewRun("p1", "r1");
    expect(again.files[0]!.diff).toContain("-my local edit");
  });

  it("writes nothing when the branch was switched after the diff was opened", async () => {
    const { service } = setup();
    deliver(service, "r1", "t1", { "app.ts": "export const app = 2;\n", "new.ts": "n" });
    const review = await service.reviewRun("p1", "r1");
    branch = "feature";
    const r = await service.applyRun("p1", "r1", review.previewId, ["app.ts", "new.ts"]);
    expect(r.applied).toEqual([]);
    expect(r.stale).toMatch(/main to feature/);
    expect(r.blocked).toHaveLength(2);
    expect(read("app.ts")).toBe("export const app = 1;\n");
    expect(fs.existsSync(path.join(checkout, "new.ts"))).toBe(false);
    expect((await service.reviewRun("p1", "r1")).branch).toBe("feature");
  });

  it("asks for Computer access when the checkout is read-only, and blocks every file", async () => {
    const { service, store, folder } = setup({ write: false });
    deliver(service, "r1", "t1", { "app.ts": "export const app = 2;\n" });
    const review = await service.reviewRun("p1", "r1");
    expect(review.needsAccess).toBe(true);
    expect(review.destination).toMatchObject({ id: folder.id, write: false });
    expect(review.checkout).toMatchObject({ granted: true, write: false });
    expect(review.files[0]).toMatchObject({ status: "blocked", reason: expect.stringMatching(/read-only/) });
    expect(review.files[0]!.diff).toContain("+export const app = 2;");
    await expect(service.applyRun("p1", "r1", review.previewId, ["app.ts"])).resolves.toMatchObject({ applied: [], blocked: [{ path: "app.ts" }] });
    // Write permission taken away after the review was opened: refused too.
    store.setFolderWrite("p1", folder.id, true);
    const writable = await service.reviewRun("p1", "r1");
    store.setFolderWrite("p1", folder.id, false);
    const r = await service.applyRun("p1", "r1", writable.previewId, ["app.ts"]);
    expect(r.applied).toEqual([]);
    expect(r.blocked[0]!.reason).toMatch(/read-only/);
    expect(read("app.ts")).toBe("export const app = 1;\n");
  });

  it("tells reviewed, unverified and blocked files apart, and never applies a blocked one", async () => {
    const { service } = setup();
    deliver(service, "r1", "t1", { "a.ts": "a" });
    deliver(service, "r1", "t2", { "b.ts": "b" }, { status: "unverified", note: "No reviewer in the tree, so this was not checked." });
    deliver(service, "r1", "t3", { "c.ts": "c" }, { status: "failed", approved: false, note: "Not approved." });
    const review = await service.reviewRun("p1", "r1");
    const state = Object.fromEntries(review.files.map((f) => [f.path, [f.verification.state, f.status]]));
    expect(state).toEqual({ "a.ts": ["reviewed", "ready"], "b.ts": ["unverified", "ready"], "c.ts": ["blocked", "blocked"] });
    const r = await service.applyRun("p1", "r1", review.previewId, ["a.ts", "b.ts", "c.ts"]);
    expect(r.applied.sort()).toEqual(["a.ts", "b.ts"]);
    expect(fs.existsSync(path.join(checkout, "c.ts"))).toBe(false);
  });

  it("blocks files a teammate has reserved", async () => {
    const { service } = setup({ reserved: "Ola has reserved app.ts for “Login”." });
    deliver(service, "r1", "t1", { "app.ts": "export const app = 2;\n" });
    const review = await service.reviewRun("p1", "r1");
    expect(review.files[0]).toMatchObject({ status: "blocked", reason: expect.stringContaining("Ola") });
  });

  it("shows only checks the app ran during the run, and keeps the ledger across a restart", async () => {
    const ledgerDir = path.join(dir, "changes");
    const { service, store, folder } = setup({ ledgerDir });
    store.setAgent("p1", "tester", { commands: true });
    store.addCommand("p1", { label: "Tests", command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`, folderId: folder.id, cwd: "" });
    const commandId = store.project("p1").commands[0]!.id;
    deliver(service, "r1", "t1", { "app.ts": "export const app = 2;\n" });
    await service.gateFor("p1", "r1").check("tester", "Tess", commandId);
    await service.gateFor("p1", "r2").check("tester", "Tess", commandId);
    const restarted = new AccessService(store, () => workspace, () => {}, () => null, { ledgerDir, checkoutFor: () => checkout, branchOf: async () => branch });
    const review = await restarted.reviewRun("p1", "r1");
    expect(review.files.map((f) => f.path)).toEqual(["app.ts"]);
    expect(review.checks).toMatchObject([{ label: "Tests", exitCode: 0, passed: true, agent: "Tess" }]);
    expect(restarted.pendingByRun("p1")).toEqual({ r1: { pending: 1, current: 1 } });
  });

  it("forgets a run's waiting changes after Undo", async () => {
    const { service } = setup();
    deliver(service, "r1", "t1", { "app.ts": "export const app = 2;\n" });
    service.dismissRun("p1", "r1");
    expect(service.pendingByRun("p1")).toEqual({});
    expect((await service.reviewRun("p1", "r1")).files).toEqual([]);
  });
});
