import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventQueue, type ChatEvent, type ChatRequest, type ProviderAdapter, type ProviderId, type ProviderStatus } from "../providers/types.js";
import { parsePlan, safeRelativePath, type Plan } from "./plan.js";
import { deliveryProblems, parseFiles, parseReview } from "./prompts.js";
import { agentsFor, reviewerFor, TeamRun, type TeamAgent, type TeamEvent } from "./runner.js";
import { readFiles, writeFiles } from "./workspace.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-team-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const roles = ["Planner", "Builder", "Code Reviewer"];
const planValue = {
  goal: "A small workout log",
  tasks: [
    { id: "t1", title: "Page", role: "Builder", goal: "Write the page", dependsOn: [], deliverables: ["index.html"] },
    { id: "t2", title: "Style", role: "Builder", goal: "Write the styles", dependsOn: ["t1"], deliverables: ["css/style.css"] },
  ],
};

describe("plan", () => {
  it("accepts a valid plan", () => {
    expect(parsePlan(planValue, roles).tasks.map((t) => t.deliverables)).toEqual([["index.html"], ["css/style.css"]]);
  });

  it("rejects unknown roles, cycles, missing dependencies, shared files and unsafe paths", () => {
    const task = (over: object) => ({ ...planValue, tasks: [{ ...planValue.tasks[0], ...over }] });
    expect(() => parsePlan(task({ role: "Hacker" }), roles)).toThrow(/role Hacker/);
    expect(() => parsePlan(task({ dependsOn: ["nope"] }), roles)).toThrow(/depends on nope/);
    expect(() => parsePlan(task({ deliverables: ["../evil.sh"] }), roles)).toThrow(/plain relative names/);
    expect(() => parsePlan(task({ deliverables: [] }), roles)).toThrow();
    expect(() => parsePlan({ ...planValue, tasks: [planValue.tasks[0], { ...planValue.tasks[1], deliverables: ["INDEX.html"] }] }, roles)).toThrow(/both/);
    expect(() => parsePlan({ ...planValue, tasks: [{ ...planValue.tasks[0], dependsOn: ["t2"] }, planValue.tasks[1]] }, roles)).toThrow(/circle/);
    expect(() => parsePlan({ goal: "x", tasks: [] }, roles)).toThrow(/1 to 8/);
    expect(() => parsePlan(null, roles)).toThrow();
  });

  it("allows only plain relative file paths", () => {
    for (const ok of ["index.html", "src/app.js", "a_b-c.d/e.txt"]) expect(safeRelativePath(ok), ok).toBe(ok);
    expect(safeRelativePath("src\\app.js")).toBe("src/app.js");
    for (const bad of ["../x", "/etc/passwd", "C:/x", "a/../b", ".env", "a//b", "", "a b.txt", "x".repeat(201), "a/b/c/d/e/f/g"]) {
      expect(safeRelativePath(bad), bad).toBeNull();
    }
  });
});

