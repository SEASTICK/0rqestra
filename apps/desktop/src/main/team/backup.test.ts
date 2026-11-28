import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventQueue, type ChatEvent, type ChatRequest, type ProviderAdapter, type ProviderId, type ProviderStatus } from "../providers/types.js";
import { CheckpointStore, checkpointPrompt, makeCheckpoint } from "./checkpoint.js";
import { parsePlan } from "./plan.js";
import { TeamRun, type TeamAgent, type TeamEvent } from "./runner.js";
import { TeamService } from "./team-service.js";

// Backup agents: when the primary agent's provider reports its usage limit, a configured backup
// continues the task from the last checkpoint. Completed work is not done again, partial output is
// not used, and the result still goes through review.

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-backup-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Answer = string | { limit: true; partial?: string; resetsAt?: number };
class Tool implements ProviderAdapter {
  prompts: string[] = [];
  constructor(readonly id: ProviderId, public script: (prompt: string, n: number) => Answer) {}
  async status(): Promise<ProviderStatus> {
    return { provider: this.id, name: this.id, installed: true, version: "1", signedIn: true, plan: "pro", subscription: true, models: [], limits: [], problem: null } as ProviderStatus;
  }
  chat(request: ChatRequest) {
    this.prompts.push(request.text);
    const queue = new EventQueue<ChatEvent>();
    const answer = this.script(request.text, this.prompts.length);
    setTimeout(() => {
      if (typeof answer === "string") queue.push({ type: "completed", text: answer, usage: { inputTokens: 10, outputTokens: 5 } as never, limits: [] });
      else {
        // The agent wrote part of an answer before the limit stopped it.
        if (answer.partial) queue.push({ type: "delta", text: answer.partial });
        queue.push({ type: "failed", reason: "usage_limit", message: "You've hit your usage limit.", text: answer.partial ?? "", ...(answer.resetsAt ? { resetsAt: answer.resetsAt } : {}) });
      }
      queue.end();
    }, 1);
    return { events: queue, stop: () => { queue.push({ type: "cancelled", text: "" }); queue.end(); } };
  }
}

const roles = ["Builder", "Code Reviewer"];
const plan = parsePlan({
  goal: "A page",
  tasks: [
    { id: "t1", title: "Notes", role: "Builder", goal: "Write notes", dependsOn: [], deliverables: ["notes.md"] },
    { id: "t2", title: "Page", role: "Builder", goal: "Write the page", dependsOn: ["t1"], deliverables: ["index.html"] },
  ],
}, roles);
const file = (p: string, c: string) => `Done.\n<orqestra-file path="${p}">\n${c}\n</orqestra-file>`;
const approve = '<orqestra-review>{"approved": true, "problems": []}</orqestra-review>';
const isPage = (p: string) => p.includes("Deliver exactly these files: index.html");
const isNotes = (p: string) => p.includes("Deliver exactly these files: notes.md");
const tasks = (events: TeamEvent[], id: string) => events.filter((e): e is Extract<TeamEvent, { type: "task" }> => e.type === "task" && e.taskId === id);
const last = (events: TeamEvent[], id: string) => tasks(events, id).at(-1)!;

const bea: TeamAgent = { id: "b1", name: "Bea", role: "Builder", priority: 1, tool: "codex", model: "gpt-x", effort: null };
const cleo: TeamAgent = { id: "b2", name: "Codex Cleo", role: "Builder", priority: 2, tool: "claude", model: "opus", effort: null };
const bo: TeamAgent = { id: "b3", name: "Bo", role: "Builder", priority: 3, tool: "codex", model: "gpt-y", effort: null };
const vera: TeamAgent = { id: "r1", name: "Vera", role: "Code Reviewer", priority: 1, tool: "gemini", model: null, effort: null };

function run(agents: TeamAgent[], tools: Record<string, Tool>, events: TeamEvent[], extra: Partial<ConstructorParameters<typeof TeamRun>[0]> = {}) {
  return new TeamRun({ plan, agents, adapters: tools as never, workspace: dir, cwd: dir, emit: (e) => void events.push(e), limits: { maxParallel: 1 }, ...extra });
}

