import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Plan } from "../team/plan";
import { BriefPublisher, fileOutbox, repoPaths, scrubLocalPaths, shortText, type BriefState } from "./briefs";

const plan: Plan = {
  goal: "Add a login page with email sign-in",
  tasks: [
    { id: "t1", title: "Build the page", role: "Builder", goal: "Write src/login.tsx using C:\\Users\\me\\secret notes", dependsOn: [], deliverables: ["src/login.tsx", "src/login.css"] },
    { id: "t2", title: "Review", role: "Builder", goal: "Check it", dependsOn: ["t1"], deliverables: ["docs/login.md"] },
  ],
};
const info = { runId: "run-1", localProjectId: "local-1", plan };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orq-briefs-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function setup(opts: { linked?: boolean; fail?: () => boolean } = {}) {
  const sent: BriefState[] = [];
  let saved: BriefState[] = [];
  let timer: (() => void) | null = null;
  let now = 1_000;
  const server = new Map<string, BriefState>();
  const publisher = new BriefPublisher({
    linkFor: (id) => (opts.linked === false || id !== "local-1" ? null : { sharedProjectId: "shared-1", userId: "me", path: "C:\\work\\repo" }),
    branchOf: async () => "feature/login",
    send: async (s) => {
      if (opts.fail?.()) throw new Error("offline");
      sent.push({ ...s });
      // The database's rule: newer sequence only, and never after a finished state.
      const key = `${s.projectId}:${s.runId}`;
      const cur = server.get(key);
      const applied = !cur || (cur.seq < s.seq && !["completed", "stopped", "failed"].includes(cur.status));
      if (applied) server.set(key, { ...s });
      return { applied, status: server.get(key)!.status, seq: server.get(key)!.seq };
    },
    currentUserId: () => "me",
    load: () => saved,
    save: (s) => (saved = s.map((x) => ({ ...x }))),
    onChange: () => {},
    now: () => (now += 1000),
    setTimer: (fn) => {
      timer = fn;
      return 1;
    },
  });
  const flushAll = () => new Promise((r) => setTimeout(r, 0));
  return { publisher, sent, server, saved: () => saved, retry: () => timer?.(), flushAll };
}

