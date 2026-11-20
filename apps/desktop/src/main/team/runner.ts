import type { ChatEvent, ProviderAdapter, ProviderId, Usage } from "../providers/types";
import { REVIEW_ROLES, safeRelativePath, type Plan, type PlanTask } from "./plan";
import { deliveryProblems, parseFiles, parseReview, reviewPrompt, workerPrompt, type AgentRef } from "./prompts";
import { resolveHandoff, type ResolvedHandoff, type TaskOutput } from "./handoff";
import { followUpPrompt, needKey, parseAnswer, resolveNeed } from "./context-request";
import { completeBrief, parseBrief, parseNeeds, type ContextNeed, type ReturnBrief } from "./return-brief";
import { UsageLedger, type CallKind, type UsageEntry, type UsageTotals } from "./usage-ledger";
import { outputProblems, unifiedDiff } from "./diff";
import { listFiles, readFiles, writeFiles } from "./workspace";

// Runs an approved plan with the agents in the tree. Plain code, no AI: the order, the limits, the
// retries and the choice of agent are decided here (docs/backend-plan.md, phase 3).

export interface TeamAgent extends AgentRef {
  priority: number;
  tool: ProviderId;
  model: string | null;
  effort: string | null;
  // The models its tool offers, so a task can ask for a stronger or lighter one (Plan task "model").
  models?: string[];
}

export type TaskStatus = "waiting" | "working" | "waiting_context" | "reviewing" | "done" | "unverified" | "failed" | "blocked" | "stopped";

// Rounds of context requests one task may make before it is shown as blocked (Stage 2).
export const MAX_CONTEXT_ROUNDS = 2;

