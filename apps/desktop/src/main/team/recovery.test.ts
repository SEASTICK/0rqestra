import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventQueue, type ChatEvent, type ChatRequest, type FailureReason, type ProviderAdapter, type ProviderId, type ProviderStatus } from "../providers/types.js";
import { parsePlan } from "./plan.js";
import { ProviderFailure, providerReason } from "./recovery.js";
import { TeamRun, type TeamAgent, type TeamEvent } from "./runner.js";
import { TeamService } from "./team-service.js";

// Run recovery: each failed or blocked task says why, and a retry runs only that task (and the
// ones waiting for it), keeping finished work.

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-recovery-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Answer = string | { fail: FailureReason; message: string };
class Tool implements ProviderAdapter {
  prompts: string[] = [];
  ready = true;
  constructor(readonly id: ProviderId, public script: (prompt: string, n: number) => Answer) {}
  async status(): Promise<ProviderStatus> {
    return { provider: this.id, name: this.id, installed: true, version: "1", signedIn: this.ready, plan: "pro", subscription: this.ready, models: [], limits: [], problem: this.ready ? null : "Not signed in." } as ProviderStatus;
  }
  chat(request: ChatRequest) {
    this.prompts.push(request.text);
    const queue = new EventQueue<ChatEvent>();
    const answer = this.script(request.text, this.prompts.length);
    setTimeout(() => {
      if (typeof answer === "string") queue.push({ type: "completed", text: answer, usage: null, limits: [] });
      else queue.push({ type: "failed", reason: answer.fail, message: answer.message, text: "" });
      queue.end();
    }, 1);
    return { events: queue, stop: () => { queue.push({ type: "cancelled", text: "" }); queue.end(); } };
  }
}

const builder: TeamAgent = { id: "b1", name: "Bea", role: "Builder", priority: 1, tool: "codex", model: "gpt-x", effort: null };
const reviewer: TeamAgent = { id: "r1", name: "Vera", role: "Code Reviewer", priority: 1, tool: "claude", model: "opus", effort: null };
const roles = ["Builder", "Code Reviewer"];
const plan = parsePlan({
  goal: "A page",
  tasks: [
    { id: "t1", title: "Page", role: "Builder", goal: "Write the page", dependsOn: [], deliverables: ["index.html"] },
    { id: "t2", title: "Style", role: "Builder", goal: "Write the styles", dependsOn: ["t1"], deliverables: ["style.css"] },
    { id: "t3", title: "Notes", role: "Builder", goal: "Write notes", dependsOn: [], deliverables: ["notes.md"] },
  ],
}, roles);
const file = (p: string, c = "content") => `Done.\n<orqestra-file path="${p}">\n${c}\n</orqestra-file>`;
const approve = '<orqestra-review>{"approved": true, "problems": []}</orqestra-review>';
const reject = (why: string) => `<orqestra-review>{"approved": false, "problems": ["${why}"]}</orqestra-review>`;
const deliver = (prompt: string) => (prompt.includes("Deliver exactly these files: index.html") ? file("index.html", "<h1>x</h1>") : prompt.includes("Deliver exactly these files: style.css") ? file("style.css", "h1{}") : file("notes.md", "notes"));
const lastTask = (events: TeamEvent[], id: string) => events.filter((e): e is Extract<TeamEvent, { type: "task" }> => e.type === "task" && e.taskId === id).at(-1)!;

function team(codex: Tool, claude: Tool, events: TeamEvent[], extra: Partial<ConstructorParameters<typeof TeamRun>[0]> = {}) {
  return new TeamRun({ plan, agents: [builder, reviewer], adapters: { codex, claude }, workspace: dir, cwd: dir, emit: (e) => void events.push(e), limits: { maxParallel: 1 }, ...extra });
}

