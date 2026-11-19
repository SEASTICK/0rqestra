// Stage 2 of task-specific handoffs: what an agent hands back, and how it asks for something it is
// missing. Both are short JSON blocks at the end of the agent's answer. The runner checks them: it
// adds what it observed itself (labelled "runner") and marks the agent's own claims as
// "agent-reported", since nothing an agent says it ran was seen by the app.

export interface Finding {
  id: string;
  title: string;
  detail: string;
  // The tasks this finding matters for, or ["all"].
  for: string[];
}

export interface Verified {
  text: string;
  source: "runner" | "agent-reported";
}

export interface ReturnBrief {
  taskId: string;
  summary: string;
  decisions: string[];
  findings: Finding[];
  // Deliverables and other evidence, by reference (file paths or short notes).
  evidence: string[];
  verified: Verified[];
  unresolved: string[];
  // False when the agent gave no brief; the runner then built one from what it observed.
  given: boolean;
}

export type NeedKind = "file" | "finding" | "decision" | "question";

export interface ContextNeed {
  kind: NeedKind;
  // A file path, a finding id (t1.f2), or the decision or question in a few words.
  ref: string;
  // For a question: the earlier task that should answer it.
  task: string | null;
  why: string;
}

const MAX_ITEMS = 10;
const BRIEF = /<orqestra-brief>\s*([\s\S]*?)\s*<\/orqestra-brief>/;
const NEED = /<orqestra-need>\s*([\s\S]*?)\s*<\/orqestra-need>/;
const TASK_ID = /^[A-Za-z0-9_-]{1,24}$/;

