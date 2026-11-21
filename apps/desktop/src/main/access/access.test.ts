import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventQueue, type ChatEvent, type ChatRequest, type ProviderAdapter, type ProviderId, type ProviderStatus } from "../providers/types.js";
import { parsePlan } from "../team/plan.js";
import { TeamRun, type TeamEvent } from "../team/runner.js";
import { parseAgents } from "../team/team-service.js";
import { AccessService } from "./access-service.js";
import { AccessStore } from "./access-store.js";
import { AccessDenied, relativeParts, resolveForRead, resolveForWrite, writeInside } from "./paths.js";

// Computer access: agents reach this computer only through these checks. The tests use real files,
// real Windows junctions and (where Windows allows it without admin rights) symbolic links.

let dir: string;
let granted: string;
let outside: string;
let workspace: string;
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "orq-access-")));
  granted = path.join(dir, "checkout");
  outside = path.join(dir, "private");
  workspace = path.join(dir, "workspace");
  for (const d of [granted, outside, workspace, path.join(granted, "src")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(granted, "src", "app.ts"), "export const app = 1;\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function junction(target: string, at: string): void {
  fs.symlinkSync(target, at, "junction");
}

function fileLink(target: string, at: string): boolean {
  try {
    fs.symlinkSync(target, at, "file");
    return true;
  } catch {
    return false; // Windows without developer mode: symbolic file links need admin rights.
  }
}

describe("paths inside a granted folder", () => {
  it("accepts plain relative paths and refuses traversal, drives, streams and device names", () => {
    expect(relativeParts("src/app.ts")).toEqual(["src", "app.ts"]);
    expect(relativeParts("src\\app.ts")).toEqual(["src", "app.ts"]);
    for (const bad of ["../private/secret.txt", "src/../../private", "C:\\Windows\\win.ini", "/etc/passwd", "~/x", "src/app.ts:stream", "nul", "src/con.txt", "a\u0000b"]) {
      if (process.platform !== "win32" && /nul|con/.test(bad)) continue;
      expect(relativeParts(bad), bad).toBeNull();
    }
  });

  it("reads inside and refuses .. escapes", () => {
    expect(resolveForRead(granted, "src/app.ts")).toBe(path.join(granted, "src", "app.ts"));
    expect(() => resolveForRead(granted, "../private/secret.txt")).toThrow(AccessDenied);
  });

  it("refuses a junction inside the folder that points outside, for reading and writing", () => {
    junction(outside, path.join(granted, "escape"));
    expect(() => resolveForRead(granted, "escape/secret.txt")).toThrow(/outside/);
    expect(() => resolveForWrite(granted, "escape/new.txt")).toThrow(/outside/);
    expect(() => writeInside(granted, "escape/new.txt", "x")).toThrow(AccessDenied);
    expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false);
  });

  it("refuses a granted folder that was replaced by a junction elsewhere", () => {
    fs.rmSync(granted, { recursive: true });
    junction(outside, granted);
    expect(() => resolveForRead(granted, "secret.txt")).toThrow(/now leads to/);
  });

  it("refuses a symbolic file link that points outside (when Windows allows creating one)", () => {
    if (!fileLink(path.join(outside, "secret.txt"), path.join(granted, "link.txt"))) return;
    expect(() => resolveForRead(granted, "link.txt")).toThrow(/outside/);
    expect(() => writeInside(granted, "link.txt", "x")).toThrow(/link/);
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("SECRET");
  });

  it("refuses to write a hard link shared with a file outside", () => {
    fs.linkSync(path.join(outside, "secret.txt"), path.join(granted, "hard.txt"));
    expect(() => writeInside(granted, "hard.txt", "changed")).toThrow(/hard link/);
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("SECRET");
  });

  it("writes new files and folders inside", () => {
    writeInside(granted, "src/new/deep.ts", "ok");
    expect(fs.readFileSync(path.join(granted, "src", "new", "deep.ts"), "utf8")).toBe("ok");
  });
});

describe("access store", () => {
  it("allows nothing by default, grants folders read-only, and write implies read", () => {
    const store = new AccessStore(dir);
    expect(store.agent("p1", "k1")).toEqual({ read: false, write: false, commands: false });
    const v = store.addFolder("p1", granted);
    expect(v.folders).toMatchObject([{ path: granted, write: false, available: true }]);
    store.setAgent("p1", "k1", { write: true });
    expect(store.agent("p1", "k1")).toEqual({ read: true, write: true, commands: false });
    expect(() => store.addFolder("p1", path.parse(dir).root)).toThrow(/whole drive/);
    // Another project sees none of it.
    expect(store.agent("p2", "k1").read).toBe(false);
    store.forgetProject("p1");
    expect(new AccessStore(dir).project("p1").folders).toEqual([]);
  });

  it("approves a command only with a working folder inside a granted folder", () => {
    const store = new AccessStore(dir);
    const f = store.addFolder("p1", granted).folders[0]!;
    expect(() => store.addCommand("p1", { label: "Tests", command: "npm test", folderId: f.id, cwd: "../private" })).toThrow(/inside/);
    const v = store.addCommand("p1", { label: "Tests", command: "npm test", folderId: f.id, cwd: "src" });
    expect(v.commands[0]).toMatchObject({ label: "Tests", command: "npm test", cwdPath: path.join(granted, "src") });
    // Revoking the folder removes its commands.
    expect(store.revokeFolder("p1", f.id).commands).toEqual([]);
  });
});

