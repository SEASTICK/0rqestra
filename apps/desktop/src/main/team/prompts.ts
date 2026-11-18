import type { Plan, PlanTask } from "./plan";
import { WEB_RULES } from "../providers/history";

// What the agents are asked, and how their answers are read. Agents have no tools, so they hand over
// files as text in a fixed form, and the main process writes them.

export interface AgentRef {
  id: string;
  name: string;
  role: string;
}

export function workerPrompt(plan: Plan, task: PlanTask, agent: AgentRef, context: { path: string; content: string }[], problems: string[]): string {
  const parts = [
    `You are ${agent.name}, the ${agent.role} in a team of AI agents led by a Manager in the app 0rqestra. You do one task.`,
    `Project goal: ${plan.goal}`,
    `Your task (${task.id}): ${task.title}`,
    `What to do: ${task.goal}`,
    `Deliver exactly these files: ${task.deliverables.join(", ")}`,
  ];
  if (context.length) {
    parts.push(`Files from earlier tasks you can build on:\n${context.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n")}`);
  }
  if (problems.length) {
    parts.push(`Your previous attempt was not approved. Fix these problems:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
  parts.push(
    [
      "You cannot run tools or commands, and nothing you write is executed now. Write the complete content of every file.",
      "Answer with one short sentence about what you did, then every file in exactly this form:",
      '<orqestra-file path="the/file.name">',
      "the complete file content",
      "</orqestra-file>",
      "Use exactly the file names listed above, and no other files.",
      WEB_RULES,
    ].join("\n"),
  );
  return parts.join("\n\n");
}

export function reviewPrompt(plan: Plan, task: PlanTask, reviewer: AgentRef, author: AgentRef, files: { path: string; content: string }[]): string {
  return [
    `You are ${reviewer.name}, the ${reviewer.role} in a team of AI agents in the app 0rqestra. Review another agent's work.`,
    `Project goal: ${plan.goal}`,
    `Task (${task.id}) done by ${author.name} (${author.role}): ${task.title}`,
    `What was asked: ${task.goal}`,
    `Files delivered:\n${files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n")}`,
    [
      "Check that the files do what was asked, are complete (no placeholders or missing parts), and have no clear bugs.",
      "Approve work that is good enough for a first version; list only problems that must be fixed.",
      "End your answer with exactly this, with nothing after it:",
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
