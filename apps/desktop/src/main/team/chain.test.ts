import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventQueue, type ChatEvent, type ChatRequest, type ProviderAdapter, type ProviderId, type ProviderStatus } from "../providers/types.js";
import { parsePlan } from "./plan.js";
import { TeamRun, type TeamAgent, type TeamEvent } from "./runner.js";
import { writeFiles } from "./workspace.js";

// Stage 2: return briefs and context requests, along Researcher -> Builder -> Reviewer, checked at
// the adapter boundary (the requests each agent tool actually gets).

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-chain-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Script = (prompt: string, n: number) => string | "hang";
class Tool implements ProviderAdapter {
  requests: ChatRequest[] = [];
  constructor(readonly id: ProviderId, private readonly script: Script) {}
  async status(): Promise<ProviderStatus> { throw new Error("not used"); }
  chat(request: ChatRequest) {
    this.requests.push(request);
    const queue = new EventQueue<ChatEvent>();
    const answer = this.script(request.text, this.requests.length);
    setTimeout(() => {
      if (answer === "hang") return;
      queue.push({ type: "completed", text: answer, usage: { inputTokens: 1, outputTokens: 1 }, limits: [] });
      queue.end();
    }, 1);
    return { events: queue, stop: () => { queue.push({ type: "cancelled", text: "" }); queue.end(); } };
  }
}

const researcher: TeamAgent = { id: "re", name: "Rita", role: "Researcher", priority: 1, tool: "claude", model: null, effort: null };
const builder: TeamAgent = { id: "bu", name: "Bob", role: "Builder", priority: 1, tool: "codex", model: null, effort: null };
const reviewer: TeamAgent = { id: "rv", name: "Vera", role: "Code Reviewer", priority: 1, tool: "claude", model: null, effort: null };
const roles = ["Researcher", "Builder", "Code Reviewer"];

const plan = parsePlan({
  goal: "A workout log",
  rules: ["Swedish interface text"],
  tasks: [
    { id: "r1", title: "Research", role: "Researcher", goal: "Find out how the user logs workouts.", dependsOn: [], deliverables: ["research.md"],
      handoff: { deliverable: "Findings for the build", acceptance: ["Each finding is tagged for the task that needs it"] } },
    { id: "b1", title: "Build the page", role: "Builder", goal: "Write the logging page.", dependsOn: ["r1"], deliverables: ["index.html"],
      handoff: { deliverable: "The page", decisions: ["No frameworks"], references: [{ task: "r1", why: "What to build" }, { file: "spec.md", why: "The spec", full: true }], acceptance: ["Sets are saved and listed"] } },
    { id: "d1", title: "Write the readme", role: "Builder", goal: "Document the app.", dependsOn: ["r1"], deliverables: ["README.md"] },
  ],
}, roles);

const RESEARCH_ANSWER = [
  "Researched. RESEARCH-TRANSCRIPT-MARKER: long notes the builder must not get.",
  '<orqestra-file path="research.md">\nFull research notes. RESEARCH-FILE-MARKER\n</orqestra-file>',
  '<orqestra-brief>{"summary": "Users log exercise, sets, reps and weight.", "decisions": ["Weights in kg"],',
  ' "findings": [{"title": "Storage", "detail": "Keep sets in localStorage under the key sets", "for": ["b1"]},',
  ' {"title": "Fields", "detail": "exercise, sets, reps, weight", "for": ["b1", "d1"]},',
  ' {"title": "Date format", "detail": "Show dates as YYYY-MM-DD", "for": ["d1"]}],',
  ' "evidence": ["research.md"], "verified": ["Checked three gym apps"], "unresolved": ["Whether to support pounds"]}</orqestra-brief>',
].join("\n");
const deliver = (file: string, brief = "") => `Done.\n<orqestra-file path="${file}">\n<p>${file} v1</p>\n</orqestra-file>${brief}`;
const BUILD_BRIEF = '\n<orqestra-brief>{"summary": "Built the page.", "verified": ["All tests passed"], "evidence": ["index.html"]}</orqestra-brief>';
const need = (n: object) => `I need something.\n<orqestra-need>${JSON.stringify([n])}</orqestra-need>`;
const approve = '<orqestra-review>{"approved": true, "problems": []}</orqestra-review>';