function oneLine(value: unknown, max: number): string {
  const s = typeof value === "string" ? value : "";
  const clean = [...s].map((c) => (c.charCodeAt(0) < 32 ? " " : c)).join("").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function texts(value: unknown, max = 400): string[] {
  return Array.isArray(value) ? value.map((v) => oneLine(v, max)).filter(Boolean).slice(0, MAX_ITEMS) : [];
}

// The brief at the end of a worker's answer, or null when there is none (or it cannot be read).
export function parseBrief(text: string, taskId: string, taskIds: string[]): Omit<ReturnBrief, "given"> | null {
  const match = BRIEF.exec(text);
  if (!match) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const rawFindings = Array.isArray(value.findings) ? value.findings.slice(0, MAX_ITEMS) : [];
  const findings: Finding[] = rawFindings.map((f: unknown, i: number) => {
    const v = (typeof f === "string" ? { title: f } : f ?? {}) as Record<string, unknown>;
    const title = oneLine(v.title ?? v.detail, 160);
    const forTasks = Array.isArray(v.for) ? v.for.filter((t): t is string => typeof t === "string" && (t === "all" || taskIds.includes(t))) : [];
    return { id: `${taskId}.f${i + 1}`, title, detail: oneLine(v.detail ?? v.title, 1500), for: forTasks.length ? forTasks : ["all"] };
  }).filter((f) => f.title);
  return {
    taskId,
    summary: oneLine(value.summary, 400),
    decisions: texts(value.decisions),
    findings,
    evidence: texts(value.evidence, 200),
    verified: texts(value.verified).map((t) => ({ text: t, source: "agent-reported" as const })),
    unresolved: texts(value.unresolved),
  };
}

// Requests for missing context, or an empty list. A request replaces the files in that answer.
export function parseNeeds(text: string): ContextNeed[] {
  const match = NEED.exec(text);
  if (!match) return [];
  let value: unknown;
  try {
    value = JSON.parse(match[1]!);
  } catch {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  return list.slice(0, 3).map((v: unknown) => {
    const n = (v ?? {}) as Record<string, unknown>;
    const kind = (["file", "finding", "decision", "question"] as const).find((k) => k === n.kind) ?? "question";
    return { kind, ref: oneLine(n.ref, 300), task: typeof n.task === "string" && TASK_ID.test(n.task) ? n.task : null, why: oneLine(n.why, 300) };
  }).filter((n) => n.ref);
}

// The brief the runner keeps: the agent's own (claims labelled agent-reported) plus what the
// runner saw itself. Without a brief from the agent, it is built from the runner's observations.
export function completeBrief(parsed: Omit<ReturnBrief, "given"> | null, taskId: string, fallbackSummary: string, deliverables: string[], observed: string[]): ReturnBrief {
  const base = parsed ?? { taskId, summary: fallbackSummary, decisions: [], findings: [], evidence: [], verified: [], unresolved: [] };
  const evidence = [...new Set([...deliverables, ...base.evidence])].slice(0, MAX_ITEMS + deliverables.length);
  return {
    ...base,
    summary: base.summary || fallbackSummary,
    evidence,
    verified: [...observed.map((text) => ({ text, source: "runner" as const })), ...base.verified],
    given: parsed !== null,
  };
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

// A brief for a reader: the Manager, a downstream task, or a reviewer. `onlyFor` keeps the findings
// that matter for one task and lists the others by id, so they can be asked for.
export function briefText(brief: ReturnBrief, label: string, onlyFor: string | null = null): string {
  const relevant = onlyFor ? brief.findings.filter((f) => f.for.includes("all") || f.for.includes(onlyFor)) : brief.findings;
  const others = onlyFor ? brief.findings.filter((f) => !relevant.includes(f)) : [];
  const parts = [`${label}: ${brief.summary}`];
  if (brief.decisions.length) parts.push(`Decisions:\n${bullets(brief.decisions)}`);
  if (relevant.length) parts.push(`Findings:\n${bullets(relevant.map((f) => `${f.id} ${f.title}${f.detail && f.detail !== f.title ? `: ${f.detail}` : ""}`))}`);
  if (others.length) parts.push(`Other findings you can ask for by id: ${others.map((f) => `${f.id} (${f.title})`).join("; ")}`);
  if (brief.evidence.length) parts.push(`Evidence: ${brief.evidence.join(", ")}`);
  if (brief.verified.length) parts.push(`Verified:\n${bullets(brief.verified.map((v) => `${v.text} [${v.source === "runner" ? "checked by the app" : "agent-reported, not checked by the app"}]`))}`);
  if (brief.unresolved.length) parts.push(`Unresolved:\n${bullets(brief.unresolved)}`);
  if (!brief.given) parts.push("(The agent gave no brief; this one is built from what the app observed.)");
  return parts.join("\n");
}

// How every worker answers, including the brief and how to ask for missing context.
export function answerFormat(dependents: { id: string; title: string }[]): string {
  return [
    "End your answer with a short brief for the Manager and the tasks after yours, exactly in this form:",
    '<orqestra-brief>{"summary": "One or two sentences on the outcome.", "decisions": ["Choices you made that others must follow"], ' +
      '"findings": [{"title": "A short name", "detail": "The fact, briefly", "for": ["t2"]}], "evidence": ["files or notes that back it up"], ' +
      '"verified": ["What you checked and how"], "unresolved": ["Anything still open"]}</orqestra-brief>',
    dependents.length
      ? `Tasks that use your result: ${dependents.map((d) => `${d.id} (${d.title})`).join(", ")}. Tag each finding with the ids it matters for, or "all".`
      : 'Tag each finding with "all".',
    "If you cannot do the task without something you were not given, do not guess and do not deliver files. Ask instead, with",
    "nothing after it (at most 3 requests):",
    '<orqestra-need>[{"kind": "file", "ref": "path/of/the.file", "why": "..."}, {"kind": "finding", "ref": "t1.f3", "why": "..."}, ' +
      '{"kind": "decision", "ref": "the decision you need", "why": "..."}, {"kind": "question", "task": "t1", "ref": "your question", "why": "..."}]</orqestra-need>',
    "Ask only for what this task needs. You get it in the next message; a request cannot give you access to more files.",
  ].join("\n");
}
