import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listHistory, pruneHistory, RunSnapshot, undoRun } from "./history.js";
import { writeFiles } from "./workspace.js";

let project: string;
let ws: string;
beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "orq-history-"));
  ws = path.join(project, "workspace");
  fs.mkdirSync(ws);
});
afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

const read = (rel: string) => fs.readFileSync(path.join(ws, rel), "utf8");
let clock = 1000;
function run(id: string, files: Record<string, string>) {
  const snap = new RunSnapshot(ws, id, `goal ${id}`, () => clock++);
  const list = Object.entries(files).map(([p, content]) => ({ path: p, content }));
  snap.before(list.map((f) => f.path));
  writeFiles(ws, list);
  return snap;
}

describe("undo", () => {
  it("puts changed files back and removes files the run created", () => {
    writeFiles(ws, [{ path: "index.html", content: "<h1>v1</h1>" }]);
    run("r1", { "index.html": "<h1>v2</h1>", "css/new.css": "h1{}" });
    expect(read("index.html")).toBe("<h1>v2</h1>");
    expect(undoRun(ws, "r1")).toEqual({ restored: ["index.html"], removed: ["css/new.css"] });
    expect(read("index.html")).toBe("<h1>v1</h1>");
    expect(fs.existsSync(path.join(ws, "css", "new.css"))).toBe(false);
    expect(() => undoRun(ws, "r1")).toThrow(/already undone/);
  });

  it("keeps the first version when a run writes a file twice (retries)", () => {
    writeFiles(ws, [{ path: "a.txt", content: "original" }]);
    const snap = run("r1", { "a.txt": "attempt 1" });
    snap.before(["a.txt"]);
    writeFiles(ws, [{ path: "a.txt", content: "attempt 2" }]);
    undoRun(ws, "r1");
    expect(read("a.txt")).toBe("original");
  });

  it("undoes newest first, so a later change is never lost", () => {
    writeFiles(ws, [{ path: "a.txt", content: "v1" }]);
    run("r1", { "a.txt": "v2" });
    run("r2", { "a.txt": "v3" });
    expect(() => undoRun(ws, "r1")).toThrow(/Undo the newer change first: "goal r2"/);
    undoRun(ws, "r2");
    expect(read("a.txt")).toBe("v2");
    undoRun(ws, "r1");
    expect(read("a.txt")).toBe("v1");
  });

  it("refuses runs it knows nothing about, bad ids, and paths through links", () => {
    expect(() => undoRun(ws, "nope")).toThrow(/nothing to undo/);
    expect(() => undoRun(ws, "../x")).toThrow(/Invalid run id/);
    expect(() => new RunSnapshot(ws, "../x", "g")).toThrow(/Invalid run id/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orq-outside-"));
    try {
      fs.symlinkSync(outside, path.join(ws, "linked"), "dir");
      expect(() => new RunSnapshot(ws, "r9", "g").before(["linked/x.txt"])).toThrow(/link/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps only the newest runs", () => {
    for (let i = 0; i < 5; i++) run(`r${i}`, { [`f${i}.txt`]: "x" });
    pruneHistory(ws, 3);
    expect(listHistory(ws).map((m) => m.runId)).toEqual(["r2", "r3", "r4"]);
  });
});
