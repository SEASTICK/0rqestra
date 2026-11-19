import { ancestors, fileOwner, safeRelativePath, type Plan, type PlanTask } from "./plan";
import type { ContextNeed, ReturnBrief } from "./return-brief";
import { listFiles, readFiles } from "./workspace";

// Stage 2: an agent asked for something it is missing. The runner answers from what the approved
// plan and the finished tasks already hold. When the detail does not exist yet but an earlier task
// in the plan can give it, the question goes to that task's agent. New scope, a new decision or a
// missing file go to the Manager chat. A request never widens what the task may read or write.

export type Resolution =
  | { kind: "provided"; key: string; label: string; content: string }
  | { kind: "route"; key: string; taskId: string; question: string }
  // Outside the task's approved scope: not given; the agent is told, and the Manager chat shows it.
  | { kind: "refused"; key: string; message: string }
  // Cannot continue without the user or the Manager (a decision, new scope, or a missing file).
  | { kind: "escalate"; key: string; message: string };

export const needKey = (need: ContextNeed): string => `${need.kind}:${need.task ?? ""}:${need.ref.toLowerCase()}`;

// The files a task may read: its own deliverables, those of the tasks before it, and the files its
// handoff refers to. Nothing else, whatever it asks for.
export function readableFiles(plan: Plan, task: PlanTask): Set<string> {
  const files = [...task.deliverables, ...ancestors(plan, task).flatMap((t) => t.deliverables), ...(task.handoff?.references ?? []).flatMap((r) => (r.file ? [r.file] : []))];
  return new Set(files.map((f) => f.toLowerCase()));
}

export function resolveNeed(plan: Plan, task: PlanTask, need: ContextNeed, workspace: string, briefs: Map<string, ReturnBrief>, maxChars: number): Resolution {
  const key = needKey(need);
  const before = ancestors(plan, task);
  const isBefore = (id: string | null) => Boolean(id && before.some((t) => t.id === id));
  // The task that should know: the one named, else the one the task depends on directly.
  const askTask = (named: string | null) => (isBefore(named) ? named! : task.dependsOn[0] ?? null);

  if (need.kind === "file") {
    const file = safeRelativePath(need.ref);
    if (!file) return { kind: "refused", key, message: `"${need.ref}" is not a plain relative file in the project.` };
    if (!readableFiles(plan, task).has(file.toLowerCase())) {
      return { kind: "refused", key, message: `${file} is outside this task's approved scope, so it is not given. The Manager can change the plan if it is needed.` };
    }
    const exists = listFiles(workspace).some((f) => f.toLowerCase() === file.toLowerCase());
    const owner = fileOwner(plan, file);
    if (!exists) {
      if (owner?.id === task.id) return { kind: "provided", key, label: `${file}`, content: "This file does not exist yet: this task creates it." };
      return { kind: "escalate", key, message: owner ? `${file} is missing: task ${owner.id} should have delivered it.` : `${file} is not in the project folder.` };
    }
    const [read] = readFiles(workspace, [file], maxChars);
    return { kind: "provided", key, label: `the file ${file}`, content: read ? `--- ${file} ---\n${read.content}` : `--- ${file} ---\n[Not included: this task's context limit is reached.]` };
  }

  if (need.kind === "finding") {
    const byId = /^([A-Za-z0-9_-]{1,24})\.f(\d{1,2})$/.exec(need.ref);
    if (byId) {
      const from = byId[1]!;
      if (!isBefore(from)) return { kind: "refused", key, message: `Finding ${need.ref} comes from task ${from}, which this task does not depend on.` };
      const finding = briefs.get(from)?.findings.find((f) => f.id === need.ref);
      if (finding) return { kind: "provided", key, label: `finding ${finding.id}`, content: `${finding.id} ${finding.title}: ${finding.detail}` };
      return { kind: "route", key, taskId: from, question: `Your brief has no finding ${need.ref}. ${need.why || "Please give the detail the next task needs."}` };
    }
    const to = askTask(need.task);
    return to ? { kind: "route", key, taskId: to, question: need.ref } : { kind: "escalate", key, message: `Needs a finding no earlier task can give: ${need.ref}` };
  }

  if (need.kind === "decision") {
    const words = need.ref.toLowerCase().split(/[^a-z0-9åäöé]+/).filter((w) => w.length > 3);
    const known = [
      ...(plan.rules ?? []).map((r) => `Project rule: ${r}`),
      ...(task.handoff?.decisions ?? []).map((d) => `Decision for this task: ${d}`),
      ...before.flatMap((t) => [...(t.handoff?.decisions ?? []).map((d) => `Decision for task ${t.id}: ${d}`), ...(briefs.get(t.id)?.decisions ?? []).map((d) => `Decided in task ${t.id}: ${d}`)]),
    ];
    const hits = known.filter((k) => words.some((w) => k.toLowerCase().includes(w)));
    if (hits.length) return { kind: "provided", key, label: `the decisions about "${need.ref}"`, content: hits.slice(0, 6).join("\n") };
    return { kind: "escalate", key, message: `Needs a decision that is not in the plan: ${need.ref}${need.why ? ` (${need.why})` : ""}` };
  }

  const to = askTask(need.task);
  if (need.task && !isBefore(need.task)) return { kind: "refused", key, message: `Task ${need.task} is not an earlier task of this one, so it cannot be asked.` };
  return to ? { kind: "route", key, taskId: to, question: need.ref } : { kind: "escalate", key, message: `Has a question no earlier task can answer: ${need.ref}` };
}

const ANSWER = /<orqestra-answer>\s*([\s\S]*?)\s*<\/orqestra-answer>/;

// The question for an earlier task's agent: its own task and brief, and the one question. Not the
// asking task's files, and not anyone's transcript.
export function followUpPrompt(plan: Plan, from: PlanTask, brief: ReturnBrief | undefined, asker: PlanTask, question: string): string {
  return [
    `You did task ${from.id} (${from.title}, ${from.role}) in the project "${plan.goal}". Your task was: ${from.goal}`,
    brief ? `Your brief: ${brief.summary}${brief.findings.length ? `\nYour findings:\n${brief.findings.map((f) => `- ${f.id} ${f.title}: ${f.detail}`).join("\n")}` : ""}` : "",
    `Task ${asker.id} (${asker.title}, ${asker.role}) needs one detail from you to continue: ${question}`,
    "Answer only that, briefly and concretely, from what you know about your task. Do not write files. If you do not know, say so.",
    "End with exactly: <orqestra-answer>your answer</orqestra-answer>",
  ].filter(Boolean).join("\n\n");
}

export function parseAnswer(text: string): string | null {
  const match = ANSWER.exec(text);
  const answer = match?.[1]?.trim();
  return answer ? answer.slice(0, 2000) : null;
}
