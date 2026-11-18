import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventQueue, type ChatEvent, type ProviderAdapter, type ProviderStatus } from "../providers/types.js";
import { parseAgents, TeamService } from "./team-service.js";

const agent = { id: "b1", name: "Code builder", role: "Builder", priority: 1, tool: "codex", model: "gpt-6.1-sol", effort: "high" };
const plan = { goal: "g", tasks: [{ id: "t1", title: "x", role: "Builder", goal: "y", dependsOn: [], deliverables: ["a.txt"] }] };

class Hanging implements ProviderAdapter {
  readonly id = "codex" as const;
  async status(): Promise<ProviderStatus> { throw new Error("unused"); }
  chat() { const q = new EventQueue<ChatEvent>(); return { events: q, stop: () => { q.push({ type: "cancelled", text: "" }); q.end(); } }; }
}

describe("team service", () => {
  it("validates agents from the window", () => {
    expect(parseAgents([{ ...agent, model: "default" }])[0]).toMatchObject({ model: null, effort: "high" });
    for (const bad of [[], "x", [{ ...agent, tool: "bash" }], [{ ...agent, role: "Manager" }], [{ ...agent, model: "--yolo" }], [{ ...agent, id: "../x" }], [{ ...agent, priority: -1 }], [{ ...agent, effort: "MAX!" }]]) {
      expect(() => parseAgents(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("validates the plan against the agents' roles and runs one team per project", () => {
    const service = new TeamService({ codex: new Hanging(), claude: new Hanging() as unknown as ProviderAdapter }, () => "/tmp/orq-never-written", () => "/tmp");
    const emit = () => {};
    expect(() => service.start({ runId: "run-1", projectId: "p1", agents: [agent], plan: { ...plan, tasks: [{ ...plan.tasks[0], role: "Tester" }] } }, emit)).toThrow(/Tester/);
    expect(() => service.start({ runId: "../x", projectId: "p1", agents: [agent], plan }, emit)).toThrow(/run id/);
    expect(service.start({ runId: "run-1", projectId: "p1", agents: [agent], plan }, emit)).toBe("run-1");
    expect(() => service.start({ runId: "run-2", projectId: "p1", agents: [agent], plan }, emit)).toThrow(/already working/);
    expect(service.stop("nope")).toBe(false);
    expect(service.stop("run-1")).toBe(true);
  });
});

describe("planning by the Planner", () => {
  const planner = { ...agent, id: "p1", name: "The architect", role: "Planner", tool: "claude", model: "opus", effort: null };
  const answer = (text: string): ProviderAdapter => ({
    id: "claude", status: async () => { throw new Error("unused"); },
    chat: (request) => {
      expect(request.raw).toBe(true);
      expect(request.text).toContain("The Manager's brief:\nBuild a log");
      const q = new EventQueue<ChatEvent>();
      setTimeout(() => { q.push({ type: "completed", text, usage: null, limits: [] }); q.end(); }, 1);
      return { events: q, stop: () => {} };
    },
  });
  const service = (adapter: ProviderAdapter) => new TeamService({ codex: new Hanging(), claude: adapter }, () => fs.mkdtempSync(path.join(os.tmpdir(), "orq-plan-")), () => os.tmpdir());
  const request = { requestId: "plan-1", projectId: "p1", brief: "Build a log", planner, agents: [planner, agent], team: [{ name: "Code builder", role: "Builder", ready: true }] };

  it("returns the Planner's plan after validating it", async () => {
    const text = `Two steps.\n<orqestra-plan>\n${JSON.stringify(plan)}\n</orqestra-plan>`;
    await expect(service(answer(text)).plan(request)).resolves.toMatchObject({ summary: "Two steps.", plan: { goal: "g", tasks: [{ id: "t1", role: "Builder" }] } });
  });

  it("refuses a plan for roles nobody has, a non-Planner, and a bad brief", async () => {
    const bad = `<orqestra-plan>${JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], role: "Designer" }] })}</orqestra-plan>`;
    await expect(service(answer(bad)).plan(request)).rejects.toThrow(/Designer/);
    await expect(service(answer("")).plan({ ...request, planner: agent })).rejects.toThrow(/only be made by a Planner/);
    await expect(service(answer("")).plan({ ...request, brief: "  " })).rejects.toThrow(/brief/);
  });
});
