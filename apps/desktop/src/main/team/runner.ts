import type { ChatEvent, ProviderAdapter, ProviderId, Usage } from "../providers/types";
import { REVIEW_ROLES, safeRelativePath, type Plan, type PlanTask } from "./plan";
import { deliveryProblems, parseFiles, parseReview, reviewPrompt, workerPrompt, type AgentRef } from "./prompts";
import { listFiles, readFiles, writeFiles } from "./workspace";

// Runs an approved plan with the agents in the tree. Plain code, no AI: the order, the limits, the
// retries and the choice of agent are decided here (docs/backend-plan.md, phase 3).

export interface TeamAgent extends AgentRef {
  priority: number;
  tool: ProviderId;
  model: string | null;
  effort: string | null;
}

export type TaskStatus = "waiting" | "working" | "reviewing" | "done" | "unverified" | "failed" | "blocked" | "stopped";

export type TeamEvent =
  | { type: "run-started"; tasks: { id: string; title: string; role: string; agentId: string; agentName: string; deliverables: string[] }[] }
  | { type: "task"; taskId: string; status: TaskStatus; agentId: string | null; attempt: number; note?: string }
  | { type: "review"; taskId: string; reviewerId: string; approved: boolean; problems: string[] }
  | { type: "files"; taskId: string; files: { path: string; bytes: number }[] }
  // What an agent writes, while it writes (done: false, the latest part) and when it is done (the whole
  // answer, cut to OUTPUT_CHARS). Shown when the user opens the agent in the tree.
  | { type: "output"; taskId: string; agentId: string; kind: "work" | "review"; attempt: number; text: string; done: boolean; failed?: string }
  | { type: "run-finished"; status: "done" | "failed" | "stopped"; summary: string; files: { path: string; bytes: number }[]; calls: number; usage: { inputTokens: number; outputTokens: number } };

export interface Limits {
  maxCalls: number;
  maxAttempts: number;
  maxParallel: number;
  contextChars: number;
}

// Decision A5: 25 launches per request (retries and reviews count) and 2 retries per task.
export const OUTPUT_CHARS = 12_000;
export const OUTPUT_EVERY_MS = 400;

export const DEFAULT_LIMITS: Limits = { maxCalls: 25, maxAttempts: 3, maxParallel: 2, contextChars: 60_000 };

export interface RunOptions {
  plan: Plan;
  agents: TeamAgent[];
  adapters: Record<ProviderId, ProviderAdapter>;
  workspace: string;
  cwd: string;
  emit: (event: TeamEvent) => void;
  limits?: Partial<Limits>;
  // Coordinated runs (Teams phase 5): every write is authorised against the run's reservation
  // first. A refusal stops the run's writing; nothing is written without it.
  writeGuard?: { authorize(paths: string[]): Promise<void> };
  // Keeps the files as they were before this run first writes them, for Undo (history.ts).
  snapshot?: { before(paths: string[]): void };
}

const byPriority = (a: TeamAgent, b: TeamAgent) => a.priority - b.priority || a.name.localeCompare(b.name);

export function agentsFor(role: string, agents: TeamAgent[]): TeamAgent[] {
  return agents.filter((a) => a.role === role).sort(byPriority);
}

// A reviewer for a worker: a review role, preferably on another tool, since a model that checks its
// own provider's work tends to miss the same mistakes.
export function reviewerFor(worker: TeamAgent, agents: TeamAgent[]): TeamAgent | null {
  const reviewers = agents.filter((a) => REVIEW_ROLES.includes(a.role) && a.id !== worker.id)
    .sort((a, b) => REVIEW_ROLES.indexOf(a.role) - REVIEW_ROLES.indexOf(b.role) || byPriority(a, b));
  return reviewers.find((r) => r.tool !== worker.tool) ?? reviewers[0] ?? null;
}

export function missingRoles(plan: Plan, agents: TeamAgent[]): string[] {
  return [...new Set(plan.tasks.map((t) => t.role).filter((role) => agentsFor(role, agents).length === 0))];
}

class Stopped extends Error {}

export class TeamRun {
  private readonly limits: Limits;
  private calls = 0;
  private usage = { inputTokens: 0, outputTokens: 0 };
  private stopped = false;
  private readonly active = new Set<{ stop(): void }>();
  private readonly status = new Map<string, TaskStatus>();
  private readonly written = new Map<string, { path: string; bytes: number }>();

  constructor(private readonly o: RunOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
  }

  stop(): void {
    this.stopped = true;
    for (const handle of this.active) handle.stop();
  }

