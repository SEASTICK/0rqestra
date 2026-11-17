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
