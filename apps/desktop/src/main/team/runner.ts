import type { ComputerGate } from "../access/access-service";
import { adapterOf, type AdapterSet, type ChatEvent, type ProviderId, type Usage } from "../providers/types";
import { REVIEW_ROLES, safeRelativePath, type Plan, type PlanTask } from "./plan";
import { deliveryProblems, parseFiles, parseReview, reviewPrompt, workerPrompt, type AgentRef, type LoadedSkill } from "./prompts";
import { loadSkill } from "../capabilities/registry";
import { resolveHandoff, type ResolvedHandoff, type TaskOutput } from "./handoff";
import { followUpPrompt, needKey, parseAnswer, resolveNeed } from "./context-request";
import { completeBrief, parseBrief, parseNeeds, type ContextNeed, type ReturnBrief } from "./return-brief";
import { UsageLedger, type CallKind, type UsageEntry, type UsageTotals } from "./usage-ledger";
import { outputProblems, unifiedDiff } from "./diff";
import { listFiles, readFiles, writeFiles } from "./workspace";
import { isStuck, ProviderFailure, providerReason, TOOL_NAME, type ReservationConflict, type TaskReason } from "./recovery";
import { checkpointPrompt, makeCheckpoint, type CheckpointStep, type RunState, type TaskCheckpoint } from "./checkpoint";

// Runs an approved plan with the agents in the tree. Plain code, no AI: the order, the limits, the
// retries and the choice of agent are decided here (docs/backend-plan.md, phase 3).

export interface TeamAgent extends AgentRef {
  priority: number;
  tool: ProviderId;
  model: string | null;
  effort: string | null;
  // The models its tool offers, so a task can ask for a stronger or lighter one (Plan task "model").
  models?: string[];
  // Skills (Capabilities): the agent's permanent key, the project's skills that are on for it, and
  // what it may use (filled in by the main process from the skill store; short descriptions only).
  agentKey?: string;
  projectSkills?: string[];
  skills?: { id: string; name: string; description: string }[];
  // Backup agents (ids, in priority order) that continue this agent's task when its provider's usage
  // limit is reached; "auto" switches at once, "ask" pauses the task with the backup offered.
  backups?: string[];
  backupMode?: "auto" | "ask";
  // False when the app knows this agent's tool is not ready (not installed or signed out).
  ready?: boolean;
}

export type TaskStatus = "waiting" | "working" | "waiting_context" | "reviewing" | "done" | "unverified" | "failed" | "blocked" | "stopped";

// Rounds of context requests one task may make before it is shown as blocked (Stage 2).
export const MAX_CONTEXT_ROUNDS = 2;