describe("why a task stopped", () => {
  it("maps provider failures to reasons", () => {
    const f = (reason: FailureReason, message: string) => providerReason(new ProviderFailure(`Bea: ${message}`, reason, "codex", "b1", "Bea", "gpt-x"));
    expect(f("not_signed_in", "Codex is not signed in.")).toMatchObject({ kind: "signed_out", provider: "codex", agentId: "b1" });
    expect(f("not_subscription", "No plan")).toMatchObject({ kind: "signed_out" });
    expect(f("usage_limit", "Limit reached")).toMatchObject({ kind: "usage_limit" });
    expect(f("provider_error", "The model gpt-x does not exist or you do not have access to it.")).toMatchObject({ kind: "model_unavailable", model: "gpt-x" });
    expect(f("crashed", "Codex stopped")).toMatchObject({ kind: "unknown", detail: "Bea: Codex stopped" });
  });

  it("fails a task at once when its tool is signed out, and lets unrelated tasks finish", async () => {
    const codex = new Tool("codex", (p) => (p.includes("index.html") ? { fail: "not_signed_in", message: "Codex is not signed in." } : deliver(p)));
    const claude = new Tool("claude", () => approve);
    const events: TeamEvent[] = [];
    await team(codex, claude, events).start();
    expect(lastTask(events, "t1")).toMatchObject({ status: "failed", reason: { kind: "signed_out", provider: "codex" } });
    expect(codex.prompts.filter((p) => p.includes("Deliver exactly these files: index.html"))).toHaveLength(1);
    expect(lastTask(events, "t2")).toMatchObject({ status: "blocked", reason: { kind: "dependency", after: ["t1"] } });
    expect(lastTask(events, "t3").status).toBe("done");
  });

  it("gives the reviewer's findings when a review is rejected", async () => {
    const codex = new Tool("codex", deliver);
    const claude = new Tool("claude", (p) => (p.includes("index.html") ? reject("Add a heading") : approve));
    const events: TeamEvent[] = [];
    await team(codex, claude, events, { limits: { maxParallel: 1, maxAttempts: 2 } }).start();
    expect(lastTask(events, "t1")).toMatchObject({ status: "failed", reason: { kind: "review_rejected", reviewer: "Vera", findings: ["Add a heading"] } });
  });

  it("says which teammate holds a reservation, and writes nothing", async () => {
    const codex = new Tool("codex", deliver);
    const claude = new Tool("claude", () => approve);
    const events: TeamEvent[] = [];
    const refused = Object.assign(new Error("Not written: Ola is working on “Login”, which reserves index.html."), { conflicts: [{ name: "Ola", task: "Login", branch: "main", overlaps: [{ yours: "index.html", theirs: "index.html" }] }] });
    await team(codex, claude, events, { writeGuard: { authorize: async (paths) => { if (paths.includes("index.html")) throw refused; } } }).start();
    expect(lastTask(events, "t1")).toMatchObject({ status: "blocked", reason: { kind: "reservation", conflicts: [{ name: "Ola", branch: "main" }] } });
    expect(fs.existsSync(path.join(dir, "index.html"))).toBe(false);
  });

  it("names the missing role when no agent can do a task", async () => {
    const events: TeamEvent[] = [];
    await new TeamRun({ plan, agents: [reviewer], adapters: { codex: new Tool("codex", deliver), claude: new Tool("claude", () => approve) }, workspace: dir, cwd: dir, emit: (e) => void events.push(e) }).start();
    expect(lastTask(events, "t1")).toMatchObject({ status: "blocked", reason: { kind: "agent_missing", role: "Builder" } });
  });
});

