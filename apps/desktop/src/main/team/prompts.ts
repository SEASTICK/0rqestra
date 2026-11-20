import type { Plan, PlanTask } from "./plan";
import { WEB_RULES } from "../providers/history";
import { attachmentHeader, handoffText, type ResolvedHandoff } from "./handoff";
import { answerFormat, claimsText, type ReturnBrief } from "./return-brief";

// What the agents are asked, and how their answers are read. Agents have no tools, so they hand over
// files as text in a fixed form, and the main process writes them.

export interface AgentRef {
  id: string;
  name: string;
  role: string;
}

// Every role gets the same handoff format (handoff.ts); what is in it depends on the job. A worker
// gets the requirements and the files it needs; a reviewer gets the requirements, the checks and
// the change. Instructions are short and said once (Stage 3): they are paid for on every call.
const fileBlocks = (files: { path: string; content: string }[]) => files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
// The web preview rules matter only for files a browser shows.
const isWeb = (task: PlanTask) => task.deliverables.some((d) => /\.(html?|css)$/i.test(d));

// A retry gets the specific problems and the version it submitted last, to fix rather than redo.
export function workerPrompt(plan: Plan, task: PlanTask, agent: AgentRef, resolved: ResolvedHandoff, problems: string[], current: { path: string; content: string }[] = []): string {
  const parts = [
    `You are ${agent.name}, the ${agent.role} in an AI team in the app 0rqestra. You do one task. Project goal: ${plan.goal}`,
    handoffText(plan, task, resolved),
  ];
  const mine = new Set(current.map((f) => f.path.toLowerCase()));
  const refs = resolved.attachments.filter((a) => !mine.has(a.path.toLowerCase()));
  if (refs.length) parts.push(refs.map((a) => `${attachmentHeader(a)}\n${a.content}`).join("\n\n"));
  if (problems.length) parts.push(`Your previous attempt was not approved. Fix these problems:\n${list(problems)}`);
  if (current.length) parts.push(`Your last submitted version (change only what the problems need):\n${fileBlocks(current)}`);
  parts.push(
    [
      "Work from this handoff only: do not redo research or reopen its decisions. You have no tools (you cannot open files or",
      "run commands, so do not try); ask for what is missing as shown below. Nothing is run. Answer with one",
      "sentence, then each listed file, complete, exactly as:",
      '<orqestra-file path="the/file.name">',
      "content",
      "</orqestra-file>",
      answerFormat(resolved.dependents),
      ...(isWeb(task) ? [WEB_RULES] : []),
    ].join("\n"),
  );
  return parts.join("\n\n");
}

export interface Change {
  path: string;
  content: string;
  // A unified diff against the version before this answer; null for a new file or a very long one.
  diff: string | null;
  isNew: boolean;
}

// Below this size a changed file is also shown whole, since the context around an edit is cheap.
export const FULL_FILE_CHARS = 1500;

// Reviewers read the acceptance criteria, the checks and the change first; the whole file only
// when it is new, short, or too long to compare.
export function changesText(changes: Change[]): string {
  return changes.map((c) => {
    if (c.isNew) return `--- ${c.path} (new file) ---\n${c.content}`;
    if (c.diff === null) return `--- ${c.path} (changed; too long to compare, whole file) ---\n${c.content}`;
    return c.content.length <= FULL_FILE_CHARS ? `${c.diff}\n\n--- ${c.path} (whole file after the change) ---\n${c.content}` : c.diff;
  }).join("\n\n");
}

// The files the author worked from, shown to the reviewer up to this size in total, so a review can
// check facts against their source instead of wanting to open it.
export const REVIEW_SOURCE_CHARS = 6000;

