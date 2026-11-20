import { ancestors, fileOwner, type Handoff, type Plan, type PlanTask } from "./plan";
import { briefText, type ReturnBrief } from "./return-brief";
import { listFiles, readFiles } from "./workspace";

// Turns a task's handoff into what its agent reads (Stage 1 of task-specific handoffs). The handoff
// comes from the approved plan; the runner resolves its references here, once the tasks they come
// from have finished. Only the plan and the outputs of earlier tasks are used: never the chat, and
// never the whole project. A reference that cannot be resolved stops the task before it starts.

export interface TaskOutput {
  title: string;
  role: string;
  summary: string;
  files: string[];
  // The agent's return brief (Stage 2), with what the runner verified itself.
  brief?: ReturnBrief;
}

export interface Attachment {
  path: string;
  content: string;
  source: string;
  why: string;
  full: boolean;
}

export interface ResolvedHandoff {
  handoff: Handoff;
  // Read in full or as an excerpt, as the handoff asks.
  attachments: Attachment[];
  // Results of earlier tasks the agent should know about (summaries, not file contents).
  earlier: string[];
  // References that could not be resolved. Non-empty means: do not launch the task.
  problems: string[];
  // Details the agent asked for and got while doing the task (Stage 2).
  provided: string[];
  // The tasks that use this task's result, so the agent can tag its findings for them.
  dependents: { id: string; title: string }[];
}

const EXCERPT_CHARS = 1500;

// A plan made before handoffs existed: the handoff is built from what the task already says, and
// the agent gets what it got before (the files of the tasks it depends on, existing files its goal
// names, and its own files if they exist).
export function legacyHandoff(plan: Plan, task: PlanTask, existing: string[]): Handoff {
  const fromDeps = plan.tasks.filter((t) => task.dependsOn.includes(t.id)).flatMap((t) => t.deliverables.map((file) => ({ file, why: "", full: true })));
  const mentioned = existing
    .filter((f) => task.goal.includes(f) && !fileOwner(plan, f))
    .map((file) => ({ file, why: "", full: true }));
  return {
    deliverable: `The files ${task.deliverables.join(", ")}, doing what the task asks.`,
    decisions: [],
    rules: [],
    findings: [],
    references: [...fromDeps, ...mentioned],
    acceptance: [
      `Every file listed (${task.deliverables.join(", ")}) is delivered and complete, with no placeholders.`,
      "The work does what the task asks.",
    ],
    verify: "A reviewer reads the delivered files against this handoff.",
  };
}