describe("retrying one task", () => {
  it("keeps the finished task, retries the failed one with its findings through review, then runs its dependent", async () => {
    let fixed = false;
    const codex = new Tool("codex", deliver);
    // The reviewer rejects the page (its content is in the review prompt) until it is "fixed".
    const claude = new Tool("claude", (p) => (p.includes("<h1>x</h1>") && !fixed ? reject("Add a heading") : approve));
    const events: TeamEvent[] = [];
    // t3 (independent) passes; t1 is rejected twice; t2 waits for t1.
    const run = team(codex, claude, events, { limits: { maxParallel: 1, maxAttempts: 2 } });
    await run.start();
    expect(run.statusOf("t3")).toBe("done");
    expect(run.statusOf("t1")).toBe("failed");
    expect(run.statusOf("t2")).toBe("blocked");
    const notesBefore = codex.prompts.filter((p) => p.includes("Deliver exactly these files: notes.md")).length;
    const reviewsBefore = claude.prompts.length;
    fixed = true;
    events.length = 0;
    await run.retry("t1", [builder, reviewer]);
    expect(events[0]).toEqual({ type: "run-resumed", taskIds: ["t1", "t2"] });
    // The retry starts from the reviewer's findings, and still goes through review.
    const retryPrompt = codex.prompts.filter((p) => p.includes("Deliver exactly these files: index.html")).at(-1)!;
    expect(retryPrompt).toContain("Add a heading");
    expect(claude.prompts.length).toBeGreaterThan(reviewsBefore);
    expect(events.some((e) => e.type === "review" && e.taskId === "t1" && e.approved)).toBe(true);
    // The finished task did not run again; the dependent ran after the retry passed.
    expect(codex.prompts.filter((p) => p.includes("Deliver exactly these files: notes.md")).length).toBe(notesBefore);
    expect(events.some((e) => e.type === "task" && e.taskId === "t3")).toBe(false);
    expect(run.statusOf("t1")).toBe("done");
    expect(run.statusOf("t2")).toBe("done");
    expect((events.at(-1) as Extract<TeamEvent, { type: "run-finished" }>).status).toBe("done");
  });

  it("keeps the dependent waiting when the retry fails again", async () => {
    const codex = new Tool("codex", deliver);
    const claude = new Tool("claude", (p) => (p.includes("index.html") ? reject("Still wrong") : approve));
    const events: TeamEvent[] = [];
    const run = team(codex, claude, events, { limits: { maxParallel: 1, maxAttempts: 1 } });
    await run.start();
    await run.retry("t1", [builder, reviewer]);
    expect(run.statusOf("t1")).toBe("failed");
    expect(run.statusOf("t2")).toBe("blocked");
    expect(codex.prompts.filter((p) => p.includes("Deliver exactly these files: style.css"))).toHaveLength(0);
  });

  it("refuses a retry of a finished task, or while the run works", async () => {
    const codex = new Tool("codex", deliver);
    const claude = new Tool("claude", () => approve);
    const run = team(codex, claude, []);
    await run.start();
    await expect(run.retry("t1", [builder, reviewer])).rejects.toThrow(/failed or is blocked/);
  });
});

describe("retry checks in the service", () => {
  function service(codex: Tool, claude: Tool) {
    const events: { runId: string; event: TeamEvent }[] = [];
    const svc = new TeamService({ codex, claude } as Record<ProviderId, ProviderAdapter>, () => dir, () => dir);
    return { svc, events, emit: (runId: string, event: TeamEvent) => void events.push({ runId, event }) };
  }
  const agentsRaw = [{ ...builder }, { ...reviewer }];
  const until = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 10)); };

  it("reports a signed-out tool before retrying, allows one retry at a time, and retries when ready", async () => {
    let signedIn = false;
    const codex = new Tool("codex", (p) => (signedIn ? deliver(p) : p.includes("index.html") ? { fail: "not_signed_in", message: "Codex is not signed in." } : deliver(p)));
    const claude = new Tool("claude", () => approve);
    const { svc, events, emit } = service(codex, claude);
    svc.launch(svc.prepare({ runId: "run1", projectId: "p1", plan, agents: agentsRaw }), emit);
    await until(() => events.some((e) => e.event.type === "run-finished"));
    codex.ready = false;
    const first = svc.prepareRetry({ runId: "run1", projectId: "p1", taskId: "t1", agents: agentsRaw });
    expect(() => svc.prepareRetry({ runId: "run1", projectId: "p1", taskId: "t1", agents: agentsRaw })).toThrow(/already being retried/);
    expect(await svc.retryReadiness(first)).toMatchObject({ kind: "signed_out", provider: "codex" });
    svc.cancelRetry(first);
    codex.ready = true;
    signedIn = true;
    const second = svc.prepareRetry({ runId: "run1", projectId: "p1", taskId: "t1", agents: agentsRaw });
    expect(second.coordId).toBe("run1-retry2");
    expect(second.scope.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(await svc.retryReadiness(second)).toBeNull();
    events.length = 0;
    svc.launchRetry(second, emit);
    await until(() => events.some((e) => e.event.type === "run-finished"));
    expect(events.every((e) => e.runId === "run1")).toBe(true);
    expect((events.at(-1)!.event as Extract<TeamEvent, { type: "run-finished" }>).status).toBe("done");
    expect(() => svc.prepareRetry({ runId: "run1", projectId: "p1", taskId: "t1", agents: agentsRaw })).toThrow(/failed or is blocked/);
    expect(() => svc.prepareRetry({ runId: "gone", projectId: "p1", taskId: "t1", agents: agentsRaw })).toThrow(/restarted/);
  });
});