export type TeamEvent =
  | { type: "run-started"; tasks: { id: string; title: string; role: string; agentId: string; agentName: string; deliverables: string[] }[] }
  | { type: "task"; taskId: string; status: TaskStatus; agentId: string | null; attempt: number; note?: string }
  | { type: "review"; taskId: string; reviewerId: string; approved: boolean; problems: string[] }
  | { type: "files"; taskId: string; files: { path: string; bytes: number }[] }
  | { type: "brief"; taskId: string; brief: ReturnBrief }
  | { type: "usage"; entry: UsageEntry }
  // What an agent writes, while it writes (done: false, the latest part) and when it is done (the whole
  // answer, cut to OUTPUT_CHARS). Shown when the user opens the agent in the tree.
  | { type: "output"; taskId: string; agentId: string; kind: "work" | "review"; attempt: number; text: string; done: boolean; failed?: string }
  // usage: token sums over the requests that reported them; totals: the full breakdown (Stage 3).
  | { type: "run-finished"; status: "done" | "failed" | "stopped"; summary: string; files: { path: string; bytes: number }[]; calls: number; usage: { inputTokens: number; outputTokens: number }; totals?: UsageTotals };

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
  private readonly ledger = new UsageLedger();
  private stopped = false;
  private readonly active = new Set<{ stop(): void }>();
  private readonly status = new Map<string, TaskStatus>();
  private readonly written = new Map<string, { path: string; bytes: number }>();
  // What each finished task produced, for the handoffs of the tasks after it.
  private readonly outputs = new Map<string, TaskOutput>();
  // What tasks need from the user or the Manager, and requests that were refused (Stage 2).
  private readonly escalations: string[] = [];
  private readonly notices: string[] = [];

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
  // Every request is recorded once in the usage ledger (Stage 3), also when it fails or is stopped:
  // only the final event of a reply counts, so streamed updates never add up twice.
  private async ask(agent: TeamAgent, prompt: string, meta: { taskId: string; kind: CallKind; attempt: number; model?: string | undefined }): Promise<string> {
    if (this.stopped) throw new Stopped();
    if (this.calls >= this.limits.maxCalls) throw new Error(`The limit of ${this.limits.maxCalls} agent requests for this run is reached.`);
    this.calls += 1;
    const seq = this.ledger.open();
    // The task's model when the Manager chose one and this agent's tool offers it; else the agent's own.
    const model = meta.model && agent.models?.includes(meta.model) ? meta.model : agent.model;
    const handle = this.o.adapters[agent.tool].chat({ provider: agent.tool, model, effort: agent.effort, history: [], text: prompt, cwd: this.o.cwd, raw: true });
    this.active.add(handle);
    let last: ChatEvent | null = null;
    let text = "";
    let sentAt = 0;
    const output = (done: boolean, failed?: string) => this.o.emit({ type: "output", taskId: meta.taskId, agentId: agent.id, kind: meta.kind === "review" ? "review" : "work", attempt: meta.attempt, done,
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
      const usage: Usage | null = last?.type === "completed" ? last.usage : null;
      const outcome = last?.type === "completed" ? "completed" : last?.type === "cancelled" || this.stopped ? "cancelled" : "failed";
      const entry = this.ledger.record(seq, { ...meta, agentId: agent.id, agentName: agent.name, role: agent.role, tool: agent.tool, model: agent.model, outcome }, usage);
      if (entry) this.o.emit({ type: "usage", entry });
    }
    if (last?.type === "completed") text = last.text || text;
    output(true, last?.type === "failed" ? last.message : last?.type === "completed" ? undefined : this.stopped || last?.type === "cancelled" ? "Stopped." : "No answer.");
    if (this.stopped || last?.type === "cancelled") throw new Stopped();
    if (last?.type === "failed") throw new Error(`${agent.name}: ${last.message}`);
    if (last?.type !== "completed") throw new Error(`${agent.name} gave no answer.`);
    return last.text;
  }

  private async runTask(task: PlanTask): Promise<void> {
    const { plan, agents, workspace } = this.o;
    // A direct request goes to the agent the user asked first, then to others with its role.
    const workers = task.agentId ? [...agents.filter((a) => a.id === task.agentId), ...agentsFor(task.role, agents).filter((a) => a.id !== task.agentId)] : agentsFor(task.role, agents);
    // A direct request (no plan, no handoff) may touch any file, so its agent reads the project (up to the limit).
    const existing = task.open ? listFiles(workspace) : [];
    const openContext = task.open ? readFiles(workspace, existing, this.limits.contextChars) : [];
    // The handoff, with its references resolved now that the tasks before it have finished. A
    // reference that cannot be resolved stops the task here: no agent is asked without it.
    const resolved = resolveHandoff(plan, task, workspace, this.outputs, this.limits.contextChars);
    if (resolved.problems.length) {
      this.set(task, "blocked", null, 0, `Missing context: ${resolved.problems.join(" ")}`);
      return;
    }
    // Context requests (Stage 2): answered once each, in a bounded number of rounds.
    const asked = new Set<string>();
    let rounds = 0;
    let problems: string[] = [];
    // The latest submitted version: a retry fixes it instead of starting over (Stage 3).
    let current: { path: string; content: string }[] = [];
    for (let attempt = 1; attempt <= this.limits.maxAttempts; attempt += 1) {
      // A retry goes to the next agent with the same role, if there is one (escalation by priority).
      const worker = workers[(attempt - 1) % workers.length]!;
      this.set(task, "working", worker.id, attempt, problems.length ? `Fixing: ${problems[0]}` : undefined);
      let text: string;
      try {
        if (attempt > 1) this.ledger.retries += 1;
        text = await this.ask(worker, workerPrompt(plan, task, worker, resolved, problems, problems.length ? current : [], { context: openContext, files: existing }), { taskId: task.id, kind: "worker", attempt, model: task.model });
      } catch (error) {
        if (error instanceof Stopped) throw error;
        if (/limit of \d+ agent requests/.test((error as Error).message)) throw error;
        problems = [(error as Error).message];
        continue;
      }
      const needs = parseNeeds(text);
      if (needs.length) {
        rounds += 1;
        const blocker = await this.answerNeeds(task, worker, needs, asked, resolved, rounds);
        if (blocker) {
          this.set(task, "blocked", worker.id, attempt, blocker);
          return;
        }
        // Asking for context is not a failed attempt.
        attempt -= 1;
        problems = [];
        continue;
      }
      const { summary, files } = parseFiles(text);
      // Deterministic checks first (missing or extra files, empty files, broken JSON or JavaScript):
      // a reviewer is only asked about output that passes them.
      const delivery = deliveryProblems(task, files);
      // A direct request answered without files: nothing to write or review.
      if (!delivery.length && task.open && !files.length) {
        this.set(task, "done", worker.id, attempt, "Answered without changing files.");
        return;
      }
      const outgoing = delivery.length ? [] : task.open
        ? files.map((f) => ({ path: safeRelativePath(f.path)!, content: f.content }))
        : files.map((f) => ({ path: task.deliverables.find((d) => d.toLowerCase() === f.path.replace(/\\/g, "/").toLowerCase())!, content: f.content }));
      const invalid = delivery.length ? [] : outputProblems(outgoing);
      if (delivery.length || invalid.length) {
        problems = [...delivery, ...invalid];
        if (outgoing.length) current = outgoing;
        continue;
      }
      // What the files were before this answer, so the reviewer can read the change.
      const previous = new Map(readFiles(workspace, outgoing.map((f) => f.path), Number.MAX_SAFE_INTEGER).map((f) => [f.path.toLowerCase(), f.content]));
      if (this.o.writeGuard) {
        await this.o.writeGuard.authorize(outgoing.map((f) => f.path));
        if (this.stopped) throw new Stopped();
      }
      this.o.snapshot?.before(outgoing.map((f) => f.path));
      const saved = writeFiles(workspace, outgoing);
      current = outgoing;
      const changes = outgoing.map((f) => {
        const before = previous.get(f.path.toLowerCase());
        return { path: f.path, content: f.content, diff: before === undefined ? null : unifiedDiff(f.path, before, f.content), isNew: before === undefined };
      });
      for (const f of saved) this.written.set(f.path.toLowerCase(), f);
      this.o.emit({ type: "files", taskId: task.id, files: saved });
      const observed = [`Delivered ${saved.map((f) => f.path).join(", ")}: the expected files, none empty, no others.`];
      const brief = completeBrief(parseBrief(text, task.id, plan.tasks.map((t) => t.id)), task.id, summary, saved.map((f) => f.path), observed);
      this.outputs.set(task.id, { title: task.title, role: task.role, summary: brief.summary, files: saved.map((f) => f.path), brief });

      const reviewer = REVIEW_ROLES.includes(task.role) ? null : reviewerFor(worker, agents);
      if (!reviewer) {
        this.keepBrief(task, brief);
        this.set(task, "unverified", worker.id, attempt, "No reviewer in the tree, so this was not checked.");
        return;
      }
      this.set(task, "reviewing", reviewer.id, attempt);
      let reviewText: string;
      try {
        const checks = [
          `Delivery check passed: ${outgoing.map((f) => f.path).join(", ")} delivered, none empty${task.open ? "" : ", no other files"}.`,
          ...(outgoing.some((f) => /\.(json|c?js)$/i.test(f.path)) ? ["Syntax check passed for the JSON and JavaScript files (compiled, not run)."] : []),
          ...(attempt > 1 ? [`This is attempt ${attempt}; the problems found last time were sent to the author.`] : []),
          "No code was run: agents cannot run tools in this version, so any test results in the author's brief are agent-reported.",
        ];
        reviewText = await this.ask(reviewer, reviewPrompt(plan, task, reviewer, worker, changes, resolved, checks, brief), { taskId: task.id, kind: "review", attempt });
      } catch (error) {
        if (error instanceof Stopped) throw error;
        if (/limit of \d+ agent requests/.test((error as Error).message)) throw error;
        problems = [(error as Error).message];
        continue;
      }
      const review = parseReview(reviewText);
      this.o.emit({ type: "review", taskId: task.id, reviewerId: reviewer.id, approved: review.approved, problems: review.problems });
      if (review.approved) {
        const reviewed = { ...brief, verified: [{ text: `Reviewed and approved by ${reviewer.name} (${reviewer.role}).`, source: "runner" as const }, ...brief.verified] };
        this.outputs.set(task.id, { ...this.outputs.get(task.id)!, brief: reviewed });
        this.keepBrief(task, reviewed);
        this.set(task, "done", worker.id, attempt, `Approved by ${reviewer.name}${reviewer.tool === worker.tool ? " (same tool as the author)" : ""}.`);
        return;
      }
      problems = review.problems;
    }
    this.set(task, "failed", null, this.limits.maxAttempts, problems[0] ?? "Not approved.");
  }

  // The brief goes to the window (the run card, and the Manager's next turn) and to later tasks.
  private keepBrief(task: PlanTask, brief: ReturnBrief): void {
    this.o.emit({ type: "brief", taskId: task.id, brief });
  }

  // Answers an agent's requests for context. Returns why the task cannot continue, or null when
  // everything was answered (or refused) and the agent can go on.
  private async answerNeeds(task: PlanTask, worker: TeamAgent, needs: ContextNeed[], asked: Set<string>, resolved: ResolvedHandoff, round: number): Promise<string | null> {
    const { plan, agents, workspace } = this.o;
    const waiting = needs.map((n) => n.ref).join("; ");
    this.ledger.contextRequests += needs.length;
    this.set(task, "waiting_context", worker.id, 0, `Waiting for context: ${waiting}`);
    if (round > MAX_CONTEXT_ROUNDS) {
      return this.escalate(task, `Still missing after ${MAX_CONTEXT_ROUNDS} rounds of questions: ${waiting}`);
    }
    const briefs = new Map([...this.outputs].flatMap(([id, out]) => (out.brief ? [[id, out.brief] as const] : [])));
    const blockers: string[] = [];
    for (const need of needs) {
      const key = needKey(need);
      if (asked.has(key)) {
        resolved.provided.push(`You asked again for ${need.ref}; it was answered above. Continue with what you have.`);
        continue;
      }
      asked.add(key);
      const r = resolveNeed(plan, task, need, workspace, briefs, this.limits.contextChars);
      if (r.kind === "provided") resolved.provided.push(`You asked for ${r.label}${need.why ? ` (${need.why})` : ""}:\n${r.content}`);
      else if (r.kind === "refused") {
        resolved.provided.push(`Not given: ${r.message}`);
        this.notices.push(`Task ${task.id} asked for something outside its scope: ${r.message}`);
      } else if (r.kind === "escalate") blockers.push(r.message);
      else {
        // The earlier task's agent answers the one question, from its own task and brief.
        const from = plan.tasks.find((t) => t.id === r.taskId)!;
        const answerer = agentsFor(from.role, agents)[0];
        if (!answerer) {
          blockers.push(`Task ${from.id} would know (${need.ref}), but no agent has its role.`);
          continue;
        }
        const reply = parseAnswer(await this.ask(answerer, followUpPrompt(plan, from, briefs.get(from.id), task, r.question), { taskId: task.id, kind: "follow-up", attempt: 0 }));
        if (reply) resolved.provided.push(`You asked task ${from.id} (${from.title}): ${need.ref}\nAnswer from ${answerer.name}: ${reply}`);
        else blockers.push(`Task ${from.id} could not answer: ${need.ref}`);
      }
    }
    return blockers.length ? this.escalate(task, blockers.join(" ")) : null;
  }

  // Shown in the run card and the Manager chat: what the task needs from the user or the Manager.
  private escalate(task: PlanTask, message: string): string {
    this.escalations.push(`${task.id} (${task.title}): ${message}`);
    return `Needs the Manager or you: ${message}`;
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
    if (this.escalations.length) parts.push(`Needs the Manager or you: ${this.escalations.join("; ").replace(/[.\s]+$/, "")}`);
    if (this.notices.length) parts.push(this.notices.join(" ").replace(/[.\s]+$/, ""));
    return this.finish(ok ? "done" : "failed", `${parts.join(". ")}.`);
  }

  private finish(status: "done" | "failed" | "stopped", summary: string): void {
    const totals = this.ledger.totals();
    this.o.emit({ type: "run-finished", status, summary, files: [...this.written.values()], calls: this.calls, usage: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens }, totals });
  }
}