  private set(task: PlanTask, status: TaskStatus, agentId: string | null, attempt: number, note?: string): void {
    this.status.set(task.id, status);
    this.o.emit({ type: "task", taskId: task.id, status, agentId, attempt, ...(note ? { note } : {}) });
  }

  // One request to one agent. Returns the full text, or throws with a message for the next attempt.
  private async ask(agent: TeamAgent, prompt: string, about: { taskId: string; kind: "work" | "review"; attempt: number }): Promise<string> {
    if (this.stopped) throw new Stopped();
    if (this.calls >= this.limits.maxCalls) throw new Error(`The limit of ${this.limits.maxCalls} agent requests for this run is reached.`);
    this.calls += 1;
    const handle = this.o.adapters[agent.tool].chat({ provider: agent.tool, model: agent.model, effort: agent.effort, history: [], text: prompt, cwd: this.o.cwd, raw: true });
    this.active.add(handle);
    let last: ChatEvent | null = null;
    let text = "";
    let sentAt = 0;
    const output = (done: boolean, failed?: string) => this.o.emit({ type: "output", taskId: about.taskId, agentId: agent.id, kind: about.kind, attempt: about.attempt, done,
      text: done ? text.slice(0, OUTPUT_CHARS) : text.slice(-OUTPUT_CHARS), ...(failed ? { failed: failed.slice(0, 500) } : {}) });
    // At once, so the window shows the agent as thinking from the moment it got the task.
    output(false);
    try {
      for await (const event of handle.events) {
        last = event;
        if (event.type === "delta") {
          text += event.text;
          if (Date.now() - sentAt >= OUTPUT_EVERY_MS) { sentAt = Date.now(); output(false); }
        }
      }
    } finally {
      this.active.delete(handle);
    }
    if (last?.type === "completed") text = last.text || text;
    output(true, last?.type === "failed" ? last.message : last?.type === "completed" ? undefined : this.stopped || last?.type === "cancelled" ? "Stopped." : "No answer.");
    if (this.stopped || last?.type === "cancelled") throw new Stopped();
    if (last?.type === "failed") throw new Error(`${agent.name}: ${last.message}`);
    if (last?.type !== "completed") throw new Error(`${agent.name} gave no answer.`);
    const usage: Usage | null = last.usage;
    this.usage.inputTokens += usage?.inputTokens ?? 0;
    this.usage.outputTokens += usage?.outputTokens ?? 0;
    return last.text;
  }

  private async runTask(task: PlanTask): Promise<void> {
    const { plan, agents, workspace } = this.o;
    // A direct request goes to the agent the user asked first, then to others with its role.
    const workers = task.agentId ? [...agents.filter((a) => a.id === task.agentId), ...agentsFor(task.role, agents).filter((a) => a.id !== task.agentId)] : agentsFor(task.role, agents);
    // What the agent gets to read: the files of the tasks it depends on, existing files its goal names,
    // and its own files if they already exist (so a later plan can change them).
    const existing = listFiles(workspace);
    const mentioned = existing.filter((f) => task.goal.includes(f) || task.deliverables.some((d) => d.toLowerCase() === f.toLowerCase()));
    const fromDeps = plan.tasks.filter((t) => task.dependsOn.includes(t.id)).flatMap((t) => t.deliverables);
    // A direct request may touch any file, so the agent reads the whole project (up to the limit).
    const context = readFiles(workspace, task.open ? existing : [...new Set([...fromDeps, ...mentioned])], this.limits.contextChars);
    let problems: string[] = [];
    for (let attempt = 1; attempt <= this.limits.maxAttempts; attempt += 1) {
      // A retry goes to the next agent with the same role, if there is one (escalation by priority).
      const worker = workers[(attempt - 1) % workers.length]!;
      this.set(task, "working", worker.id, attempt, problems.length ? `Fixing: ${problems[0]}` : undefined);
      let text: string;
      try {
        text = await this.ask(worker, workerPrompt(plan, task, worker, context, problems, existing), { taskId: task.id, kind: "work", attempt });
      } catch (error) {
        if (error instanceof Stopped) throw error;
        if (/limit of \d+ agent requests/.test((error as Error).message)) throw error;
        problems = [(error as Error).message];
        continue;
      }
      const { files } = parseFiles(text);
      const delivery = deliveryProblems(task, files);
      if (delivery.length) {
        problems = delivery;
        continue;
      }
      // Only an answer, no files: nothing to write or review.
      if (task.open && !files.length) {
        this.set(task, "done", worker.id, attempt, "Answered without changing files.");
        return;
      }
      const outgoing = task.open
        ? files.map((f) => ({ path: safeRelativePath(f.path)!, content: f.content }))
        : files.map((f) => ({ path: task.deliverables.find((d) => d.toLowerCase() === f.path.replace(/\\/g, "/").toLowerCase())!, content: f.content }));
      if (this.o.writeGuard) {
        await this.o.writeGuard.authorize(outgoing.map((f) => f.path));
        if (this.stopped) throw new Stopped();
      }
      this.o.snapshot?.before(outgoing.map((f) => f.path));
      const saved = writeFiles(workspace, outgoing);
      for (const f of saved) this.written.set(f.path.toLowerCase(), f);
      this.o.emit({ type: "files", taskId: task.id, files: saved });

      const reviewer = REVIEW_ROLES.includes(task.role) ? null : reviewerFor(worker, agents);
      if (!reviewer) {
        this.set(task, "unverified", worker.id, attempt, "No reviewer in the tree, so this was not checked.");
        return;
      }
      this.set(task, "reviewing", reviewer.id, attempt);
      let reviewText: string;
      try {
        reviewText = await this.ask(reviewer, reviewPrompt(plan, task, reviewer, worker, files), { taskId: task.id, kind: "review", attempt });
      } catch (error) {
        if (error instanceof Stopped) throw error;
        if (/limit of \d+ agent requests/.test((error as Error).message)) throw error;
        problems = [(error as Error).message];
        continue;
      }
      const review = parseReview(reviewText);
      this.o.emit({ type: "review", taskId: task.id, reviewerId: reviewer.id, approved: review.approved, problems: review.problems });
      if (review.approved) {
        this.set(task, "done", worker.id, attempt, `Approved by ${reviewer.name}${reviewer.tool === worker.tool ? " (same tool as the author)" : ""}.`);
        return;
      }
      problems = review.problems;
    }
    this.set(task, "failed", null, this.limits.maxAttempts, problems[0] ?? "Not approved.");
  }

