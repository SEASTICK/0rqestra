import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventQueue, type ChatEvent, type ChatRequest, type ProviderAdapter, type ProviderId, type ProviderStatus, type Usage } from "../providers/types.js";
import { outputProblems, unifiedDiff } from "./diff.js";
import { parsePlan } from "./plan.js";
import { TeamRun, type TeamAgent, type TeamEvent } from "./runner.js";
import { summarize, UsageLedger } from "./usage-ledger.js";
import { writeFiles } from "./workspace.js";

// Stage 3: usage per request, per agent and per run; and what reviewers and retries receive.

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-usage-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Reply = { text: string; usage: Usage | null; repeat?: boolean } | { fail: string };
class Tool implements ProviderAdapter {
  requests: ChatRequest[] = [];
  constructor(readonly id: ProviderId, private readonly script: (prompt: string, n: number) => Reply) {}
  async status(): Promise<ProviderStatus> { throw new Error("not used"); }
  chat(request: ChatRequest) {
    this.requests.push(request);
    const queue = new EventQueue<ChatEvent>();
    const r = this.script(request.text, this.requests.length);
    setTimeout(() => {
      if ("fail" in r) queue.push({ type: "failed", reason: "provider_error", message: r.fail, text: "" });
      else {
        queue.push({ type: "completed", text: r.text, usage: r.usage, limits: [] });
        // A tool that reports the same finished reply twice must not be counted twice.
        if (r.repeat) queue.push({ type: "completed", text: r.text, usage: r.usage, limits: [] });
      }
      queue.end();
    }, 1);
    return { events: queue, stop: () => { queue.push({ type: "cancelled", text: "" }); queue.end(); } };
  }
}

const builder: TeamAgent = { id: "bu", name: "Bob", role: "Builder", priority: 1, tool: "codex", model: "m1", effort: null };
const reviewer: TeamAgent = { id: "rv", name: "Vera", role: "Code Reviewer", priority: 1, tool: "claude", model: null, effort: null };
const roles = ["Builder", "Code Reviewer"];
const file = (p: string, c: string) => `Done.\n<orqestra-file path="${p}">\n${c}\n</orqestra-file>`;
const approve = '<orqestra-review>{"approved": true, "problems": []}</orqestra-review>';
const reject = '<orqestra-review>{"approved": false, "problems": ["multiply is missing"]}</orqestra-review>';

async function run(planValue: unknown, codex: Tool, claude: Tool) {
  const events: TeamEvent[] = [];
  await new TeamRun({ plan: parsePlan(planValue, roles), agents: [builder, reviewer], adapters: { codex, claude }, workspace: dir, cwd: dir, emit: (e) => void events.push(e) }).start();
  return { events, finished: events.at(-1) as Extract<TeamEvent, { type: "run-finished" }>, usage: events.filter((e) => e.type === "usage") as Extract<TeamEvent, { type: "usage" }>[] };
}

const mathPlan = { goal: "Math helpers", tasks: [{ id: "t1", title: "Add multiply", role: "Builder", goal: "Add multiply(a, b) to math.js.", dependsOn: [], deliverables: ["math.js"],
  handoff: { deliverable: "math.js with add and multiply", references: [{ file: "math.js", why: "The file to change", full: true }], acceptance: ["multiply(3, 4) is 12", "add still works"] } }] };
const OLD = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };";
const NEW = "function add(a, b) {\n  return a + b;\n}\nfunction multiply(a, b) {\n  return a * b;\n}\nmodule.exports = { add, multiply };";