describe("backup agents after a usage limit", () => {
  it("continues from the checkpoint with the configured backup, runs finished work once, and still reviews", async () => {
    const primary = { ...bea, backups: ["b2"], backupMode: "auto" as const };
    // Bea finishes the notes task, then hits the limit part way through writing the page.
    const codex = new Tool("codex", (p) => (isNotes(p) ? file("notes.md", "notes") : { limit: true, partial: '<orqestra-file path="index.html">\n<h1>half' }));
    const claude = new Tool("claude", (p) => file("index.html", p.includes("Checkpoint: continue from here") ? "<title>x</title><h1>resumed</h1>" : "<h1>no checkpoint</h1>"));
    let reviews = 0;
    const gemini = new Tool("gemini", (p) => { if (p.includes("index.html")) reviews += 1; return approve; });
    const events: TeamEvent[] = [];
    const team = run([primary, cleo, vera], { codex, claude, gemini }, events);
    await team.start();

    const sw = events.find((e): e is Extract<TeamEvent, { type: "switch" }> => e.type === "switch");
    expect(sw).toMatchObject({ taskId: "t2", fromName: "Bea", fromTool: "codex", toName: "Codex Cleo", toTool: "claude" });
    expect(tasks(events, "t2").some((e) => e.note === "Codex reached its usage limit. Codex Cleo resumed from the last checkpoint.")).toBe(true);
    // The backup got the existing handoff plus the checkpoint (goal, acceptance, what is still to do),
    // and nothing of the half-written answer.
    const handoff = claude.prompts[0]!;
    expect(handoff).toContain("Checkpoint: continue from here");
    expect(handoff).toContain("Bea stopped (Codex reached its usage limit)");
    expect(handoff).toContain("Goal: Write the page");
    expect(handoff).toContain("Deliver index.html");
    expect(handoff).toContain("Deliver exactly these files: index.html");
    expect(handoff).not.toContain("<h1>half");
    // Finished work ran once: the notes task was asked once, and never again after the switch.
    expect(codex.prompts.filter(isNotes)).toHaveLength(1);
    expect(claude.prompts.filter(isNotes)).toHaveLength(0);
    // The backup's result went through review; the partial answer never reached the file.
    expect(reviews).toBe(1);
    expect(last(events, "t2")).toMatchObject({ status: "done", agentId: "b2" });
    expect(fs.readFileSync(path.join(dir, "index.html"), "utf8")).toContain("resumed");
    // Every attempt is in the usage ledger, the failed one too.
    const usage = events.filter((e): e is Extract<TeamEvent, { type: "usage" }> => e.type === "usage").map((e) => e.entry);
    expect(usage.filter((u) => u.agentId === "b1" && u.outcome === "failed")).toHaveLength(1);
    expect(usage.filter((u) => u.agentId === "b2" && u.outcome === "completed")).toHaveLength(1);
    expect(team.checkpointOf("t2")).toMatchObject({ step: "reviewed", switches: [expect.objectContaining({ fromName: "Bea", toName: "Codex Cleo" })] });
  });

  it("skips a backup on the same exhausted account, and never goes back to it", async () => {
    const primary = { ...bea, backups: ["b3", "b2"] };
    const codex = new Tool("codex", (p) => (isNotes(p) ? { limit: true } : file("index.html", "<h1>x</h1>")));
    const claude = new Tool("claude", (p) => (isNotes(p) ? file("notes.md", "notes") : file("index.html", "<h1>page</h1>")));
    const gemini = new Tool("gemini", () => approve);
    const events: TeamEvent[] = [];
    await run([primary, cleo, bo, vera], { codex, claude, gemini }, events).start();
    // Bo is on Codex too (one account per tool): skipped. Cleo continued.
    expect(codex.prompts.filter(isNotes)).toHaveLength(1);
    expect(last(events, "t1")).toMatchObject({ status: "done", agentId: "b2" });
    // The next task's primary is Bea on the exhausted Codex: it switches without spending a request.
    expect(codex.prompts.filter(isPage)).toHaveLength(0);
    expect(last(events, "t2")).toMatchObject({ status: "done", agentId: "b2" });
  });

  it("pauses with the reason when every backup is unavailable or on the same account, and shows a reset time only when reported", async () => {
    const primary = { ...bea, backups: ["b3", "b2"] };
    const codex = new Tool("codex", () => ({ limit: true, resetsAt: 1_900_000_000 }));
    const claude = new Tool("claude", () => file("notes.md", "notes"));
    const gemini = new Tool("gemini", () => approve);
    const events: TeamEvent[] = [];
    await run([primary, { ...cleo, ready: false }, bo, vera], { codex, claude, gemini }, events).start();
    const t1 = last(events, "t1");
    expect(t1).toMatchObject({ status: "failed", reason: { kind: "usage_limit", resetsAt: 1_900_000_000 } });
    expect(t1.reason!.title).toBe("Codex reached its usage limit, and none of Bea's backup agents can continue.");
    expect(t1.reason!.detail).toMatch(/Bo uses Codex, which reached its limit too \(same account\)/);
    expect(t1.reason!.detail).toMatch(/Codex Cleo is not ready/);
    expect(claude.prompts).toHaveLength(0);
    expect(codex.prompts).toHaveLength(1);
    expect(last(events, "t2")).toMatchObject({ status: "blocked", reason: { kind: "dependency" } });

    // No backups configured, and no reset time reported: the reason says so, without a reset time.
    const events2: TeamEvent[] = [];
    const codex2 = new Tool("codex", () => ({ limit: true }));
    await run([bea, cleo, vera], { codex: codex2, claude: new Tool("claude", () => file("notes.md", "x")), gemini }, events2).start();
    const r = last(events2, "t1").reason!;
    expect(r).toMatchObject({ kind: "usage_limit" });
    expect(r.resetsAt).toBeUndefined();
    expect(r.title).toBe("Codex reached its usage limit, and Bea has no backup agents.");
  });

  it("asks first when set to ask, then continues with the backup the user chose", async () => {
    const primary = { ...bea, backups: ["b2"], backupMode: "ask" as const };
    const codex = new Tool("codex", () => ({ limit: true }));
    const claude = new Tool("claude", (p) => (isNotes(p) ? file("notes.md", p.includes("Checkpoint") ? "from checkpoint" : "fresh") : file("index.html", "<h1>x</h1>")));
    const gemini = new Tool("gemini", () => approve);
    const events: TeamEvent[] = [];
    const agents = [primary, cleo, vera];
    const team = run(agents, { codex, claude, gemini }, events);
    await team.start();
    expect(last(events, "t1")).toMatchObject({ status: "blocked", reason: { kind: "usage_limit", backup: { id: "b2", name: "Codex Cleo", tool: "claude" } } });
    expect(claude.prompts).toHaveLength(0);
    expect(events.some((e) => e.type === "switch")).toBe(false);
    await team.retry("t1", agents, undefined, { switchTo: "b2" });
    expect(last(events, "t1")).toMatchObject({ status: "done", agentId: "b2" });
    expect(fs.readFileSync(path.join(dir, "notes.md"), "utf8")).toContain("from checkpoint");
    // The next task's primary is Bea again; the retry asked Codex afresh, it is still at its limit,
    // so 0rqestra asks again instead of switching on its own.
    expect(last(events, "t2")).toMatchObject({ status: "blocked", reason: { kind: "usage_limit", backup: { id: "b2" } } });
  });
});