function setup(reserved: string | null = null) {
  const store = new AccessStore(path.join(dir, "data"));
  const events: { action: string; allowed: boolean }[] = [];
  const service = new AccessService(store, () => workspace, (e) => events.push(e), () => reserved);
  const folder = store.addFolder("p1", granted).folders[0]!;
  store.setAgent("p1", "reviewer", { read: true });
  store.setAgent("p1", "builder", { write: true });
  store.setAgent("p1", "tester", { commands: true });
  return { store, service, folder, events };
}

describe("agents on this computer", () => {
  it("lets a reader read and list, refuses an agent without access, and refuses paths outside", () => {
    const { service, folder, events } = setup();
    const gate = service.gateFor("p1");
    const ok = gate.read("reviewer", "Vera", `${folder.id}/src/app.ts`);
    expect(ok).toMatchObject({ ok: true });
    expect(ok.ok && ok.content).toContain("export const app = 1;");
    expect(gate.read("reviewer", "Vera", folder.id)).toMatchObject({ ok: true });
    expect(gate.read("someone", "Sam", `${folder.id}/src/app.ts`)).toMatchObject({ ok: false });
    expect(gate.read("reviewer", "Vera", `${folder.id}/../private/secret.txt`)).toMatchObject({ ok: false });
    junction(outside, path.join(granted, "escape"));
    const escaped = gate.read("reviewer", "Vera", `${folder.id}/escape/secret.txt`);
    expect(escaped.ok).toBe(false);
    expect(JSON.stringify(escaped)).not.toContain("SECRET");
    expect(events.filter((e) => !e.allowed).length).toBe(3);
    expect(gate.describe("someone")).toBeNull();
    expect(gate.describe("reviewer")).toContain(folder.id);
  });

  it("applies a writer's file after the diff, blocks a read-only author, and reports conflicts with local edits", () => {
    const { store, service, folder } = setup();
    store.setFolderWrite("p1", folder.id, true);
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "app.ts"), "export const app = 2;\n");
    fs.writeFileSync(path.join(workspace, "notes.md"), "notes");
    fs.writeFileSync(path.join(workspace, "other.ts"), "other");
    service.recordFiles("p1", "r1", "t1", "builder", "Bob", ["src/app.ts", "other.ts"]);
    service.recordFiles("p1", "r1", "t2", "reviewer", "Vera", ["notes.md"]);
    const preview = service.previewApply("p1", folder.id);
    const byPath = Object.fromEntries(preview.items.map((i) => [i.path, i]));
    expect(byPath["src/app.ts"]).toMatchObject({ status: "ready", isNew: false });
    expect(byPath["src/app.ts"]!.diff).toContain("+export const app = 2;");
    expect(byPath["notes.md"]).toMatchObject({ status: "blocked" });
    expect(byPath["notes.md"]!.reason).toMatch(/no write access/);
    // A local edit after the diff was shown: kept, reported as a conflict.
    fs.writeFileSync(path.join(granted, "other.ts"), "my local edit");
    const r = service.apply("p1", preview.previewId, ["src/app.ts", "other.ts", "notes.md"]);
    expect(r.applied).toEqual(["src/app.ts"]);
    expect(r.conflicts.map((c) => c.path)).toEqual(["other.ts"]);
    expect(r.blocked.map((b) => b.path)).toEqual(["notes.md"]);
    expect(fs.readFileSync(path.join(granted, "src", "app.ts"), "utf8")).toBe("export const app = 2;\n");
    expect(fs.readFileSync(path.join(granted, "other.ts"), "utf8")).toBe("my local edit");
    expect(fs.existsSync(path.join(granted, "notes.md"))).toBe(false);
  });

  it("re-checks at apply: a revoked writer or a read-only folder writes nothing", () => {
    const { store, service, folder } = setup();
    store.setFolderWrite("p1", folder.id, true);
    fs.writeFileSync(path.join(workspace, "a.ts"), "a");
    service.recordFiles("p1", "r1", "t1", "builder", "Bob", ["a.ts"]);
    const preview = service.previewApply("p1", folder.id);
    store.setAgent("p1", "builder", { read: true });
    expect(service.apply("p1", preview.previewId, ["a.ts"]).blocked[0]!.reason).toMatch(/no write access/);
    expect(fs.existsSync(path.join(granted, "a.ts"))).toBe(false);
  });

  it("blocks applying a path a teammate has reserved", () => {
    const { store, service, folder } = setup("Ola has reserved a.ts for “Login”. Wait until that run ends.");
    store.setFolderWrite("p1", folder.id, true);
    fs.writeFileSync(path.join(workspace, "a.ts"), "a");
    service.recordFiles("p1", "r1", "t1", "builder", "Bob", ["a.ts"]);
    expect(service.previewApply("p1", folder.id).items[0]).toMatchObject({ status: "blocked", reason: expect.stringContaining("Ola") });
  });

  it("runs an approved check in its folder without secrets, and refuses agents without permission", async () => {
    const { store, service, folder } = setup();
    process.env.ORQ_TEST_TOKEN = "do-not-leak";
    const node = JSON.stringify(process.execPath);
    store.addCommand("p1", { label: "Check", command: `${node} -e "console.log('cwd=' + process.cwd()); console.log('token=' + (process.env.ORQ_TEST_TOKEN || 'none'))"`, folderId: folder.id, cwd: "src" });
    const id = store.project("p1").commands[0]!.id;
    const r = await service.check("p1", "tester", "Tess", id);
    delete process.env.ORQ_TEST_TOKEN;
    expect(r.ok).toBe(true);
    expect(r.ok && r.content).toContain(`cwd=${path.join(granted, "src")}`);
    expect(r.ok && r.content).toContain("token=none");
    expect(r.ok && r.content).toContain("Exit code 0");
    expect(await service.check("p1", "reviewer", "Vera", id)).toMatchObject({ ok: false });
    expect(await service.check("p1", "tester", "Tess", "c-unknown")).toMatchObject({ ok: false });
  });

  it("stops a running check when access is revoked", async () => {
    const { store, service, folder } = setup();
    const node = JSON.stringify(process.execPath);
    store.addCommand("p1", { label: "Slow", command: `${node} -e "setTimeout(() => console.log('finished'), 20000)"`, folderId: folder.id, cwd: "" });
    const id = store.project("p1").commands[0]!.id;
    const started = Date.now();
    const pending = service.check("p1", "tester", "Tess", id);
    setTimeout(() => store.revokeAgents("p1"), 300);
    const r = await pending;
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("revoked") });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
});

