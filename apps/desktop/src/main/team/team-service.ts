import { EFFORT_NAME, MODEL_NAME } from "../providers/process";
import type { ChatEvent, ChatHandle, TeamMember } from "../providers/types";
import { extractPlan, plannerPrompt } from "./planner";
import { listFiles } from "./workspace";
import { PROVIDER_IDS, type ProviderAdapter, type ProviderId } from "../providers/types";
import { missingProjectFiles, parsePlan, type Plan } from "./plan";
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

export function parseTeamMembers(value: unknown): TeamMember[] {
  const raw = value ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_AGENTS) throw new Error("Invalid team.");
  return raw.map((member: unknown) => {
    const m = member as Record<string, unknown> | null;
    if (!m || typeof m.name !== "string" || !m.name.trim() || m.name.length > 48 || typeof m.role !== "string" || !ROLE.test(m.role)) throw new Error("Invalid team.");
    return { name: m.name.trim(), role: m.role, ready: m.ready === true };
  });
}

export type TeamEmit = (runId: string, event: TeamEvent) => void;

export class TeamService {
  private runs = new Map<string, { projectId: string; run: TeamRun }>();
  private planning = new Map<string, ChatHandle>();

  constructor(
    private readonly adapters: Record<ProviderId, ProviderAdapter>,
    private readonly workspaceFor: (projectId: string) => string,
    private readonly cwd: () => string,
    // Sees every run's events, with the run's local project and plan (Teams briefs, phase 3).
    private readonly observe?: (info: { runId: string; localProjectId: string; plan: Plan }, event: TeamEvent) => void,
    // Teams: what teammates are doing in this project right now, for the Planner.
    private readonly teamNow: (projectId: string) => string | null = () => null,
  ) {}

  // Validates a start request without starting anything (so a reservation can be made first).
  prepare(raw: unknown): { runId: string; projectId: string; plan: Plan; agents: TeamAgent[] } {
    const v = (raw ?? {}) as Record<string, unknown>;
    if (typeof v.runId !== "string" || !ID.test(v.runId)) throw new Error("Invalid run id.");
    if (typeof v.projectId !== "string" || !ID.test(v.projectId)) throw new Error("Invalid project id.");
    const agents = parseAgents(v.agents);
    const plan = parsePlan(v.plan, [...new Set(agents.map((a) => a.role))]);
    // A handoff that refers to a project file that is not there is refused now, before anything
    // starts, instead of sending the task without it.
    const missing = missingProjectFiles(plan, listFiles(this.workspaceFor(v.projectId)));
    if (missing.length) {
      throw new Error(`The plan refers to files that are not in the project folder: ${missing.map((m) => `${m.file} (task ${m.taskId})`).join(", ")}. Add them, or ask the Manager for a new plan.`);
    }
    const runId = v.runId;
    const projectId = v.projectId;
    if (this.runs.has(runId)) throw new Error("This run already exists.");
    if ([...this.runs.values()].some((r) => r.projectId === projectId)) throw new Error("The team is already working in this project. Stop it or wait.");
    return { runId, projectId, plan, agents };
  }

  start(raw: unknown, emit: TeamEmit, writeGuard?: { authorize(paths: string[]): Promise<void> }): string {
    return this.launch(this.prepare(raw), emit, writeGuard);
  }

  launch(prepared: { runId: string; projectId: string; plan: Plan; agents: TeamAgent[] }, emit: TeamEmit, writeGuard?: { authorize(paths: string[]): Promise<void> }): string {
    const { runId, projectId, plan, agents } = prepared;
    if (this.runs.has(runId)) throw new Error("This run already exists.");
    if ([...this.runs.values()].some((r) => r.projectId === projectId)) throw new Error("The team is already working in this project. Stop it or wait.");
    const run = new TeamRun({ plan, agents, adapters: this.adapters, workspace: this.workspaceFor(projectId), cwd: this.cwd(), ...(writeGuard ? { writeGuard } : {}), emit: (event) => {
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

  private safeTeamNow(projectId: string): string | null {
    try {
      return this.teamNow(projectId);
    } catch {
      return null;
    }
  }

  // Asks the Planner for a plan from the Manager's brief. Resolves with a validated plan, or throws with a
  // message the window can show.
  async plan(raw: unknown): Promise<{ plan: Plan; summary: string }> {
    const v = (raw ?? {}) as Record<string, unknown>;
    if (typeof v.requestId !== "string" || !ID.test(v.requestId)) throw new Error("Invalid request id.");
    if (typeof v.projectId !== "string" || !ID.test(v.projectId)) throw new Error("Invalid project id.");
    if (typeof v.brief !== "string" || !v.brief.trim() || v.brief.length > 6000) throw new Error("The brief is empty or too long.");
    const [planner] = parseAgents([v.planner]);
    if (planner!.role !== "Planner") throw new Error("The plan can only be made by a Planner.");
    const agents = parseAgents(v.agents);
    const team = parseTeamMembers(v.team);
    if (this.planning.has(v.requestId)) throw new Error("This request is already running.");
    const requestId = v.requestId;
    const prompt = plannerPrompt(v.brief.trim(), planner!, team, listFiles(this.workspaceFor(v.projectId)), this.safeTeamNow(v.projectId));
    const handle = this.adapters[planner!.tool].chat({ provider: planner!.tool, model: planner!.model, effort: planner!.effort, history: [], text: prompt, cwd: this.cwd(), raw: true });
    this.planning.set(requestId, handle);
    let last: ChatEvent | null = null;
    try {
      for await (const event of handle.events) last = event;
    } finally {
      this.planning.delete(requestId);
    }
    if (last?.type === "cancelled") throw new Error("Planning was stopped.");
    if (last?.type === "failed") throw new Error(`${planner!.name}: ${last.message}`);
    if (last?.type !== "completed") throw new Error(`${planner!.name} gave no answer.`);
    const { summary, value } = extractPlan(last.text);
    return { plan: parsePlan(value, [...new Set(agents.map((a) => a.role))]), summary };
  }

  stopPlan(requestId: unknown): boolean {
    if (typeof requestId !== "string") return false;
    const handle = this.planning.get(requestId);
    if (!handle) return false;
    handle.stop();
    return true;
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
    for (const handle of this.planning.values()) handle.stop();
  }
}