export function resolveHandoff(plan: Plan, task: PlanTask, workspace: string, outputs: Map<string, TaskOutput>, maxChars: number): ResolvedHandoff {
  const existing = listFiles(workspace);
  const have = new Set(existing.map((f) => f.toLowerCase()));
  const handoff = task.handoff ?? legacyHandoff(plan, task, existing);
  const before = new Set(ancestors(plan, task).map((t) => t.id));
  const problems: string[] = [];
  const attachments: Attachment[] = [];
  const earlier: string[] = [];
  let used = 0;
  const attach = (path: string, source: string, why: string, full: boolean) => {
    if (attachments.some((a) => a.path.toLowerCase() === path.toLowerCase())) return;
    const room = Math.max(0, maxChars - used);
    const [read] = room > 0 ? readFiles(workspace, [path], full ? room : Math.min(room, EXCERPT_CHARS)) : [];
    if (!read) {
      // Said out loud, never dropped silently.
      attachments.push({ path, content: "[Not included: this task's context limit is reached. Ask for a smaller plan.]", source, why, full });
      return;
    }
    const content = full ? read.content : read.content.replace(/\n\[\.\.\. cut to fit \.\.\.\]$/, "\n[... excerpt: the start of the file ...]");
    used += content.length;
    attachments.push({ path, content, source, why, full });
  };
  const describe = (id: string) => {
    const out = outputs.get(id);
    if (!out) return null;
    const label = `Task ${id} (${out.title}, ${out.role}) delivered ${out.files.join(", ") || "no files"}`;
    // Only the findings that matter for this task; the others are listed by id, to ask for.
    return out.brief ? briefText(out.brief, label, task.id) : `${label}${out.summary ? `: ${out.summary}` : "."}`;
  };

  for (const ref of handoff.references) {
    if (ref.task) {
      const line = before.has(ref.task) ? describe(ref.task) : null;
      if (!line) problems.push(`The result of task ${ref.task} is not available${before.has(ref.task) ? " (it has not finished)" : " (it is not an earlier task of this one)"}.`);
      else if (!earlier.includes(line)) earlier.push(`${line}${ref.why ? `\nWhy it matters: ${ref.why}` : ""}`);
      continue;
    }
    const file = ref.file!;
    const owner = fileOwner(plan, file);
    if (owner && owner.id === task.id) {
      // The task's own file: its current content, if it already exists, so it can be changed.
      if (have.has(file.toLowerCase())) attach(file, "your current version", ref.why, true);
      continue;
    }
    if (owner && !before.has(owner.id)) {
      problems.push(`${file} belongs to task ${owner.id}, which this task does not depend on.`);
      continue;
    }
    if (!have.has(file.toLowerCase())) {
      problems.push(owner ? `${file} should have been delivered by task ${owner.id}, but it is not in the project folder.` : `${file} is not in the project folder.`);
      continue;
    }
    attach(file, owner ? `from task ${owner.id}` : "a project file", ref.why, ref.full);
  }
  // Its own files, if they exist, so the agent changes them instead of starting over.
  for (const own of task.deliverables) if (have.has(own.toLowerCase())) attach(own, "your current version", "", true);
  // The tasks it directly depends on, in a line each.
  for (const d of task.dependsOn) {
    const line = describe(d);
    if (line && !earlier.some((e) => e.startsWith(line))) earlier.push(line);
  }
  const dependents = plan.tasks.filter((t) => t.dependsOn.includes(task.id)).map((t) => ({ id: t.id, title: t.title }));
  return { handoff, attachments, earlier, problems, provided: [], dependents };
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

// The handoff in the one format every role reads. The structured handoff is kept whole inside the
// app; the prompt only shows the parts that say something (Stage 3: empty sections, defaults and
// repeated lines cost tokens on every call and tell the agent nothing). Project rules are always
// shown. Referenced files are listed with the files themselves (prompts.ts), not twice.
export function handoffText(plan: Plan, task: PlanTask, resolved: ResolvedHandoff, forReview = false): string {
  const h = resolved.handoff;
  const rules = [...(plan.rules ?? []).map((r) => `[project] ${r}`), ...h.rules.map((r) => `[task] ${r}`)];
  const parts = [
    `HANDOFF for task ${task.id}: ${task.title} (${task.role})`,
    `Goal: ${task.goal}${h.deliverable && !task.goal.includes(h.deliverable) ? `\nExpected deliverable: ${h.deliverable}` : ""}`,
    `Deliver exactly these files: ${task.deliverables.join(", ")}`,
  ];
  if (h.decisions.length) parts.push(`Decisions already made (do not reopen them):\n${bullets(h.decisions)}`);
  if (rules.length) parts.push(`Rules and constraints (must follow):\n${bullets(rules)}`);
  if (h.findings.length) parts.push(`Findings:\n${bullets(h.findings)}`);
  if (forReview && resolved.attachments.length) parts.push(`The author read: ${resolved.attachments.map((a) => a.path).join(", ")}`);
  if (resolved.earlier.length) parts.push(`Earlier tasks:\n${resolved.earlier.join("\n\n")}`);
  if (resolved.provided.length) parts.push(`Details you asked for:\n${resolved.provided.join("\n\n")}`);
  if (h.acceptance.length) parts.push(`Acceptance criteria:\n${bullets(h.acceptance)}`);
  if (h.verify) parts.push(`How it will be verified: ${h.verify}`);
  return parts.join("\n\n");
}

// How a referenced file is introduced to the agent, with why it is there.
export function attachmentHeader(a: Attachment): string {
  return `--- ${a.path} (${a.source}${a.full ? "" : ", excerpt"}${a.why ? `: ${a.why}` : ""}) ---`;
}