export type TeamEvent =
  | { type: "run-started"; tasks: { id: string; title: string; role: string; agentId: string; agentName: string; deliverables: string[] }[] }
  // reason: why a failed or blocked task stopped, and what helps next (recovery.ts).
  | { type: "task"; taskId: string; status: TaskStatus; agentId: string | null; attempt: number; note?: string; reason?: TaskReason }
  // Retry: the run continues with these tasks again (and the ones waiting for them).
  | { type: "run-resumed"; taskIds: string[] }
  | { type: "review"; taskId: string; reviewerId: string; approved: boolean; problems: string[] }
  | { type: "files"; taskId: string; files: { path: string; bytes: number }[] }
  | { type: "brief"; taskId: string; brief: ReturnBrief }
  // Which skills an agent got for a task (Capabilities), and the ones named that it does not have.
  | { type: "skills"; taskId: string; agentId: string; kind: "work" | "review"; loaded: { id: string; name: string }[]; refused: string[] }
  | { type: "usage"; entry: UsageEntry }
  // A backup agent took over a task after the provider's usage limit (from the last checkpoint).
  | { type: "switch"; taskId: string; fromId: string; fromName: string; fromTool: ProviderId; toId: string; toName: string; toTool: ProviderId; reason: string; resetsAt: number | null; step: CheckpointStep }
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
  adapters: AdapterSet;
  workspace: string;
  cwd: string;
  emit: (event: TeamEvent) => void;
  limits?: Partial<Limits>;
  // Coordinated runs (Teams phase 5): every write is authorised against the run's reservation
  // first. A refusal stops the run's writing; nothing is written without it.
  writeGuard?: { authorize(paths: string[]): Promise<void> };
  // Keeps the files as they were before this run first writes them, for Undo (history.ts).
  snapshot?: { before(paths: string[]): void };
  // Reads a skill's full instructions (Capabilities); the app's skill store by default.
  loadSkill?: (id: string) => { name: string; instructions: string } | null;
  // Computer access (main/access): reading granted folders and running approved checks, per agent.
  computer?: ComputerGate;
  // Checkpoints (checkpoint.ts): saved after each step and before an agent switch, on this computer.
  checkpoints?: { save(state: RunState): void };
  // A run saved before the app restarted: finished tasks keep their output, the others continue
  // from their checkpoints when retried.
  restore?: RunState;
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
  // Why a task is blocked or stopped: its own problem, an earlier task it needs, or the run halting.
  private readonly cause = new Map<string, "own" | "dependency" | "halted">();
  // A failed task's last findings and submitted files, so a retry fixes them instead of starting over.
  private readonly carry = new Map<string, { problems: string[]; files: { path: string; content: string }[] }>();
  private callLimit: number;
  private active_ = false;
  private readonly o: RunOptions;
  // Each task's checkpoint (the last finished step), saved with the run's state.
  private readonly checkpoints = new Map<string, TaskCheckpoint>();
  // Tools whose usage limit was reported in this run (one account per tool on this computer), with
  // the reset time when the provider gave one. Backups on the same tool are skipped.
  private readonly exhausted = new Map<ProviderId, number | null>();
  // An agent the user chose to continue a task with (Retry with a backup).
  private readonly pin = new Map<string, string>();
  // Tasks restored after a restart that continue from their checkpoint.
  private readonly resumed = new Set<string>();

  constructor(options: RunOptions) {
    this.o = { ...options };
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.callLimit = this.limits.maxCalls;
    if (options.restore) this.restoreFrom(options.restore);
  }

  // After a restart: finished tasks stay finished with their output (they never run again); a task
  // that was working when the app closed is stopped, and continues from its checkpoint on Retry,
  // with its last valid files and findings. Partial answers were never saved, so they are not used.
  private restoreFrom(r: RunState): void {
    for (const t of this.o.plan.tasks) {
      const s = r.status[t.id];
      const status: TaskStatus = s === "done" || s === "unverified" || s === "failed" || s === "blocked" ? s : "stopped";
      this.status.set(t.id, status);
      this.cause.set(t.id, status === "stopped" ? "halted" : "own");
      const out = r.outputs[t.id];
      if (out && (status === "done" || status === "unverified")) this.outputs.set(t.id, out);
      const cp = r.tasks[t.id];
      if (cp) this.checkpoints.set(t.id, cp);
      if (cp && status !== "done" && status !== "unverified") {
        this.resumed.add(t.id);
        const files = readFiles(this.o.workspace, cp.files, Number.MAX_SAFE_INTEGER).map((f) => ({ path: f.path, content: f.content }));
        this.carry.set(t.id, { problems: cp.findings, files });
      }
    }
    for (const w of r.written) this.written.set(w.path.toLowerCase(), w);
  }

  private persist(): void {
    if (!this.o.checkpoints) return;
    try {
      this.o.checkpoints.save({
        status: Object.fromEntries(this.status),
        outputs: Object.fromEntries([...this.outputs].map(([id, o]) => [id, { title: o.title, role: o.role, summary: o.summary, files: o.files, ...(o.brief ? { brief: o.brief } : {}) }])),
        tasks: Object.fromEntries(this.checkpoints),
        written: [...this.written.values()],
      });
    } catch {
      /* a checkpoint that cannot be written never stops the run */
    }
  }

  private checkpoint(task: PlanTask, patch: Partial<TaskCheckpoint>): TaskCheckpoint {
    const cp = makeCheckpoint(task, patch, this.checkpoints.get(task.id));
    this.checkpoints.set(task.id, cp);
    this.persist();
    return cp;
  }

  // The task's checkpoint, for tests and the run card.
  checkpointOf(taskId: string): TaskCheckpoint | undefined {
    return this.checkpoints.get(taskId);
  }

  get running(): boolean {
    return this.active_;
  }

  // The task's status now (tests and the retry checks).
  statusOf(taskId: string): TaskStatus | undefined {
    return this.status.get(taskId);
  }

  stop(): void {
    this.stopped = true;
    for (const handle of this.active) handle.stop();
  }

  private set(task: PlanTask, status: TaskStatus, agentId: string | null, attempt: number, note?: string, reason?: TaskReason, cause: "own" | "dependency" | "halted" = "own"): void {
    this.status.set(task.id, status);
    this.cause.set(task.id, cause);
    this.o.emit({ type: "task", taskId: task.id, status, agentId, attempt, ...(note ? { note } : {}), ...(reason ? { reason } : {}) });
    this.persist();
  }

  // One request to one agent. Returns the full text, or throws with a message for the next attempt.
  // Every request is recorded once in the usage ledger (Stage 3), also when it fails or is stopped:
  // only the final event of a reply counts, so streamed updates never add up twice.
  private async ask(agent: TeamAgent, prompt: string, meta: { taskId: string; kind: CallKind; attempt: number; model?: string | undefined }): Promise<string> {
    if (this.stopped) throw new Stopped();
    if (this.calls >= this.callLimit) throw new Error(`The limit of ${this.limits.maxCalls} agent requests for this run is reached.`);
    this.calls += 1;
    const seq = this.ledger.open();
    // The task's model when the Manager chose one and this agent's tool offers it; else the agent's own.
    const model = meta.model && agent.models?.includes(meta.model) ? meta.model : agent.model;
    const handle = adapterOf(this.o.adapters, agent.tool).chat({ provider: agent.tool, model, effort: agent.effort, history: [], text: prompt, cwd: this.o.cwd, raw: true });
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
    if (last?.type === "failed") throw new ProviderFailure(`${agent.name}: ${last.message}`, last.reason, agent.tool, agent.id, agent.name, model, last.resetsAt ?? null);
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
      this.set(task, "blocked", null, 0, `Missing context: ${resolved.problems.join(" ")}`, { kind: "needs_context", title: "This task is missing context it needs before an agent can start.", detail: resolved.problems.join(" "), needs: resolved.problems, role: task.role });
      return;
    }
    // Context requests (Stage 2): answered once each, in a bounded number of rounds.
    const asked = new Set<string>();
    let rounds = 0;
    // A retry of this task starts from the last findings and the last submitted files.
    const carried = this.carry.get(task.id);
    this.carry.delete(task.id);
    let problems: string[] = carried?.problems ?? [];
    // The latest submitted version: a retry fixes it instead of starting over (Stage 3).
    let current: { path: string; content: string }[] = carried?.files ?? [];
    // Why the last attempt did not pass, for the card if this task fails.
    let lastReason: TaskReason | null = null;
    const stuck = new Set<string>();
    const started = this.checkpoints.get(task.id);
    if (!started) this.checkpoint(task, { step: "started", pending: [task.open ? "Answer the request or change the files it needs" : `Deliver ${task.deliverables.join(", ")}`, "Pass review"] });
    // The agent that continues this task: a backup after a usage limit, or the one the user chose on Retry.
    const chosen = this.pin.get(task.id);
    this.pin.delete(task.id);
    let pinned: TeamAgent | null = chosen ? agents.find((a) => a.id === chosen && a.role === task.role) ?? null : null;
    // A task continued from a checkpoint (after a switch or a restart) gets it with its handoff.
    let resumeNote: string | null = this.resumed.has(task.id) || pinned ? checkpointPrompt(this.checkpoints.get(task.id)!) : null;
    this.resumed.delete(task.id);
    // Agents this task already went to after a usage limit, so it never switches back and forth.
    const tried = new Set<string>();
    const primary = workers[0]!;
    for (let attempt = 1; attempt <= this.limits.maxAttempts; attempt += 1) {
      // A retry goes to the next agent with the same role, if there is one (escalation by priority).
      const worker = pinned ?? workers[(attempt - 1) % workers.length]!;
      tried.add(worker.id);
      // Its tool's usage limit was already reported in this run: switch without spending a request.
      if (this.exhausted.has(worker.tool)) {
        const next = this.onUsageLimit(task, primary, worker, tried, problems, current, attempt, this.exhausted.get(worker.tool) ?? null, `${TOOL_NAME[worker.tool] ?? worker.tool} reached its usage limit earlier in this run`);
        if (!next) return;
        pinned = next.agent;
        resumeNote = next.note;
        attempt -= 1;
        continue;
      }
      this.set(task, "working", worker.id, attempt, problems.length ? `Fixing: ${problems[0]}` : undefined);
      let text: string;
      try {
        if (attempt > 1) this.ledger.retries += 1;
        const prompt = withComputer(workerPrompt(plan, task, worker, resolved, problems, problems.length || resumeNote ? current : [], { context: openContext, files: existing }, this.skills(task, worker, "work")), this.o.computer?.describe(worker.agentKey));
        text = await this.ask(worker, resumeNote ? `${prompt}\n\n${resumeNote}` : prompt, { taskId: task.id, kind: "worker", attempt, model: task.model });
      } catch (error) {
        if (error instanceof Stopped) throw error;
        if (/limit of \d+ agent requests/.test((error as Error).message)) throw error;
        // The provider's usage limit: a configured backup continues from the checkpoint. Whatever the
        // agent wrote before it stopped is unfinished and is not used.
        if (error instanceof ProviderFailure && error.reason === "usage_limit") {
          this.exhausted.set(error.provider, error.resetsAt);
          const next = this.onUsageLimit(task, primary, worker, tried, problems, current, attempt, error.resetsAt, `${TOOL_NAME[worker.tool] ?? worker.tool} reached its usage limit`, error);
          if (!next) return;
          pinned = next.agent;
          resumeNote = next.note;
          attempt -= 1;
          continue;
        }
        problems = [(error as Error).message];
        lastReason = error instanceof ProviderFailure ? providerReason(error) : { kind: "unknown", title: `${worker.name} did not answer.`, detail: (error as Error).message, agentId: worker.id, agentName: worker.name };
        // Signed out or out of usage: asking the same tool again cannot help.
        if (isStuck(error)) {
          stuck.add(worker.id);
          if (workers.every((w) => stuck.has(w.id))) {
            this.carry.set(task.id, { problems: [], files: current });
            this.set(task, "failed", worker.id, attempt, lastReason.title, lastReason);
            return;
          }
        }
        continue;
      }
      const needs = parseNeeds(text);
      if (needs.length) {
        rounds += 1;
        const blocker = await this.answerNeeds(task, worker, needs, asked, resolved, rounds);
        if (blocker) {
          const asks = blocker.replace(/^Needs the Manager or you: /, "");
          this.set(task, "blocked", worker.id, attempt, blocker, { kind: "needs_context", title: `${worker.name} needs something from the Manager or you before it can continue.`, detail: blocker, needs: [asks], agentId: worker.id, agentName: worker.name, role: task.role });
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
        lastReason = { kind: "review_rejected", title: "The delivered files did not pass the app's checks.", detail: problems.join(" "), findings: problems, reviewer: "The app's checks", agentId: worker.id, agentName: worker.name };
        if (outgoing.length) current = outgoing;
        this.checkpoint(task, { findings: problems, agentId: worker.id, agentName: worker.name, attempt });
        continue;
      }
      // What the files were before this answer, so the reviewer can read the change.
      const previous = new Map(readFiles(workspace, outgoing.map((f) => f.path), Number.MAX_SAFE_INTEGER).map((f) => [f.path.toLowerCase(), f.content]));
      if (this.o.writeGuard) {
        try {
          await this.o.writeGuard.authorize(outgoing.map((f) => f.path));
        } catch (error) {
          if (error instanceof Stopped) throw error;
          // A teammate's reservation (or lost coordination): nothing is written; the answer is kept for a retry.
          const conflicts = ((error as { conflicts?: ReservationConflict[] }).conflicts ?? []);
          this.carry.set(task.id, { problems: [], files: outgoing });
          this.notices.push(`${task.title}: ${(error as Error).message}`);
          this.set(task, "blocked", worker.id, attempt, (error as Error).message, {
            kind: "reservation", title: conflicts.length ? `${conflicts.map((c) => c.name).join(", ")} reserved files this task writes, so nothing was written.` : "Your team's reservation for these files could not be confirmed, so nothing was written.",
            detail: (error as Error).message, conflicts, agentId: worker.id, agentName: worker.name,
          });
          return;
        }
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
      this.o.computer?.delivered(task.id, worker.agentKey, worker.name, saved.map((f) => f.path));
      const observed = [`Delivered ${saved.map((f) => f.path).join(", ")}: the expected files, none empty, no others.`];
      const brief = completeBrief(parseBrief(text, task.id, plan.tasks.map((t) => t.id)), task.id, summary, saved.map((f) => f.path), observed);
      this.outputs.set(task.id, { title: task.title, role: task.role, summary: brief.summary, files: saved.map((f) => f.path), brief });
      const reviewNext = !REVIEW_ROLES.includes(task.role) && reviewerFor(worker, agents);
      const before = this.checkpoints.get(task.id);
      this.checkpoint(task, {
        step: "delivered", agentId: worker.id, agentName: worker.name, attempt, files: saved.map((f) => f.path), summary: brief.summary,
        decisions: [...(before?.decisions ?? []), ...brief.decisions],
        completed: [...(before?.completed ?? []), `Delivered ${saved.map((f) => f.path).join(", ")} (attempt ${attempt}, ${worker.name}); the app's checks passed.`],
        pending: reviewNext ? ["Pass review"] : [], findings: [],
      });

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
        const reviewBase = withComputer(reviewPrompt(plan, task, reviewer, worker, changes, resolved, checks, brief, this.skills(task, reviewer, "review")), this.o.computer?.describe(reviewer.agentKey));
        reviewText = await this.ask(reviewer, reviewBase, { taskId: task.id, kind: "review", attempt });
        // A reviewer with computer access may read the checkout or run an approved check, then review.
        for (let round = 0; round < 2 && this.o.computer; round += 1) {
          const wants = parseNeeds(reviewText).filter((n) => n.kind === "computer" || n.kind === "check");
          if (!wants.length) break;
          const answers: string[] = [];
          for (const need of wants) answers.push(await this.computerNeed(task, reviewer, need));
          reviewText = await this.ask(reviewer, `${reviewBase}\n\n## What you asked for\n${answers.join("\n\n")}\n\nNow give your review.`, { taskId: task.id, kind: "review", attempt });
        }
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
        this.checkpoint(task, { step: "reviewed", completed: [...(this.checkpoints.get(task.id)?.completed ?? []), `Approved by ${reviewer.name}.`], pending: [], findings: [] });
        this.set(task, "done", worker.id, attempt, `Approved by ${reviewer.name}${reviewer.tool === worker.tool ? " (same tool as the author)" : ""}.`);
        return;
      }
      problems = review.problems;
      this.checkpoint(task, { findings: review.problems, pending: ["Fix the review findings", "Pass review"] });
      lastReason = { kind: "review_rejected", title: `${reviewer.name} did not approve the work after ${attempt} attempt${attempt === 1 ? "" : "s"}.`, detail: review.problems.join(" ") || "Not approved.", findings: review.problems, reviewer: reviewer.name, agentId: worker.id, agentName: worker.name };
    }
    this.carry.set(task.id, { problems, files: current });
    this.set(task, "failed", null, this.limits.maxAttempts, problems[0] ?? "Not approved.", lastReason ?? { kind: "unknown", title: "The task did not pass.", detail: problems.join(" ") || "Not approved." });
  }

  // A usage limit on a task's agent. Only the backups configured for the task's primary agent are
  // considered, in their order, skipping any already tried, any on a tool whose limit was reported in
  // this run (same account) and any the app knows is not ready. The checkpoint is saved first. Returns
  // the backup to continue with (auto), or null when the task paused (ask) or failed (no backup).
  private onUsageLimit(task: PlanTask, primary: TeamAgent, worker: TeamAgent, tried: Set<string>, problems: string[], current: { path: string; content: string }[], attempt: number, resetsAt: number | null, why: string, error?: ProviderFailure): { agent: TeamAgent; note: string } | null {
    const agents = this.o.agents;
    const configured = (primary.backups ?? []).map((id) => agents.find((a) => a.id === id)).filter((a): a is TeamAgent => Boolean(a) && a!.role === task.role && a!.id !== primary.id);
    const skipped: string[] = [];
    let next: TeamAgent | null = null;
    for (const b of configured) {
      if (tried.has(b.id)) continue;
      if (this.exhausted.has(b.tool)) { skipped.push(`${b.name} uses ${TOOL_NAME[b.tool] ?? b.tool}, which reached its limit too (same account)`); continue; }
      if (b.ready === false) { skipped.push(`${b.name} is not ready (${TOOL_NAME[b.tool] ?? b.tool} is not installed or signed out)`); continue; }
      next = b;
      break;
    }
    const base = providerReason(error ?? new ProviderFailure(why, "usage_limit", worker.tool, worker.id, worker.name, worker.model, resetsAt));
    this.carry.set(task.id, { problems, files: current });
    const sw = next ? { fromId: worker.id, fromName: worker.name, toId: next.id, toName: next.name, reason: `${why}`, at: new Date().toISOString() } : null;
    const prev = this.checkpoints.get(task.id);
    const cp = this.checkpoint(task, { step: "switching", ...(sw ? { switches: [...(prev?.switches ?? []), sw] } : {}), findings: problems, files: current.map((f) => f.path).length ? current.map((f) => f.path) : prev?.files ?? [] });
    const resets = resetsAt ? { resetsAt } : {};
    if (next && (primary.backupMode ?? "auto") === "auto") {
      this.o.emit({ type: "switch", taskId: task.id, fromId: worker.id, fromName: worker.name, fromTool: worker.tool, toId: next.id, toName: next.name, toTool: next.tool, reason: why, resetsAt, step: prev?.step === "switching" ? "started" : prev?.step ?? "started" });
      this.set(task, "working", next.id, attempt, `${TOOL_NAME[worker.tool] ?? worker.tool} reached its usage limit. ${next.name} resumed from the last checkpoint.`);
      return { agent: next, note: checkpointPrompt(cp) };
    }
    if (next) {
      this.set(task, "blocked", worker.id, attempt, `${TOOL_NAME[worker.tool] ?? worker.tool} reached its usage limit. ${next.name} can continue from the last checkpoint.`, {
        ...base, ...resets, kind: "usage_limit", title: `${TOOL_NAME[worker.tool] ?? worker.tool} reached its usage limit. ${next.name} can continue from the last checkpoint when you switch.`, backup: { id: next.id, name: next.name, tool: next.tool },
      });
      return null;
    }
    const detail = [base.detail, configured.length ? "" : "No backup agents are set for this agent.", ...skipped].filter(Boolean).join(" ");
    this.set(task, "failed", worker.id, attempt, `${TOOL_NAME[worker.tool] ?? worker.tool} reached its usage limit and no backup agent can continue.`, {
      ...base, ...resets, kind: "usage_limit", detail, title: configured.length ? `${TOOL_NAME[worker.tool] ?? worker.tool} reached its usage limit, and none of ${primary.name}'s backup agents can continue.` : `${TOOL_NAME[worker.tool] ?? worker.tool} reached its usage limit, and ${primary.name} has no backup agents.`,
    });
    return null;
  }

  // The skills a task's handoff names that this agent has: their full instructions, loaded now. A
  // named skill the agent does not have is not loaded (an agent can only use its own skills), and
  // the run details show both.
  private skills(task: PlanTask, agent: TeamAgent, kind: "work" | "review"): LoadedSkill[] {
    const wanted = task.handoff?.skills ?? [];
    if (!wanted.length) return [];
    const allowed = new Set((agent.skills ?? []).map((s) => s.id));
    const load = this.o.loadSkill ?? loadSkill;
    const loaded: LoadedSkill[] = [];
    const refused: string[] = [];
    for (const id of wanted) {
      const s = allowed.has(id) ? load(id) : null;
      if (s) loaded.push({ id, ...s });
      else refused.push(id);
    }
    this.o.emit({ type: "skills", taskId: task.id, agentId: agent.id, kind, loaded: loaded.map((s) => ({ id: s.id, name: s.name })), refused });
    return loaded;
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
      if (need.kind === "computer" || need.kind === "check") {
        resolved.provided.push(await this.computerNeed(task, worker, need));
        continue;
      }
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

  // A read of a granted folder or an approved check. Without access it is refused and noted; the
  // permission is checked by main/access at this moment, so a revoke during the run applies at once.
  private async computerNeed(task: PlanTask, agent: TeamAgent, need: ContextNeed): Promise<string> {
    const gate = this.o.computer;
    const r = !gate ? { ok: false as const, message: "No computer access in this project." }
      : need.kind === "check" ? await gate.check(agent.agentKey, agent.name, need.ref)
      : gate.read(agent.agentKey, agent.name, need.ref);
    if (this.stopped) throw new Stopped();
    if (r.ok) return `You asked for ${r.label}${need.why ? ` (${need.why})` : ""}:\n${r.content}`;
    this.notices.push(`Task ${task.id}: ${r.message}`);
    return `Not given: ${r.message}`;
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
      for (const t of plan.tasks) {
        if (missing.includes(t.role)) this.set(t, "blocked", null, 0, `No agent with the role ${t.role}.`, { kind: "agent_missing", title: `No agent in the tree has the role ${t.role} and runs on Claude Code, Codex or Gemini.`, detail: `Missing role: ${t.role}.`, role: t.role });
        else this.set(t, "blocked", null, 0, "Not started: the team is missing agents.", { kind: "dependency", title: "Not started: the team is missing agents for other tasks.", detail: `Missing roles: ${missing.join(", ")}.`, after: [] }, "halted");
      }
      return this.finish("failed", `No agent in the tree runs on Claude Code, Codex or Gemini for: ${missing.join(", ")}. Set one in the tree and start again.`);
    }
    for (const t of plan.tasks) this.set(t, "waiting", null, 0);
    await this.schedule();
  }

  // Retry (run card): runs one failed or blocked task again, with the agents as they are now, and
  // then the tasks that were waiting for it. Finished tasks keep their output and never run again.
  async retry(taskId: string, agents: TeamAgent[], writeGuard?: { authorize(paths: string[]): Promise<void> }, options: { switchTo?: string } = {}): Promise<void> {
    const { plan } = this.o;
    if (this.active_) throw new Error("The team is still working on this run.");
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("Unknown task.");
    if (!["failed", "blocked", "stopped"].includes(this.status.get(taskId) ?? "")) throw new Error("Only a task that failed or is blocked can be retried.");
    const missing = missingRoles({ ...plan, tasks: [task] }, agents);
    if (missing.length) throw new Error(`No agent in the tree has the role ${missing.join(", ")}.`);
    if (options.switchTo) {
      const to = agents.find((a) => a.id === options.switchTo);
      if (!to || to.role !== task.role) throw new Error("That backup agent does not have this task's role.");
      this.pin.set(taskId, to.id);
      this.resumed.add(taskId);
    }
    this.o.agents = agents;
    // A retry asks the tools again: a usage limit may have reset since.
    this.exhausted.clear();
    if (writeGuard) this.o.writeGuard = writeGuard;
    else delete this.o.writeGuard;
    this.stopped = false;
    // A fresh request budget for the retry; usage keeps adding up for the whole run.
    this.callLimit = this.calls + this.limits.maxCalls;
    // The task, and every task that waited for it (directly or through others) or never started
    // because the run halted. Tasks blocked for their own reasons stay as they are.
    const again = new Set([taskId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of plan.tasks) {
        if (again.has(t.id)) continue;
        const s = this.status.get(t.id);
        const cause = this.cause.get(t.id);
        if (!["blocked", "stopped", "waiting"].includes(s ?? "") || cause === "own") continue;
        if (cause === "halted" || s === "stopped" || t.dependsOn.some((d) => again.has(d))) { again.add(t.id); grew = true; }
      }
    }
    for (let i = this.escalations.length - 1; i >= 0; i -= 1) if ([...again].some((id) => this.escalations[i]!.startsWith(`${id} (`))) this.escalations.splice(i, 1);
    this.notices.length = 0;
    this.o.emit({ type: "run-resumed", taskIds: [...again] });
    for (const t of plan.tasks) if (again.has(t.id)) this.set(t, "waiting", null, 0);
    await this.schedule();
  }

  private async schedule(): Promise<void> {
    const { plan } = this.o;
    this.active_ = true;
    const running = new Map<string, Promise<void>>();
    let failure: string | null = null;
    try {
      while (true) {
        const finished = (id: string) => ["done", "unverified"].includes(this.status.get(id) ?? "");
        for (const t of plan.tasks) {
          const failedDeps = t.dependsOn.filter((d) => ["failed", "blocked", "stopped"].includes(this.status.get(d) ?? ""));
          if (!this.stopped && this.status.get(t.id) === "waiting" && failedDeps.length) {
            const names = failedDeps.map((d) => plan.tasks.find((x) => x.id === d)?.title ?? d);
            this.set(t, "blocked", null, 0, "An earlier task it needs did not finish.", { kind: "dependency", title: `Waiting for ${names.join(", ")} to pass. Retry that task first.`, detail: `Depends on ${failedDeps.join(", ")}.`, after: failedDeps }, "dependency");
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
                const limit = /limit of \d+ agent requests/.test(failure);
                this.set(t, "failed", null, 0, failure, limit
                  ? { kind: "limit", title: "The run reached its limit of agent requests before this task passed.", detail: failure }
                  : { kind: "unknown", title: "The task stopped with an error the app did not expect.", detail: failure });
              }
            }).finally(() => running.delete(t.id));
            running.set(t.id, job);
          }
        }
        if (running.size === 0) break;
        await Promise.race(running.values());
      }
      for (const t of plan.tasks) {
        if (this.status.get(t.id) === "waiting") {
          if (this.stopped) this.set(t, "stopped", null, 0, undefined, undefined, "halted");
          else this.set(t, "blocked", null, 0, failure ?? undefined, { kind: "dependency", title: "Not started: the run stopped before this task.", detail: failure ?? "The run stopped.", after: [] }, "halted");
        }
      }
    } finally {
      this.active_ = false;
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

// The agent's computer access, after its prompt (nothing when it has none in this project).
function withComputer(prompt: string, access: string | null | undefined): string {
  return access ? `${prompt}\n\n${access}` : prompt;
}