export function reviewPrompt(plan: Plan, task: PlanTask, reviewer: AgentRef, author: AgentRef, changes: Change[], resolved: ResolvedHandoff, checks: string[], authorBrief?: ReturnBrief): string {
  const claims = authorBrief ? claimsText(authorBrief) : "";
  const changed = new Set(changes.map((c) => c.path.toLowerCase()));
  const sources = resolved.attachments.filter((a) => !changed.has(a.path.toLowerCase()));
  const fits = sources.reduce((n, a) => n + a.content.length, 0) <= REVIEW_SOURCE_CHARS;
  return [
    `You are ${reviewer.name}, the ${reviewer.role} in an AI team in the app 0rqestra. Review another agent's work. Project goal: ${plan.goal}`,
    `${author.name} (${author.role}) did this task:`,
    handoffText(plan, task, resolved, true),
    `Verification results so far:\n${list(checks)}`,
    `Submitted changes (the latest version):\n${changesText(changes)}`,
    ...(sources.length && fits ? [`What the author worked from:\n${sources.map((a) => `${attachmentHeader(a)}\n${a.content}`).join("\n\n")}`] : []),
    ...(claims ? [`What the author says:\n${claims}`] : []),
    [
      // Without tools, a model that wants to open a file can write a tool call as text and stall
      // (seen with Claude Code, 2026-11-20). Say plainly that everything to check is here.
      "You have no tools: you cannot open files or run commands, so do not try. Judge only from this message; if something",
      "cannot be checked from it, say so in a problem instead.",
      "Check the change against each acceptance criterion, decision and rule; look for missing parts, placeholders and clear",
      "bugs. Approve work good enough for a first version; list only problems that must be fixed, each with the criterion or",
      "rule it breaks. End with exactly:",
      '<orqestra-review>{"approved": true, "problems": []}</orqestra-review>',
    ].join("\n"),
  ].join("\n\n");
}

const FILE = /<orqestra-file path="([^"]{1,200})">\r?\n?([\s\S]*?)\r?\n?<\/orqestra-file>/g;

export function parseFiles(text: string): { summary: string; files: { path: string; content: string }[] } {
  const files: { path: string; content: string }[] = [];
  for (const match of text.matchAll(FILE)) files.push({ path: match[1]!, content: match[2]! });
  const summary = text.replace(FILE, "").trim().split(/\r?\n/).find((l) => l.trim()) ?? "";
  return { summary: summary.slice(0, 400), files };
}

export function parseReview(text: string): { approved: boolean; problems: string[]; readable: boolean } {
  const match = /<orqestra-review>\s*([\s\S]*?)\s*<\/orqestra-review>\s*$/.exec(text.trim());
  if (!match) return { approved: false, problems: ["The review could not be read."], readable: false };
  try {
    const value = JSON.parse(match[1]!) as { approved?: unknown; problems?: unknown };
    const problems = Array.isArray(value.problems) ? value.problems.filter((p): p is string => typeof p === "string").map((p) => p.slice(0, 500)).slice(0, 12) : [];
    if (value.approved === true) return { approved: true, problems: [], readable: true };
    return { approved: false, problems: problems.length ? problems : ["The reviewer did not approve the work."], readable: true };
  } catch {
    return { approved: false, problems: ["The review could not be read."], readable: false };
  }
}

// Checks that an answer delivers exactly the files the task owns. Returns the problems, if any.
export function deliveryProblems(task: PlanTask, files: { path: string; content: string }[]): string[] {
  const problems: string[] = [];
  const wanted = new Map(task.deliverables.map((d) => [d.toLowerCase(), d]));
  const seen = new Set<string>();
  for (const f of files) {
    const key = f.path.replace(/\\/g, "/").toLowerCase();
    if (!wanted.has(key)) problems.push(`${f.path} was not asked for. Deliver only: ${task.deliverables.join(", ")}.`);
    else if (seen.has(key)) problems.push(`${f.path} was delivered twice.`);
    else if (!f.content.trim()) problems.push(`${f.path} is empty.`);
    seen.add(key);
  }
  for (const [key, name] of wanted) if (!seen.has(key)) problems.push(`${name} is missing.`);
  return problems;
}
