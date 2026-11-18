import { EFFORT_NAME, MODEL_NAME } from "../providers/process";
import { PROVIDER_IDS, type ProviderAdapter, type ProviderId } from "../providers/types";
import { parsePlan, type Plan } from "./plan";
import { TeamRun, type TeamAgent, type TeamEvent } from "./runner";

// Team runs between the window and the runner, free of Electron so it is unit-tested. The plan came
// from a model and the agents from the window, so both are validated here.

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const ROLE = /^[A-Za-z][A-Za-z ]{0,39}$/;
export const MAX_AGENTS = 40;

export function parseAgents(value: unknown): TeamAgent[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_AGENTS) throw new Error("Invalid team.");
  return value.map((raw: unknown) => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const model = a.model === null || a.model === undefined || a.model === "" || a.model === "default" ? null : a.model;
    const effort = a.effort === null || a.effort === undefined || a.effort === "" ? null : a.effort;
    if (typeof a.id !== "string" || !ID.test(a.id)) throw new Error("Invalid agent id.");
    if (typeof a.name !== "string" || !a.name.trim() || a.name.length > 48) throw new Error("Invalid agent name.");
    if (typeof a.role !== "string" || !ROLE.test(a.role) || a.role === "Manager") throw new Error("Invalid agent role.");
    if (!Number.isInteger(a.priority) || (a.priority as number) < 0 || (a.priority as number) > 9999) throw new Error("Invalid agent priority.");
    if (!PROVIDER_IDS.includes(a.tool as ProviderId)) throw new Error("Invalid agent tool.");
    if (model !== null && (typeof model !== "string" || !MODEL_NAME.test(model))) throw new Error("Invalid agent model.");
    if (effort !== null && (typeof effort !== "string" || !EFFORT_NAME.test(effort))) throw new Error("Invalid agent effort.");
    return { id: a.id, name: a.name.trim(), role: a.role, priority: a.priority as number, tool: a.tool as ProviderId, model: model as string | null, effort: effort as string | null };
  });
}

export type TeamEmit = (runId: string, event: TeamEvent) => void;

export class TeamService {
  private runs = new Map<string, { projectId: string; run: TeamRun }>();

  constructor(
    private readonly adapters: Record<ProviderId, ProviderAdapter>,
    private readonly workspaceFor: (projectId: string) => string,
    private readonly cwd: () => string,
    // Sees every run's events, with the run's local project and plan (Teams briefs, phase 3).
    private readonly observe?: (info: { runId: string; localProjectId: string; plan: Plan }, event: TeamEvent) => void,
  ) {}

  start(raw: unknown, emit: TeamEmit): string {
    const v = (raw ?? {}) as Record<string, unknown>;
    if (typeof v.runId !== "string" || !ID.test(v.runId)) throw new Error("Invalid run id.");
    if (typeof v.projectId !== "string" || !ID.test(v.projectId)) throw new Error("Invalid project id.");
    const agents = parseAgents(v.agents);
    const plan = parsePlan(v.plan, [...new Set(agents.map((a) => a.role))]);
    const runId = v.runId;
    const projectId = v.projectId;
    if (this.runs.has(runId)) throw new Error("This run already exists.");
    if ([...this.runs.values()].some((r) => r.projectId === projectId)) throw new Error("The team is already working in this project. Stop it or wait.");
    const run = new TeamRun({ plan, agents, adapters: this.adapters, workspace: this.workspaceFor(projectId), cwd: this.cwd(), emit: (event) => {
      emit(runId, event);
      try {
        this.observe?.({ runId, localProjectId: projectId, plan }, event);
      } catch {
        /* an observer never affects the run */
      }
    } });
    this.runs.set(runId, { projectId, run });
    void run.start().catch((error: unknown) => {
      emit(runId, { type: "run-finished", status: "failed", summary: error instanceof Error ? error.message : String(error), files: [], calls: 0, usage: { inputTokens: 0, outputTokens: 0 } });
    }).finally(() => this.runs.delete(runId));
    return runId;
  }

  stop(runId: unknown): boolean {
    if (typeof runId !== "string") return false;
    const entry = this.runs.get(runId);
    if (!entry) return false;
    entry.run.stop();
    return true;
  }

  stopAll(): void {
    for (const entry of this.runs.values()) entry.run.stop();
  }
}