describe("checkpoints", () => {
  it("are compact, name files instead of including them, and survive on disk", () => {
    const cp = makeCheckpoint(plan.tasks[1]!, { step: "delivered", files: ["index.html"], completed: ["Delivered index.html"], findings: ["Missing title"], pending: ["Fix the review findings"] });
    const text = checkpointPrompt(cp);
    expect(text).toContain("Goal: Write the page");
    expect(text).toContain("- index.html");
    expect(text).toContain("Missing title");
    const store = new CheckpointStore(path.join(dir, "cps"));
    store.save({ version: 1, runId: "run1", projectId: "p1", plan, savedAt: "now", status: { t1: "done" }, outputs: {}, tasks: { t2: cp }, written: [] });
    expect(store.load("run1")?.tasks.t2?.findings).toEqual(["Missing title"]);
    expect(store.load("missing")).toBeNull();
    expect(() => store.load("../x")).not.toThrow();
  });

  it("resume a run after a restart: finished tasks stay done, the stopped task continues from its checkpoint", async () => {
    const store = new CheckpointStore(path.join(dir, "cps"));
    const projectDir = path.join(dir, "ws");
    fs.mkdirSync(projectDir);
    let limited = true;
    const codex = new Tool("codex", (p) => (isNotes(p) ? file("notes.md", "notes") : limited ? { limit: true, partial: "<h1>half" } : file("index.html", p.includes("Checkpoint") ? "<h1>resumed</h1>" : "<h1>fresh</h1>")));
    const gemini = new Tool("gemini", () => approve);
    const agents = [{ id: "b1", name: "Bea", role: "Builder", priority: 1, tool: "codex", model: null, effort: null }, { id: "r1", name: "Vera", role: "Code Reviewer", priority: 1, tool: "gemini", model: null, effort: null }];
    const first = new TeamService({ codex, gemini } as never, () => projectDir, () => projectDir, undefined, () => null, store);
    const events: TeamEvent[] = [];
    const finished = new Promise<void>((resolve) => {
      first.start({ runId: "run-a", projectId: "proj-1", plan, agents }, (_id, e) => { events.push(e); if (e.type === "run-finished") resolve(); });
    });
    await finished;
    expect(last(events, "t1").status).toBe("done");
    expect(last(events, "t2")).toMatchObject({ status: "failed", reason: { kind: "usage_limit" } });
    const notesAsked = codex.prompts.filter(isNotes).length;

    // The app restarts: a new service with the same checkpoint store, and the limit has reset.
    limited = false;
    const second = new TeamService({ codex, gemini } as never, () => projectDir, () => projectDir, undefined, () => null, store);
    const prepared = second.prepareRetry({ runId: "run-a", projectId: "proj-1", taskId: "t2", agents });
    const events2: TeamEvent[] = [];
    await new Promise<void>((resolve) => {
      second.launchRetry(prepared, (_id, e) => { events2.push(e); if (e.type === "run-finished") resolve(); });
    });
    expect(last(events2, "t2").status).toBe("done");
    expect(tasks(events2, "t1")).toHaveLength(0);
    expect(codex.prompts.filter(isNotes)).toHaveLength(notesAsked);
    expect(codex.prompts.at(-1)).toContain("Checkpoint: continue from here");
    expect(fs.readFileSync(path.join(projectDir, "index.html"), "utf8")).toContain("resumed");
  });
});
