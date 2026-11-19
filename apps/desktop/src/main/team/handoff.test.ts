import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventQueue, type ChatEvent, type ChatRequest, type ProviderAdapter, type ProviderId, type ProviderStatus } from "../providers/types.js";
import { missingProjectFiles, parsePlan } from "./plan.js";
import { TeamRun, type TeamAgent, type TeamEvent } from "./runner.js";
import { TeamService } from "./team-service.js";
import { writeFiles } from "./workspace.js";

// Stage 1 of task-specific handoffs, checked where it matters: the requests the agent tools
// actually receive (the adapter boundary).

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-handoff-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// Records every request an agent tool gets, and answers from a script.
class Recorder implements ProviderAdapter {
  requests: ChatRequest[] = [];
  constructor(readonly id: ProviderId, private readonly answer: (prompt: string) => string) {}
  async status(): Promise<ProviderStatus> { throw new Error("not used"); }
  chat(request: ChatRequest) {
    this.requests.push(request);
    const queue = new EventQueue<ChatEvent>();
    const text = this.answer(request.text);
    setTimeout(() => { queue.push({ type: "completed", text, usage: { inputTokens: 1, outputTokens: 1 }, limits: [] }); queue.end(); }, 1);
    return { events: queue, stop: () => { queue.push({ type: "cancelled", text: "" }); queue.end(); } };
  }
}

const builder: TeamAgent = { id: "b1", name: "Code builder", role: "Builder", priority: 1, tool: "codex", model: null, effort: null };
const reviewer: TeamAgent = { id: "r1", name: "Fresh eyes", role: "Code Reviewer", priority: 1, tool: "claude", model: null, effort: null };
const roles = ["Builder", "Code Reviewer"];
const approve = 'Fine.\n<orqestra-review>{"approved": true, "problems": []}</orqestra-review>';
const deliver = (prompt: string) => {
  const files = /Deliver exactly these files: (.+)/.exec(prompt)![1]!.split(", ");
  return `Made it.\n${files.map((f) => `<orqestra-file path="${f}">\n<p>${f} content</p>\n</orqestra-file>`).join("\n")}`;
};

async function run(planValue: unknown) {
  const codex = new Recorder("codex", deliver);
  const claude = new Recorder("claude", () => approve);
  const events: TeamEvent[] = [];
  const team = new TeamRun({ plan: parsePlan(planValue, roles), agents: [builder, reviewer], adapters: { codex, claude }, workspace: dir, cwd: dir, emit: (e) => void events.push(e) });
  await team.start();
  return { codex, claude, events, finished: events.at(-1) as Extract<TeamEvent, { type: "run-finished" }> };
}

const handoffPlan = {
  goal: "A workout log",
  rules: ["All interface text in Swedish", "Works offline"],
  tasks: [
    {
      id: "t1", title: "Build the page", role: "Builder", goal: "Write the logging page.", dependsOn: [], deliverables: ["index.html"],
      handoff: {
        deliverable: "One page where sets are logged and listed.",
        decisions: ["Save sets in localStorage, not on a server"],
        rules: ["No frameworks"],
        findings: ["The user logs exercise, sets, reps and weight (confirmed in the chat)"],
        references: [{ file: "notes.md", why: "The user's exercise list", full: true }, { file: "research.md", why: "Background only", full: false }],
        acceptance: ["Adding a set shows it in the list", "The list survives a reload"],
        verify: "Follow the code path for adding a set and for reloading.",
      },
    },
    {
      id: "t2", title: "Style it", role: "Builder", goal: "Style the page.", dependsOn: ["t1"], deliverables: ["style.css"],
      handoff: {
        deliverable: "Styles for the page.",
        decisions: ["Dark theme only"],
        references: [{ task: "t1", why: "What the page contains" }, { file: "index.html", why: "Style its class names", full: true }],
        acceptance: ["Every element of the page is styled"],
        verify: "Compare the selectors with index.html.",
      },
    },
  ],
};