// The researcher and the reviewer are on the claude tool, the builders on codex.
function tools(build: Script, followUp: Script = () => "<orqestra-answer>I do not know.</orqestra-answer>") {
  const claude = new Tool("claude", (p, n) => (p.includes("Review another agent's work") ? approve : p.startsWith("You did task") ? followUp(p, n) : RESEARCH_ANSWER));
  const codex = new Tool("codex", (p, n) => (p.includes("HANDOFF for task d1") ? deliver("README.md") : build(p, n)));
  return { claude, codex };
}
async function run(t: { claude: Tool; codex: Tool }, onStart?: (team: TeamRun) => void) {
  const events: TeamEvent[] = [];
  const team = new TeamRun({ plan, agents: [researcher, builder, reviewer], adapters: t, workspace: dir, cwd: dir, emit: (e) => void events.push(e) });
  onStart?.(team);
  await team.start();
  const status = (id: string) => [...events].reverse().find((e) => e.type === "task" && e.taskId === id) as Extract<TeamEvent, { type: "task" }> | undefined;
  return { events, status, finished: events.at(-1) as Extract<TeamEvent, { type: "run-finished" }> };
}
const builderPrompts = (codex: Tool) => codex.requests.map((r) => r.text).filter((t) => t.includes("HANDOFF for task b1"));