describe("work briefs", () => {
  it("publishes one brief when an approved run starts in a linked project, with summary, branch and repo paths", async () => {
    const t = setup();
    await t.publisher.onRunEvent(info, { type: "run-started", tasks: [] });
    await t.flushAll();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ projectId: "shared-1", runId: "run-1", seq: 1, status: "in_progress", title: "Add a login page with email sign-in", branch: "feature/login", paths: ["src/login.tsx", "src/login.css", "docs/login.md"] });
    // No task prompts, no local paths.
    expect(JSON.stringify(t.sent[0])).not.toMatch(/secret|C:\\\\|Users/);
  });

  it("publishes nothing for a solo project", async () => {
    const t = setup({ linked: false });
    await t.publisher.onRunEvent(info, { type: "run-started", tasks: [] });
    await t.publisher.onRunEvent(info, { type: "run-finished", status: "done", summary: "x", files: [], calls: 1, usage: { inputTokens: 0, outputTokens: 0 } });
    expect(t.sent).toHaveLength(0);
  });

  it("updates the same brief on scope change, blocking and finishing, and keeps the outcome", async () => {
    const t = setup();
    await t.publisher.onRunEvent(info, { type: "run-started", tasks: [] });
    await t.publisher.onRunEvent(info, { type: "files", taskId: "t1", files: [{ path: "src/login.tsx", bytes: 3 }, { path: "src/auth/session.ts", bytes: 9 }] });
    await t.publisher.onRunEvent(info, { type: "task", taskId: "t1", status: "failed", agentId: null, attempt: 3, note: "Review found a bug in C:\\Users\\me\\repo\\x.ts" });
    await t.publisher.onRunEvent(info, { type: "run-finished", status: "failed", summary: "1 of 2 tasks finished. Review found a bug.", files: [], calls: 4, usage: { inputTokens: 0, outputTokens: 0 } });
    await t.flushAll();
    const stored = t.server.get("shared-1:run-1")!;
    expect(stored).toMatchObject({ status: "failed", outcome: "1 of 2 tasks finished. Review found a bug." });
    expect(stored.paths).toContain("src/auth/session.ts");
    expect(t.sent.map((s) => s.status)).toContain("blocked");
    expect(JSON.stringify(t.sent)).not.toMatch(/Users\\\\me/);
    // Only one brief for the run; sequence numbers only grow.
    expect(new Set(t.sent.map((s) => s.runId)).size).toBe(1);
    const seqs = t.sent.map((s) => s.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("ignores events after a run has finished, so it never goes back to In progress", async () => {
    const t = setup();
    await t.publisher.onRunEvent(info, { type: "run-started", tasks: [] });
    await t.publisher.onRunEvent(info, { type: "run-finished", status: "done", summary: "2 of 2 tasks finished.", files: [], calls: 4, usage: { inputTokens: 0, outputTokens: 0 } });
    await t.publisher.onRunEvent(info, { type: "task", taskId: "t2", status: "failed", agentId: null, attempt: 1 });
    await t.publisher.onRunEvent(info, { type: "run-started", tasks: [] });
    await t.flushAll();
    expect(t.server.get("shared-1:run-1")).toMatchObject({ status: "completed" });
    expect(t.publisher.forProject("shared-1")).toHaveLength(1);
  });

  it("keeps a brief that failed to sync, shows it, and retries until the server has the newest state", async () => {
    let offline = true;
    const t = setup({ fail: () => offline });
    await t.publisher.onRunEvent(info, { type: "run-started", tasks: [] });
    await t.publisher.onRunEvent(info, { type: "run-finished", status: "stopped", summary: "Stopped.", files: [], calls: 1, usage: { inputTokens: 0, outputTokens: 0 } });
    await t.flushAll();
    const local = t.publisher.forProject("shared-1")[0]!;
    expect(local).toMatchObject({ status: "stopped", outcome: "Stopped.", sync: "failed", error: "offline" });
    // It is on disk, so it survives a restart.
    expect(t.saved()[0]).toMatchObject({ status: "stopped", sync: "failed" });
    offline = false;
    t.retry();
    await t.flushAll();
    await t.flushAll();
    expect(t.publisher.forProject("shared-1")[0]!.sync).toBe("synced");
    // The run finished while offline: the server receives the finished state directly.
    expect(t.server.get("shared-1:run-1")).toMatchObject({ status: "stopped", outcome: "Stopped." });
  });

  it("is safe to deliver twice", async () => {
    const t = setup();
    await t.publisher.onRunEvent(info, { type: "run-started", tasks: [] });
    await t.flushAll();
    const first = t.server.get("shared-1:run-1")!;
    await t.publisher.flush();
    await t.flushAll();
    expect(t.server.get("shared-1:run-1")).toEqual(first);
  });

  it("removes local paths and long text from what is shared", () => {
    expect(scrubLocalPaths("see C:\\Users\\me\\a.ts and /Users/me/b.ts and \\\\server\\share\\c and ~/d")).toBe("see [local path] and [local path] and [local path] and [local path]");
    expect(shortText("a ".repeat(200), 20)).toHaveLength(20);
    expect(repoPaths(["src/a.ts", "C:/x/y", "/etc/passwd", "../up", "src\\b.ts", "src/a.ts", "docs/"])).toEqual(["src/a.ts", "src/b.ts", "docs/"]);
  });

  it("reads and writes its outbox atomically", () => {
    const box = fileOutbox(path.join(tmp, "briefs.json"));
    expect(box.load()).toEqual([]);
    const s = { projectId: "p", runId: "r", userId: "u", seq: 2, status: "in_progress", title: "t", branch: null, paths: [], outcome: null, updatedAt: 1, sync: "pending", error: null } as BriefState;
    box.save([s]);
    expect(box.load()).toEqual([s]);
  });
});