describe("workspace", () => {
  it("writes and reads files inside the folder only", () => {
    expect(writeFiles(dir, [{ path: "css/style.css", content: "body{}" }])).toEqual([{ path: "css/style.css", bytes: 6 }]);
    expect(readFiles(dir, ["css/style.css", "missing.txt"], 100)).toEqual([{ path: "css/style.css", content: "body{}" }]);
    expect(() => writeFiles(dir, [{ path: "../out.txt", content: "x" }])).toThrow(/Refused/);
    expect(fs.existsSync(path.join(dir, "..", "out.txt"))).toBe(false);
  });

  it("never writes through a symbolic link", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orq-outside-"));
    try {
      fs.symlinkSync(outside, path.join(dir, "linked"), "dir");
      expect(() => writeFiles(dir, [{ path: "linked/x.txt", content: "x" }])).toThrow(/link/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("cuts context to the limit", () => {
    writeFiles(dir, [{ path: "a.txt", content: "x".repeat(50) }]);
    expect(readFiles(dir, ["a.txt"], 10)[0]!.content).toMatch(/^x{10}\n\[\.\.\. cut/);
  });
});

describe("answers", () => {
  it("reads files and a summary from an agent's answer", () => {
    const text = 'Made the page.\n<orqestra-file path="index.html">\n<h1>Hi</h1>\n</orqestra-file>\n';
    expect(parseFiles(text)).toEqual({ summary: "Made the page.", files: [{ path: "index.html", content: "<h1>Hi</h1>" }] });
  });

  it("checks that exactly the owned files were delivered", () => {
    const task = parsePlan(planValue, roles).tasks[0]!;
    expect(deliveryProblems(task, [{ path: "index.html", content: "x" }])).toEqual([]);
    expect(deliveryProblems(task, [])).toEqual(["index.html is missing."]);
    expect(deliveryProblems(task, [{ path: "index.html", content: "  " }])[0]).toMatch(/empty/);
    expect(deliveryProblems(task, [{ path: "index.html", content: "x" }, { path: "hack.sh", content: "x" }])[0]).toMatch(/not asked for/);
  });

  it("treats an unreadable review as not approved", () => {
    expect(parseReview('ok\n<orqestra-review>{"approved": true, "problems": []}</orqestra-review>')).toEqual({ approved: true, problems: [], readable: true });
    expect(parseReview('<orqestra-review>{"approved": false, "problems": ["No title"]}</orqestra-review>')).toMatchObject({ approved: false, problems: ["No title"] });
    expect(parseReview("Looks good to me!")).toMatchObject({ approved: false, readable: false });
    expect(parseReview("<orqestra-review>{nope}</orqestra-review>")).toMatchObject({ approved: false, readable: false });
  });
});

// A scripted agent tool: each call gets the next answer from its script.
class ScriptedTool implements ProviderAdapter {
  prompts: string[] = [];
  constructor(readonly id: ProviderId, private readonly script: (prompt: string, n: number) => string | Error | "hang") {}
  async status(): Promise<ProviderStatus> { throw new Error("not used"); }
  chat(request: ChatRequest) {
    this.prompts.push(request.text);
    expect(request.raw).toBe(true);
    const queue = new EventQueue<ChatEvent>();
    const answer = this.script(request.text, this.prompts.length);
    setTimeout(() => {
      if (answer === "hang") return;
      if (answer instanceof Error) queue.push({ type: "failed", reason: "provider_error", message: answer.message, text: "" });
      else queue.push({ type: "completed", text: answer, usage: { inputTokens: 10, outputTokens: 5 }, limits: [] });
      queue.end();
    }, 1);
    return { events: queue, stop: () => { queue.push({ type: "cancelled", text: "" }); queue.end(); } };
  }
}

const builder: TeamAgent = { id: "b1", name: "Code builder", role: "Builder", priority: 1, tool: "codex", model: "gpt-6.1-sol", effort: "high" };
const reviewer: TeamAgent = { id: "r1", name: "Fresh eyes", role: "Code Reviewer", priority: 1, tool: "claude", model: "opus", effort: null };
const file = (p: string, c = "content") => `Done.\n<orqestra-file path="${p}">\n${c}\n</orqestra-file>`;
const approve = '<orqestra-review>{"approved": true, "problems": []}</orqestra-review>';
const reject = '<orqestra-review>{"approved": false, "problems": ["Add a heading"]}</orqestra-review>';
const deliverOwned = (prompt: string) => (prompt.includes("Deliver exactly these files: index.html") ? file("index.html", "<h1>Log</h1>") : file("css/style.css", "h1{}"));

async function run(plan: Plan, agents: TeamAgent[], codex: ScriptedTool, claude: ScriptedTool, limits = {}) {
  const events: TeamEvent[] = [];
  const team = new TeamRun({ plan, agents, adapters: { codex, claude }, workspace: dir, cwd: dir, emit: (e) => void events.push(e), limits });
  await team.start();
  return { events, finished: events.at(-1) as Extract<TeamEvent, { type: "run-finished" }>, team };
}

describe("team run", () => {
  const plan = parsePlan(planValue, roles);

  it("runs tasks in order, reviews with another tool, writes the files, and sums up", async () => {
    const codex = new ScriptedTool("codex", deliverOwned);
    const claude = new ScriptedTool("claude", () => approve);
    const { events, finished } = await run(plan, [builder, reviewer], codex, claude);
    expect(finished).toMatchObject({ status: "done", calls: 4, usage: { inputTokens: 40, outputTokens: 20 } });
    expect(finished.files.map((f) => f.path).sort()).toEqual(["css/style.css", "index.html"]);
    expect(fs.readFileSync(path.join(dir, "index.html"), "utf8")).toBe("<h1>Log</h1>");
    expect(codex.prompts[1]).toContain("--- index.html ---\n<h1>Log</h1>");
    expect(claude.prompts[0]).toContain("Review another agent's work");
    const order = events.filter((e) => e.type === "task" && e.status === "working").map((e) => (e as { taskId: string }).taskId);
    expect(order).toEqual(["t1", "t2"]);
  });

  it("sends the reviewer's problems back to the author and stops after the attempt limit", async () => {
    const codex = new ScriptedTool("codex", deliverOwned);
    const claude = new ScriptedTool("claude", () => reject);
    const { events, finished } = await run(plan, [builder, reviewer], codex, claude);
    expect(codex.prompts[1]).toContain("Fix these problems:\n- Add a heading");
    expect(events.find((e) => e.type === "task" && e.taskId === "t1" && e.status === "failed")).toBeTruthy();
    expect(events.find((e) => e.type === "task" && e.taskId === "t2" && e.status === "blocked")).toBeTruthy();
    expect(finished.status).toBe("failed");
    expect(codex.prompts.length).toBe(3);
  });

  it("retries an answer with missing or extra files, and marks unreviewed work", async () => {
    const codex = new ScriptedTool("codex", (p, n) => (n === 1 ? file("other.txt") : deliverOwned(p)));
    const { events, finished } = await run(plan, [builder], codex, new ScriptedTool("claude", () => approve));
    expect(codex.prompts[1]).toContain("other.txt was not asked for");
    expect(events.filter((e) => e.type === "task" && e.status === "unverified").length).toBe(2);
    expect(finished).toMatchObject({ status: "done", summary: expect.stringContaining("2 not reviewed") });
  });

  it("stops at the request limit", async () => {
    const codex = new ScriptedTool("codex", () => new Error("boom"));
    const { finished } = await run(plan, [builder], codex, new ScriptedTool("claude", () => approve), { maxCalls: 2 });
    expect(codex.prompts.length).toBe(2);
    expect(finished.status).toBe("failed");
    expect(finished.summary).toMatch(/limit of 2 agent requests/);
  });

  it("refuses to start when a role has no real agent", async () => {
    const codex = new ScriptedTool("codex", deliverOwned);
    const { finished } = await run(plan, [reviewer], codex, new ScriptedTool("claude", () => approve));
    expect(finished).toMatchObject({ status: "failed", calls: 0, summary: expect.stringContaining("Builder") });
    expect(codex.prompts.length).toBe(0);
  });

  it("stops a running task and blocks the rest", async () => {
    const codex = new ScriptedTool("codex", () => "hang");
    const events: TeamEvent[] = [];
    const team = new TeamRun({ plan, agents: [builder], adapters: { codex, claude: new ScriptedTool("claude", () => approve) }, workspace: dir, cwd: dir, emit: (e) => void events.push(e) });
    const done = team.start();
    await new Promise((r) => setTimeout(r, 20));
    team.stop();
    await done;
    expect(events.at(-1)).toMatchObject({ type: "run-finished", status: "stopped" });
    expect(events.filter((e) => e.type === "task" && e.status === "stopped").map((e) => (e as { taskId: string }).taskId).sort()).toEqual(["t1", "t2"]);
  });

  it("picks agents by priority and prefers a reviewer on another tool", () => {
    const second: TeamAgent = { ...builder, id: "b2", name: "Second", priority: 2, tool: "claude" };
    expect(agentsFor("Builder", [second, builder]).map((a) => a.id)).toEqual(["b1", "b2"]);
    const sameTool: TeamAgent = { ...reviewer, id: "r2", tool: "codex", priority: 0 };
    expect(reviewerFor(builder, [builder, sameTool, reviewer])?.id).toBe("r1");
    expect(reviewerFor(builder, [builder, sameTool])?.id).toBe("r2");
    expect(reviewerFor(builder, [builder])).toBeNull();
  });
});

describe("coordinated writes (Teams phase 5)", () => {
  const plan = parsePlan(planValue, roles);

  it("writes nothing that the write guard refuses, and stops the run's writing", async () => {
    const codex = new ScriptedTool("codex", deliverOwned);
    const claude = new ScriptedTool("claude", () => approve);
    const asked: string[][] = [];
    const events: TeamEvent[] = [];
    const team = new TeamRun({
      plan, agents: [builder, reviewer], adapters: { codex, claude }, workspace: dir, cwd: dir, emit: (e) => void events.push(e),
      writeGuard: { authorize: async (paths) => { asked.push(paths); if (paths.includes("css/style.css")) throw new Error("Not written: ann reserves css/."); } },
    });
    await team.start();
    const finished = events.at(-1) as Extract<TeamEvent, { type: "run-finished" }>;
    expect(asked).toEqual([["index.html"], ["css/style.css"]]);
    expect(fs.existsSync(path.join(dir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "css", "style.css"))).toBe(false);
    expect(finished.status).toBe("failed");
    expect(finished.summary).toMatch(/ann reserves css/);
    // One full stop at the end, even when the failure message already ends with one.
    expect(finished.summary).not.toMatch(/\.\.$/);
  });

  it("never writes through a Windows junction or a link created inside the workspace", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orq-outside-"));
    try {
      let linked = false;
      try {
        // A junction needs no special privilege on Windows; elsewhere this is a symbolic link.
        fs.symlinkSync(outside, path.join(dir, "jn"), process.platform === "win32" ? "junction" : "dir");
        linked = true;
      } catch {
        /* no link support here */
      }
      if (linked) {
        expect(() => writeFiles(dir, [{ path: "jn/x.txt", content: "x" }])).toThrow(/Refused/);
        expect(fs.readdirSync(outside)).toEqual([]);
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

import { extractPlan, plannerPrompt } from "./planner.js";
import { listFiles } from "./workspace.js";

describe("the Planner", () => {
  it("gets the brief, the team, the plan format, and the existing files", () => {
    const prompt = plannerPrompt("A workout log for the gym", { id: "p1", name: "The architect", role: "Planner" }, [{ name: "Code builder", role: "Builder", ready: true }], ["index.html"]);
    expect(prompt).toContain("The Manager's brief:\nA workout log for the gym");
    expect(prompt).toContain("<orqestra-plan>");
    expect(prompt).toContain("- Builder: Code builder (can work)");
    expect(prompt).toContain("Files already in the project folder: index.html");
  });

  it("reads the plan at the end of its answer and refuses anything else", () => {
    expect(extractPlan('Two tasks.\n<orqestra-plan>\n{"goal":"g","tasks":[]}\n</orqestra-plan>')).toEqual({ summary: "Two tasks.", value: { goal: "g", tasks: [] } });
    expect(() => extractPlan("Here is my plan: build it.")).toThrow(/did not end with a plan/);
    expect(() => extractPlan("<orqestra-plan>{nope}</orqestra-plan>")).toThrow(/could not be read/);
  });
});

describe("existing files", () => {
  it("are listed without links or temporary files", () => {
    writeFiles(dir, [{ path: "index.html", content: "x" }, { path: "js/app.js", content: "y" }]);
    fs.writeFileSync(path.join(dir, "half.orqestra-tmp"), "z");
    expect(listFiles(dir)).toEqual(["index.html", "js/app.js"]);
  });

  it("are given to a task that names them or delivers them again", async () => {
    writeFiles(dir, [{ path: "index.html", content: "<h1>Old</h1>" }, { path: "notes.txt", content: "keep tabs" }]);
    const fixPlan = parsePlan({ goal: "Fix", tasks: [{ id: "f1", title: "Fix", role: "Builder", goal: "Fix the title in index.html; see notes.txt.", dependsOn: [], deliverables: ["index.html"] }] }, roles);
    const codex = new ScriptedTool("codex", () => file("index.html", "<h1>New</h1>"));
    await run(fixPlan, [builder], codex, new ScriptedTool("claude", () => approve));
    expect(codex.prompts[0]).toContain("--- index.html ---\n<h1>Old</h1>");
    expect(codex.prompts[0]).toContain("--- notes.txt ---\nkeep tabs");
    expect(fs.readFileSync(path.join(dir, "index.html"), "utf8")).toBe("<h1>New</h1>");
  });
});