class Scripted implements ProviderAdapter {
  requests: string[] = [];
  constructor(readonly id: ProviderId, private readonly answers: ((p: string) => string)[]) {}
  async status(): Promise<ProviderStatus> { throw new Error("not used"); }
  chat(request: ChatRequest) {
    this.requests.push(request.text);
    const q = new EventQueue<ChatEvent>();
    const answer = this.answers[Math.min(this.requests.length - 1, this.answers.length - 1)]!;
    const text = answer(request.text);
    setTimeout(() => { q.push({ type: "completed", text, usage: null, limits: [] }); q.end(); }, 1);
    return { events: q, stop: () => { q.push({ type: "cancelled", text: "" }); q.end(); } };
  }
}

describe("computer access in a team run", () => {
  it("gives a worker with read access the file it asks for, and records what it delivered", async () => {
    const { service, folder } = setup();
    const ref = `${folder.id}/src/app.ts`;
    const codex = new Scripted("codex", [
      () => `<orqestra-need>{"kind":"computer","ref":"${ref}","why":"to match the style"}</orqestra-need>`,
      () => 'Done.\n<orqestra-file path="out.ts">\nexport const out = 1;\n</orqestra-file>',
    ]);
    const agents = parseAgents([{ id: "bu", name: "Bob", role: "Builder", priority: 1, tool: "codex", model: null, effort: null, agentKey: "builder" }]);
    const plan = parsePlan({ goal: "g", tasks: [{ id: "t1", title: "Out", role: "Builder", goal: "Write out.ts.", dependsOn: [], deliverables: ["out.ts"] }] }, ["Builder"]);
    const events: TeamEvent[] = [];
    await new TeamRun({ plan, agents, adapters: { codex, claude: codex }, workspace, cwd: dir, emit: (e) => void events.push(e), computer: service.gateFor("p1", "r1") }).start();
    expect(codex.requests[0]).toContain("Computer access");
    expect(codex.requests[1]).toContain("export const app = 1;");
    expect(service.pendingFiles("p1")).toMatchObject([{ path: "out.ts", agentName: "Bob" }]);
  });

  it("refuses a worker without access, and says so in its next prompt", async () => {
    const { service, folder } = setup();
    const codex = new Scripted("codex", [
      () => `<orqestra-need>{"kind":"computer","ref":"${folder.id}/src/app.ts"}</orqestra-need>`,
      () => 'Done.\n<orqestra-file path="out.ts">\nx\n</orqestra-file>',
    ]);
    const agents = parseAgents([{ id: "bu", name: "Nia", role: "Builder", priority: 1, tool: "codex", model: null, effort: null, agentKey: "nobody" }]);
    const plan = parsePlan({ goal: "g", tasks: [{ id: "t1", title: "Out", role: "Builder", goal: "Write out.ts.", dependsOn: [], deliverables: ["out.ts"] }] }, ["Builder"]);
    await new TeamRun({ plan, agents, adapters: { codex, claude: codex }, workspace, cwd: dir, emit: () => {}, computer: service.gateFor("p1", "r1") }).start();
    expect(codex.requests[0]).not.toContain("Computer access");
    expect(codex.requests[1]).toContain("Not given: Nia has no read access");
    expect(codex.requests[1]).not.toContain("export const app = 1;");
  });
});