describe("usage ledger", () => {
  it("records every call once, per agent and per run, with cached input, retries and unavailable usage", async () => {
    writeFiles(dir, [{ path: "math.js", content: OLD }]);
    const codex = new Tool("codex", (p, n) => ({ text: file("math.js", n === 1 ? OLD : NEW), usage: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50 }, repeat: true }));
    // The reviewer's tool reports no usage the first time.
    const claude = new Tool("claude", (p, n) => ({ text: n === 1 ? reject : approve, usage: n === 1 ? null : { inputTokens: 2000, cachedInputTokens: 1500, outputTokens: 20 } }));
    const { finished, usage } = await run(mathPlan, codex, claude);
    expect(finished.status).toBe("done");
    expect(usage.map((u) => [u.entry.kind, u.entry.attempt, u.entry.inputTokens])).toEqual([["worker", 1, 1000], ["review", 1, null], ["worker", 2, 1000], ["review", 2, 2000]]);
    expect(finished.totals).toMatchObject({
      calls: 4, workerCalls: 2, reviewCalls: 2, retries: 1, contextRequests: 0,
      inputTokens: 4000, cachedInputTokens: 2700, outputTokens: 120, unavailableCalls: 1, partial: true,
    });
    expect(finished.totals!.byAgent).toEqual([
      { agentId: "bu", agentName: "Bob", role: "Builder", calls: 2, inputTokens: 2000, cachedInputTokens: 1200, outputTokens: 100, unavailableCalls: 0 },
      { agentId: "rv", agentName: "Vera", role: "Code Reviewer", calls: 2, inputTokens: 2000, cachedInputTokens: 1500, outputTokens: 20, unavailableCalls: 1 },
    ]);
    expect(finished.usage).toEqual({ inputTokens: 4000, outputTokens: 120 });
    // No prompt or file content is kept in the ledger.
    expect(JSON.stringify(usage)).not.toContain("multiply(a, b)");
  });

  it("counts a failed call (no usage) and never records one request twice", () => {
    const ledger = new UsageLedger();
    const seq = ledger.open();
    const meta = { taskId: "t1", agentId: "a", agentName: "A", role: "Builder", tool: "codex", model: null, kind: "worker" as const, attempt: 1, outcome: "failed" as const };
    expect(ledger.record(seq, meta, null)).not.toBeNull();
    expect(ledger.record(seq, meta, { inputTokens: 5, outputTokens: 5 })).toBeNull();
    expect(ledger.totals()).toMatchObject({ calls: 1, inputTokens: 0, unavailableCalls: 1, partial: true });
    expect(summarize([], 0, 0)).toMatchObject({ calls: 0, partial: false });
  });

  it("counts context requests and follow-up calls", async () => {
    const plan = { goal: "g", tasks: [
      { id: "a", title: "Notes", role: "Builder", goal: "Write notes.", dependsOn: [], deliverables: ["notes.md"] },
      { id: "b", title: "Page", role: "Builder", goal: "Write the page.", dependsOn: ["a"], deliverables: ["page.md"] },
    ] };
    const codex = new Tool("codex", (p) => {
      if (p.startsWith("You did task a")) return { text: "<orqestra-answer>Blue.</orqestra-answer>", usage: { inputTokens: 10, outputTokens: 1 } };
      if (p.includes("HANDOFF for task a")) return { text: file("notes.md", "n"), usage: { inputTokens: 10, outputTokens: 1 } };
      if (p.includes("Details you asked for")) return { text: file("page.md", "p"), usage: { inputTokens: 10, outputTokens: 1 } };
      return { text: '<orqestra-need>[{"kind": "question", "task": "a", "ref": "Which colour?", "why": "x"}]</orqestra-need>', usage: { inputTokens: 10, outputTokens: 1 } };
    });
    const claude = new Tool("claude", () => ({ text: approve, usage: { inputTokens: 1, outputTokens: 1 } }));
    const { finished } = await run(plan, codex, claude);
    expect(finished.totals).toMatchObject({ followUpCalls: 1, contextRequests: 1, workerCalls: 3, reviewCalls: 2, calls: 6, partial: false });
  });
});

describe("what reviewers and retries receive", () => {
  it("gives the reviewer the diff, the criteria and the checks first, and a retry its current version", async () => {
    writeFiles(dir, [{ path: "math.js", content: OLD }]);
    const codex = new Tool("codex", (p, n) => ({ text: file("math.js", n === 1 ? `${OLD}\n// todo` : NEW), usage: null }));
    const claude = new Tool("claude", (p, n) => ({ text: n === 1 ? reject : approve, usage: null }));
    await run(mathPlan, codex, claude);
    const review = claude.requests[1]!.text;
    const criteria = review.indexOf("Acceptance criteria:"), checks = review.indexOf("Verification results so far:"), diff = review.indexOf("--- math.js (before)");
    expect(criteria).toBeGreaterThan(-1);
    expect(checks).toBeGreaterThan(criteria);
    expect(diff).toBeGreaterThan(checks);
    expect(review).toContain("+function multiply(a, b) {");
    expect(review).toContain("Syntax check passed for the JSON and JavaScript files");
    // The retry gets the specific problem and the version it submitted, not a fresh start.
    const retry = codex.requests[1]!.text;
    expect(retry).toContain("Fix these problems:\n- multiply is missing");
    expect(retry).toContain(`Your last submitted version (change only what the problems need):\n--- math.js ---\n${OLD}\n// todo`);
  });

  it("catches broken output before any reviewer is asked", async () => {
    const plan = { goal: "g", tasks: [{ id: "t1", title: "Config", role: "Builder", goal: "Write config.json.", dependsOn: [], deliverables: ["config.json"] }] };
    const codex = new Tool("codex", (p, n) => ({ text: file("config.json", n === 1 ? "{ broken" : '{"ok": true}'), usage: null }));
    const claude = new Tool("claude", () => ({ text: approve, usage: null }));
    const { finished } = await run(plan, codex, claude);
    expect(finished.status).toBe("done");
    expect(claude.requests).toHaveLength(1); // only the valid version was reviewed
    expect(codex.requests[1]!.text).toContain("config.json is not valid JSON");
    expect(fs.existsSync(path.join(dir, "config.json")) && fs.readFileSync(path.join(dir, "config.json"), "utf8")).toBe('{"ok": true}');
  });

  it("makes small unified diffs and checks syntax without running anything", () => {
    expect(unifiedDiff("a.js", "x\ny\nz", "x\nY\nz")).toBe("--- a.js (before)\n+++ a.js (after)\n@@ -1 +1 @@\n x\n-y\n+Y\n z");
    expect(unifiedDiff("a.js", "same", "same")).toContain("(no changes)");
    expect(outputProblems([{ path: "a.js", content: "return 1;" }, { path: "b.json", content: "[1]" }])).toEqual([]);
    expect(outputProblems([{ path: "a.js", content: "function (" }])[0]).toContain("a.js has a syntax error");
    expect(outputProblems([{ path: "a.js", content: "process.exit(1)" }])).toEqual([]); // compiled, never run
  });
});