describe("handoff chain: Researcher -> Builder -> Reviewer", () => {
  beforeEach(() => writeFiles(dir, [{ path: "spec.md", content: "Log sets." }, { path: "private/notes.txt", content: "PRIVATE-NOTES" }]));

  it("passes only relevant findings, answers one requested detail, and gives the reviewer the latest work and evidence", async () => {
    const t = tools((p) => (p.includes("Details you asked for") ? deliver("index.html", BUILD_BRIEF) : need({ kind: "finding", ref: "r1.f3", why: "Dates on the page" })));
    const { events, status, finished } = await run(t);
    expect(finished.status).toBe("done");
    const [first, second] = builderPrompts(t.codex);
    // First handoff: the findings tagged for b1, the other one by id only, the decisions; no transcript, no research file.
    expect(first).toContain("r1.f1 Storage: Keep sets in localStorage under the key sets");
    expect(first).toContain("r1.f2 Fields: exercise, sets, reps, weight");
    expect(first).not.toContain("YYYY-MM-DD");
    expect(first).toContain("Other findings you can ask for by id: r1.f3 (Date format)");
    expect(first).toContain("- Weights in kg");
    expect(first).toContain("Checked three gym apps [agent-reported, not checked by the app]");
    expect(first).toContain("Delivered research.md: the expected files, none empty, no others. [checked by the app]");
    for (const p of [first, second]) {
      expect(p).not.toContain("RESEARCH-TRANSCRIPT-MARKER");
      expect(p).not.toContain("RESEARCH-FILE-MARKER");
      expect(p).not.toContain("PRIVATE-NOTES");
    }
    // Second handoff: the one requested detail, answered from the researcher's brief (no extra agent call).
    expect(second).toContain("Details you asked for:\nYou asked for finding r1.f3 (Dates on the page):\nr1.f3 Date format: Show dates as YYYY-MM-DD");
    expect(t.claude.requests.filter((r) => r.text.startsWith("You did task"))).toHaveLength(0);
    // The task waited for context, then went on.
    expect(events.some((e) => e.type === "task" && e.taskId === "b1" && e.status === "waiting_context" && e.note === "Waiting for context: r1.f3")).toBe(true);
    // Reviewer: the latest deliverable, the runner's checks, and the author's claims labelled.
    const review = t.claude.requests.map((r) => r.text).find((x) => x.includes("Review another agent's work") && x.includes("HANDOFF for task b1"))!;
    expect(review).toContain("Submitted changes (the latest version):\n--- index.html ---\n<p>index.html v1</p>");
    expect(review).toContain("Delivery check passed: index.html delivered");
    expect(review).toContain("All tests passed [agent-reported, not checked by the app]");
    expect(review).toContain("Delivered index.html: the expected files, none empty, no others. [checked by the app]");
    // Briefs reach the window (and so the Manager's next turn), with the review the runner saw.
    const briefs = events.filter((e) => e.type === "brief") as Extract<TeamEvent, { type: "brief" }>[];
    expect(briefs.map((b) => b.taskId).sort()).toEqual(["b1", "d1", "r1"]);
    const b1 = briefs.find((b) => b.taskId === "b1")!.brief;
    expect(b1.verified[0]).toEqual({ text: "Reviewed and approved by Vera (Code Reviewer).", source: "runner" });
    expect(b1.verified).toContainEqual({ text: "All tests passed", source: "agent-reported" });
    expect(status("d1")!.status).toBe("done");
  });

  it("routes a question to the earlier task's agent without sending it the builder's context", async () => {
    const t = tools(
      (p) => (p.includes("Details you asked for") ? deliver("index.html") : need({ kind: "question", task: "r1", ref: "Should sets be grouped by day?", why: "Layout" })),
      () => "Yes.\n<orqestra-answer>Group sets by day, newest first.</orqestra-answer>",
    );
    const { finished } = await run(t);
    expect(finished.status).toBe("done");
    const followUp = t.claude.requests.map((r) => r.text).find((x) => x.startsWith("You did task r1"))!;
    expect(followUp).toContain("Task b1 (Build the page, Builder) needs one detail from you to continue: Should sets be grouped by day?");
    expect(followUp).not.toContain("Log sets."); // the builder's referenced file
    expect(builderPrompts(t.codex)[1]).toContain("Answer from Rita: Group sets by day, newest first.");
  });

  it("refuses an out-of-scope file without giving it, and the task goes on", async () => {
    const t = tools((p) => (p.includes("Details you asked for") ? deliver("index.html") : need({ kind: "file", ref: "private/notes.txt", why: "Curious" })));
    const { finished } = await run(t);
    expect(finished.status).toBe("done");
    const second = builderPrompts(t.codex)[1]!;
    expect(second).toContain("Not given: private/notes.txt is outside this task's approved scope");
    expect(second).not.toContain("PRIVATE-NOTES");
    expect(finished.summary).toContain("Task b1 asked for something outside its scope");
  });

  it("shows a missing artifact as blocked, and independent tasks still finish", async () => {
    const t = tools((p, n) => {
      fs.rmSync(path.join(dir, "spec.md"), { force: true }); // gone after the task started
      return n < 99 ? need({ kind: "file", ref: "spec.md", why: "Re-read it" }) : "";
    });
    const { status, finished } = await run(t);
    expect(status("b1")).toMatchObject({ status: "blocked" });
    expect(status("b1")!.note).toContain("Needs the Manager or you: spec.md is not in the project folder.");
    expect(status("d1")!.status).toBe("done");
    expect(finished.status).toBe("failed");
    expect(finished.summary).toContain("Needs the Manager or you: b1 (Build the page): spec.md is not in the project folder");
  });

  it("deduplicates a repeated request and stops after a bounded number of rounds", async () => {
    const t = tools(() => need({ kind: "question", task: "r1", ref: "Which colours?", why: "Styling" }), () => "<orqestra-answer>Blue and white.</orqestra-answer>");
    const { status } = await run(t);
    expect(t.claude.requests.filter((r) => r.text.startsWith("You did task r1"))).toHaveLength(1); // asked once only
    expect(builderPrompts(t.codex)).toHaveLength(3); // the first answer and two rounds
    expect(builderPrompts(t.codex)[2]).toContain("You asked again for Which colours?; it was answered above.");
    expect(status("b1")!.note).toContain("Still missing after 2 rounds of questions: Which colours?");
  });

  it("sends a new decision to the Manager chat instead of guessing", async () => {
    const t = tools(() => need({ kind: "decision", ref: "Support pounds as well as kilograms", why: "The research left it open" }));
    const { status, finished } = await run(t);
    expect(status("b1")!.status).toBe("blocked");
    expect(finished.summary).toContain("Needs a decision that is not in the plan: Support pounds as well as kilograms");
    // A decision that the plan already holds is answered from it.
    const known = tools((p) => (p.includes("Details you asked for") ? deliver("index.html") : need({ kind: "decision", ref: "Which frameworks may I use?", why: "Setup" })));
    await run(known);
    expect(builderPrompts(known.codex)[1]).toContain("Decision for this task: No frameworks");
  });

  it("can be stopped while waiting for an answer", async () => {
    const t = tools(() => need({ kind: "question", task: "r1", ref: "Anything else?", why: "x" }), () => "hang");
    let team: TeamRun | null = null;
    const done = run(t, (tr) => { team = tr; });
    const t0 = Date.now();
    while (!t.claude.requests.some((r) => r.text.startsWith("You did task")) && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 5));
    team!.stop();
    const { finished, status } = await done;
    expect(finished.status).toBe("stopped");
    expect(status("b1")!.status).toBe("stopped");
  });
});