describe("task handoffs at the adapter boundary", () => {
  it("gives the Builder and the Reviewer distinct, relevant handoffs with the rules and acceptance criteria", async () => {
    writeFiles(dir, [
      { path: "notes.md", content: "Exercises: squat, bench, deadlift" },
      { path: "research.md", content: `Research start. ${"r".repeat(4000)} RESEARCH-END-MARKER` },
      { path: "unrelated.txt", content: "UNRELATED-PROJECT-CONTENT" },
    ]);
    const { codex, claude, finished } = await run(handoffPlan);
    expect(finished.status).toBe("done");
    const [build1, build2] = codex.requests.map((r) => r.text);
    const [review1] = claude.requests.map((r) => r.text);
    // Agents get only their own prompt: no chat history, no Manager preamble.
    for (const r of [...codex.requests, ...claude.requests]) {
      expect(r.raw).toBe(true);
      expect(r.history).toEqual([]);
      expect(r.text).not.toContain("UNRELATED-PROJECT-CONTENT");
      expect(r.text).not.toContain("Conversation so far");
    }

    // Builder of t1: implementation decisions, rules, findings, the full file it needs, an excerpt of background.
    expect(build1).toContain("HANDOFF for task t1: Build the page (Builder)");
    expect(build1).toContain("Expected deliverable: One page where sets are logged and listed.");
    expect(build1).toContain("- Save sets in localStorage, not on a server");
    expect(build1).toContain("- [project] All interface text in Swedish");
    expect(build1).toContain("- [task] No frameworks");
    expect(build1).toContain("- The user logs exercise, sets, reps and weight (confirmed in the chat)");
    expect(build1).toContain("- Adding a set shows it in the list");
    expect(build1).toContain("How it will be verified: Follow the code path");
    expect(build1).toContain("--- notes.md ---\nExercises: squat, bench, deadlift");
    expect(build1).toContain("research.md (a project file, excerpt below)");
    expect(build1).not.toContain("RESEARCH-END-MARKER");
    expect(build1).not.toContain("Style it"); // another task's job stays out
    expect(build1).toContain("do not redo research or reopen decisions");

    // Builder of t2: its own decisions, t1's result, and t1's file in full; not t1's references.
    expect(build2).toContain("HANDOFF for task t2: Style it (Builder)");
    expect(build2).toContain("- Dark theme only");
    expect(build2).not.toContain("Save sets in localStorage");
    expect(build2).toContain("Task t1 (Build the page, Builder) delivered index.html: Made it.");
    expect(build2).toContain("--- index.html ---\n<p>index.html content</p>");
    expect(build2).not.toContain("squat, bench");
    expect(build2).toContain("- [project] Works offline");

    // Reviewer of t1: the same requirements, the submitted changes and the checks; no reference contents.
    expect(review1).toContain("Review another agent's work");
    expect(review1).toContain("HANDOFF for task t1: Build the page (Builder)");
    expect(review1).toContain("- Adding a set shows it in the list");
    expect(review1).toContain("- [project] All interface text in Swedish");
    expect(review1).toContain("- Save sets in localStorage, not on a server");
    expect(review1).toContain("Submitted changes:\n--- index.html ---\n<p>index.html content</p>");
    expect(review1).toContain("Verification results so far:\n- Delivery check passed: index.html delivered");
    expect(review1).toContain("- notes.md (a project file): The user's exercise list");
    expect(review1).not.toContain("squat, bench");
    expect(review1).not.toContain("do not redo research");
    expect(review1).not.toBe(build1);
  });

  it("stops a task whose reference is missing before asking any agent", async () => {
    // The start check is skipped here on purpose (TeamRun directly), as if the file went away after the start.
    const { codex, events } = await run({ ...handoffPlan, tasks: [handoffPlan.tasks[0]] });
    expect(codex.requests).toHaveLength(0);
    const blocked = events.find((e) => e.type === "task" && e.status === "blocked") as Extract<TeamEvent, { type: "task" }>;
    expect(blocked.note).toContain("Missing context: notes.md is not in the project folder.");
  });

  it("refuses to start a plan that refers to a project file that is not there", () => {
    const service = new TeamService({ codex: new Recorder("codex", deliver), claude: new Recorder("claude", () => approve) }, () => dir, () => dir);
    writeFiles(dir, [{ path: "research.md", content: "x" }]);
    expect(missingProjectFiles(parsePlan(handoffPlan, roles), ["research.md"])).toEqual([{ taskId: "t1", file: "notes.md" }]);
    expect(() => service.start({ runId: "run-1", projectId: "p1", agents: [builder, reviewer], plan: handoffPlan }, () => {})).toThrow(/not in the project folder: notes\.md \(task t1\)/);
  });

  it("refuses references outside the task's scope", () => {
    const t1 = handoffPlan.tasks[0]!, t2 = handoffPlan.tasks[1]!;
    const withRefs = (refs: unknown[]) => ({ ...handoffPlan, tasks: [{ ...t1, handoff: { ...t1.handoff, references: refs } }, t2] });
    expect(() => parsePlan(withRefs([{ file: "style.css", why: "x" }]), roles)).toThrow(/refers to style\.css, which task t2 delivers, but t1 does not depend on t2/);
    expect(() => parsePlan(withRefs([{ task: "t2", why: "x" }]), roles)).toThrow(/refers to task t2, which it does not depend on/);
    expect(() => parsePlan(withRefs([{ file: "../secrets.txt", why: "x" }]), roles)).toThrow(/not a plain relative file name/);
    expect(() => parsePlan(withRefs([{ file: "C:/Windows/win.ini", why: "x" }]), roles)).toThrow(/not a plain relative file name/);
  });

  it("includes a needed full file even when it is long", async () => {
    const long = `${"line of the spec\n".repeat(400)}SPEC-END-MARKER`;
    writeFiles(dir, [{ path: "notes.md", content: long }, { path: "research.md", content: "short" }]);
    const { codex } = await run({ ...handoffPlan, tasks: [handoffPlan.tasks[0]] });
    expect(codex.requests[0]!.text).toContain("SPEC-END-MARKER");
  });

  it("builds a handoff for an older plan without handoff fields, from what it already says", async () => {
    writeFiles(dir, [{ path: "notes.txt", content: "keep tabs" }]);
    const { codex, claude, finished } = await run({
      goal: "Old plan",
      tasks: [
        { id: "a", title: "Page", role: "Builder", goal: "Write the page using notes.txt", dependsOn: [], deliverables: ["index.html"] },
        { id: "b", title: "Styles", role: "Builder", goal: "Style it", dependsOn: ["a"], deliverables: ["style.css"] },
      ],
    });
    expect(finished.status).toBe("done");
    const [first, second] = codex.requests.map((r) => r.text);
    expect(first).toContain("HANDOFF for task a: Page (Builder)");
    expect(first).toContain("--- notes.txt ---\nkeep tabs");
    expect(first).toContain("Every file listed (index.html) is delivered and complete");
    expect(second).toContain("--- index.html ---\n<p>index.html content</p>");
    expect(second).toContain("Task a (Page, Builder) delivered index.html: Made it.");
    expect(claude.requests[0]!.text).toContain("Submitted changes:");
  });
});

describe("the plan format the Manager and the Planner are shown", () => {
  it("is itself a valid plan with handoffs", async () => {
    const { PLAN_FORMAT } = await import("../providers/history.js");
    const json = /<orqestra-plan>\s*([\s\S]*?)\s*<\/orqestra-plan>/.exec(PLAN_FORMAT)![1]!;
    const plan = parsePlan(JSON.parse(json), ["Builder"]);
    expect(plan.rules).toEqual(["Swedish user interface text", "Works offline; no accounts"]);
    expect(plan.tasks[0]!.handoff!.acceptance).toContain("Adding a set shows it in the list");
    expect(plan.tasks[1]!.handoff!.references).toEqual([{ file: "index.html", why: "Style its class names", full: true }]);
  });

});