  async start(): Promise<void> {
    const { plan, agents, emit } = this.o;
    const assignments = plan.tasks.map((t) => {
      const agent = agentsFor(t.role, agents)[0];
      return { id: t.id, title: t.title, role: t.role, agentId: agent?.id ?? "", agentName: agent?.name ?? "", deliverables: t.deliverables };
    });
    emit({ type: "run-started", tasks: assignments });
    const missing = missingRoles(plan, agents);
    if (missing.length) {
      return this.finish("failed", `No agent in the tree runs on Claude Code or Codex for: ${missing.join(", ")}. Set one in the tree and start again.`);
    }
    for (const t of plan.tasks) this.set(t, "waiting", null, 0);

    const running = new Map<string, Promise<void>>();
    let failure: string | null = null;
    while (true) {
      const finished = (id: string) => ["done", "unverified"].includes(this.status.get(id) ?? "");
      for (const t of plan.tasks) {
        if (!this.stopped && this.status.get(t.id) === "waiting" && t.dependsOn.some((d) => ["failed", "blocked", "stopped"].includes(this.status.get(d) ?? ""))) {
          this.set(t, "blocked", null, 0, "An earlier task it needs did not finish.");
        }
      }
      if (!this.stopped && !failure) {
        for (const t of plan.tasks) {
          if (running.size >= this.limits.maxParallel) break;
          if (this.status.get(t.id) !== "waiting" || running.has(t.id) || !t.dependsOn.every(finished)) continue;
          const job = this.runTask(t).catch((error: unknown) => {
            if (error instanceof Stopped) this.set(t, "stopped", null, 0);
            else {
              failure = (error as Error).message;
              this.set(t, "failed", null, 0, failure);
            }
          }).finally(() => running.delete(t.id));
          running.set(t.id, job);
        }
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    for (const t of plan.tasks) {
      if (this.status.get(t.id) === "waiting") this.set(t, this.stopped ? "stopped" : "blocked", null, 0, failure ?? undefined);
    }
    if (this.stopped) return this.finish("stopped", "Stopped. Files already written stay in the project folder.");
    const all = plan.tasks.map((t) => this.status.get(t.id));
    const ok = all.every((s) => s === "done" || s === "unverified");
    const done = all.filter((s) => s === "done").length;
    const unverified = all.filter((s) => s === "unverified").length;
    const parts = [`${done + unverified} of ${plan.tasks.length} tasks finished`];
    if (unverified) parts.push(`${unverified} not reviewed`);
    if (failure) parts.push(String(failure).replace(/[.\s]+$/, ""));
    return this.finish(ok ? "done" : "failed", `${parts.join(". ")}.`);
  }

  private finish(status: "done" | "failed" | "stopped", summary: string): void {
    this.o.emit({ type: "run-finished", status, summary, files: [...this.written.values()], calls: this.calls, usage: this.usage });
  }
}
