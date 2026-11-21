import { EFFORT_NAME, MODEL_NAME } from "../providers/process";
import { parseSkillRefs, skillsFor } from "../capabilities/registry";
import type { ChatEvent, ChatHandle, TeamMember, Usage } from "../providers/types";
import { extractPlan, plannerPrompt } from "./planner";
import { listFiles } from "./workspace";
import { PROVIDER_IDS, type ProviderAdapter, type ProviderId } from "../providers/types";
import { directPlan, missingProjectFiles, parsePlan, type Plan } from "./plan";
import { TeamRun, type TeamAgent, type TeamEvent } from "./runner";
import { pruneHistory, RunSnapshot, undoRun } from "./history";

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
    const models = Array.isArray(a.models) ? a.models.filter((m): m is string => typeof m === "string" && MODEL_NAME.test(m)).slice(0, 16) : [];
    const refs = parseSkillRefs(a);
    const skills = skillsFor(refs.agentKey, refs.projectSkills);
    return { id: a.id, name: a.name.trim(), role: a.role, priority: a.priority as number, tool: a.tool as ProviderId, model: model as string | null, effort: effort as string | null, ...(models.length ? { models } : {}), ...refs, ...(skills.length ? { skills } : {}) };
  });
}

export function parseTeamMembers(value: unknown): TeamMember[] {
  const raw = value ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_AGENTS) throw new Error("Invalid team.");
  return raw.map((member: unknown) => {
    const m = member as Record<string, unknown> | null;
    if (!m || typeof m.name !== "string" || !m.name.trim() || m.name.length > 48 || typeof m.role !== "string" || !ROLE.test(m.role)) throw new Error("Invalid team.");
    const tool = m.tool === "claude" || m.tool === "codex" ? m.tool : null;
    const model = typeof m.model === "string" && MODEL_NAME.test(m.model) ? m.model : null;
    const models = Array.isArray(m.models) ? m.models.filter((x): x is string => typeof x === "string" && MODEL_NAME.test(x)).slice(0, 16) : [];
    const refs = parseSkillRefs(m);
    const skills = skillsFor(refs.agentKey, refs.projectSkills);
    return { name: m.name.trim(), role: m.role, ready: m.ready === true, ...(tool ? { tool } : {}), ...(model ? { model } : {}), ...(models.length ? { models } : {}), ...refs, ...(skills.length ? { skills } : {}) };
  });
}

// A task's model stays only when the agent that will do it has that model (its tool offers it).
function keepModel<T extends { model?: string }>(task: T, agent: TeamAgent | undefined): T {
  if (!task.model) return task;
  if (agent?.models?.includes(task.model)) return task;
  const rest = { ...task };
  delete rest.model;
  return rest;
}

// The Manager may name the agent for a task. A name that matches a working agent with the task's role
// becomes that task's first agent; any other name is dropped (the role's usual agent does the task).
export function assignAgents(plan: Plan, agents: TeamAgent[]): Plan {
  return {
    ...plan,
    tasks: plan.tasks.map((t) => {
      if (!t.agent) return keepModel(t, agents.filter((a) => a.role === t.role).sort((a, b) => a.priority - b.priority)[0]);
      const match = agents.find((a) => a.role === t.role && a.name.toLowerCase() === t.agent!.toLowerCase());
      if (match) return keepModel({ ...t, agent: match.name, agentId: match.id }, match);
      const rest = { ...t };
      delete rest.agent;
      delete rest.why;
      return rest;
    }),
  };
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
    const plan = assignAgents(parsePlan(v.plan, [...new Set(agents.map((a) => a.role))]), agents);
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

  // A request the user gives one agent directly, from its panel in the tree: a one-task plan for that agent.
  prepareDirect(raw: unknown): { runId: string; projectId: string; plan: Plan; agents: TeamAgent[] } {
    const v = (raw ?? {}) as Record<string, unknown>;
    if (typeof v.runId !== "string" || !ID.test(v.runId)) throw new Error("Invalid run id.");
    if (typeof v.projectId !== "string" || !ID.test(v.projectId)) throw new Error("Invalid project id.");
    const agents = parseAgents(v.agents);
    const agent = agents.find((a) => a.id === v.agentId);
    if (!agent) throw new Error("This agent does not run on Claude Code or Codex yet. Set its tool first.");
    const plan = directPlan(v.request, agent);
    if (this.runs.has(v.runId)) throw new Error("This run already exists.");
    if ([...this.runs.values()].some((r) => r.projectId === v.projectId)) throw new Error("The team is already working in this project. Stop it or wait.");
    return { runId: v.runId, projectId: v.projectId, plan, agents };
  }

  start(raw: unknown, emit: TeamEmit, writeGuard?: { authorize(paths: string[]): Promise<void> }): string {
    return this.launch(this.prepare(raw), emit, writeGuard);
  }

  launch(prepared: { runId: string; projectId: string; plan: Plan; agents: TeamAgent[] }, emit: TeamEmit, writeGuard?: { authorize(paths: string[]): Promise<void> }): string {
    const { runId, projectId, plan, agents } = prepared;
    if (this.runs.has(runId)) throw new Error("This run already exists.");
    if ([...this.runs.values()].some((r) => r.projectId === projectId)) throw new Error("The team is already working in this project. Stop it or wait.");
    const workspace = this.workspaceFor(projectId);
    const snapshot = new RunSnapshot(workspace, runId, plan.goal);
    const run = new TeamRun({ plan, agents, adapters: this.adapters, workspace, cwd: this.cwd(), snapshot, ...(writeGuard ? { writeGuard } : {}), emit: (event) => {
      emit(runId, event);
      // What the agents write stays on this computer: it is shown in the window, never shared.
      if (event.type === "output") return;
      try {
        this.observe?.({ runId, localProjectId: projectId, plan }, event);
      } catch {
        /* an observer never affects the run */
      }
    } });
    this.runs.set(runId, { projectId, run });
    void run.start().catch((error: unknown) => {
      emit(runId, { type: "run-finished", status: "failed", summary: error instanceof Error ? error.message : String(error), files: [], calls: 0, usage: { inputTokens: 0, outputTokens: 0 } });
    }).finally(() => {
      this.runs.delete(runId);
      try {
        pruneHistory(workspace);
      } catch {
        /* old undo history that cannot be removed now is removed after a later run */
      }
    });
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
  async plan(raw: unknown): Promise<{ plan: Plan; summary: string; usage: Usage | null }> {
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
    // The Planner's usage, so the run can show what planning cost (Stage 3).
    return { plan: assignAgents(parsePlan(value, [...new Set(agents.map((a) => a.role))]), agents), summary, usage: last.usage ?? null };
  }

  stopPlan(requestId: unknown): boolean {
    if (typeof requestId !== "string") return false;
    const handle = this.planning.get(requestId);
    if (!handle) return false;
    handle.stop();
    return true;
  }

  // Undo: puts back the files a finished run changed (history.ts). Not while the team works in the project.
  undo(raw: unknown): { restored: string[]; removed: string[] } {
    const v = (raw ?? {}) as Record<string, unknown>;
    if (typeof v.runId !== "string" || !ID.test(v.runId)) throw new Error("Invalid run id.");
    if (typeof v.projectId !== "string" || !ID.test(v.projectId)) throw new Error("Invalid project id.");
    const projectId = v.projectId;
    if ([...this.runs.values()].some((r) => r.projectId === projectId)) throw new Error("The team is working in this project. Undo when it is done.");
    return undoRun(this.workspaceFor(projectId), v.runId);
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
