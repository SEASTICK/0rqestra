// A plan from the Manager: tasks for the roles in the tree, their order, and the files each one
// delivers. Everything here comes from a model and then from the window, so it is validated before
// anything runs.

export const MAX_TASKS = 8;
export const MAX_FILES_PER_TASK = 8;
export const REVIEW_ROLES = ["Code Reviewer", "Security Reviewer", "Reviewer", "Tester"];
const TASK_ID = /^[A-Za-z0-9_-]{1,24}$/;
const ROLE = /^[A-Za-z][A-Za-z ]{0,39}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

// What the agent doing a task is handed (Stage 1 of task-specific handoffs). The Manager (or the
// Planner) fills it in as part of the plan, with no extra model call; the runner resolves the
// references once the tasks they come from have finished.
export interface Reference {
  // A file: a dependency's deliverable, the task's own file, or a file already in the project.
  file?: string;
  // Or an earlier task whose result (summary and files) the agent needs.
  task?: string;
  why: string;
  // The whole file, when the job needs all of it; otherwise a short excerpt.
  full: boolean;
}

export interface Handoff {
  deliverable: string;
  decisions: string[];
  rules: string[];
  findings: string[];
  references: Reference[];
  acceptance: string[];
  verify: string;
}

export interface PlanTask {
  id: string;
  title: string;
  role: string;
  goal: string;
  dependsOn: string[];
  deliverables: string[];
  // Missing on plans made before handoffs existed; the runner then builds one from the task.
  handoff?: Handoff;
  // The product this task builds (one of Plan.products), when it builds one.
  product?: string;
  // A request the user gave one agent directly (see directPlan): the agent sees the project's files and
  // chooses which files to change, or only answers; `agentId` is that agent.
  open?: boolean;
  agentId?: string;
  // The agent the Manager (or Planner) chose for this task, by name, and in a few words why.
  agent?: string;
  why?: string;
}

// Something the user can see, such as a web page: it becomes a node in the tree as soon as the run starts.
export interface PlanProduct {
  id: string;
  name: string;
  folder: string;
}

export interface Plan {
  goal: string;
  tasks: PlanTask[];
  // Project rules every agent must follow.
  rules?: string[];
  products?: PlanProduct[];
}

export const MAX_PRODUCTS = 6;
const PRODUCT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

function parseProducts(value: unknown): PlanProduct[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PRODUCTS) throw new Error(`A plan can name at most ${MAX_PRODUCTS} products.`);
  const products = value.map((raw: unknown, index: number) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id.trim().toLowerCase() : "";
    const name = str(p.name, 60);
    const folder = p.folder === undefined || p.folder === null || p.folder === "" || p.folder === "." ? "" : safeRelativePath(p.folder);
    if (!PRODUCT_ID.test(id) || !name || folder === null) throw new Error(`Product ${index + 1} needs an id, a name and a plain folder name.`);
    return { id, name, folder };
  });
  if (new Set(products.map((p) => p.id)).size !== products.length) throw new Error("Two products have the same id.");
  if (new Set(products.map((p) => p.folder.toLowerCase())).size !== products.length) throw new Error("Two products use the same folder.");
  return products;
}

export const MAX_HANDOFF_ITEMS = 10;
export const MAX_REFERENCES = 8;

// A safe relative file path inside the project folder: plain segments, no "..", no absolute paths,
// no drive letters, no hidden files. Returns the normalised path or null.
export function safeRelativePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  const parts = value.replace(/\\/g, "/").split("/");
  if (parts.length > 6 || parts.some((p) => !SEGMENT.test(p) || p === "." || p === "..")) return null;
  return parts.join("/");
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

function list(v: unknown, what: string, max = 600): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_HANDOFF_ITEMS) throw new Error(`${what} must be a list of at most ${MAX_HANDOFF_ITEMS} items.`);
  return v.map((item) => {
    const text = str(item, max);
    if (!text) throw new Error(`${what} has an empty or too long item.`);
    return text;
  });
}

function parseHandoff(raw: unknown, id: string): Handoff | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Task ${id} has an unreadable handoff.`);
  const h = raw as Record<string, unknown>;
  const refs = h.references ?? [];
  if (!Array.isArray(refs) || refs.length > MAX_REFERENCES) throw new Error(`Task ${id} can refer to at most ${MAX_REFERENCES} files or tasks.`);
  const references = refs.map((r: unknown, i: number): Reference => {
    const v = (r ?? {}) as Record<string, unknown>;
    const why = str(v.why, 400) ?? "";
    if (v.task !== undefined) {
      if (typeof v.task !== "string" || !TASK_ID.test(v.task) || v.file !== undefined) throw new Error(`Task ${id}, reference ${i + 1}: refer to one task id or one file.`);
      return { task: v.task, why, full: v.full === true };
    }
    const file = safeRelativePath(v.file);
    if (!file) throw new Error(`Task ${id}, reference ${i + 1}: "${String(v.file ?? "")}" is not a plain relative file name in the project.`);
    return { file, why, full: v.full === true };
  });
  return {
    deliverable: str(h.deliverable, 600) ?? "",
    decisions: list(h.decisions, `Task ${id}'s decisions`),
    rules: list(h.rules, `Task ${id}'s rules`),
    findings: list(h.findings, `Task ${id}'s findings`, 2000),
    references,
    acceptance: list(h.acceptance, `Task ${id}'s acceptance criteria`),
    verify: str(h.verify, 600) ?? "",
  };
}

// The tasks a task depends on, directly or through others.
export function ancestors(plan: Plan, task: PlanTask): PlanTask[] {
  const seen = new Set<string>();
  const walk = (t: PlanTask) => {
    for (const d of t.dependsOn) {
      if (seen.has(d)) continue;
      seen.add(d);
      const dep = plan.tasks.find((x) => x.id === d);
      if (dep) walk(dep);
    }
  };
  walk(task);
  return plan.tasks.filter((t) => seen.has(t.id));
}

// Where a referenced file comes from: a task's deliverable (with the owning task), or the project.
export function fileOwner(plan: Plan, file: string): PlanTask | null {
  const key = file.toLowerCase();
  return plan.tasks.find((t) => t.deliverables.some((d) => d.toLowerCase() === key)) ?? null;
}

export function parsePlan(value: unknown, roles: string[]): Plan {
  if (!value || typeof value !== "object") throw new Error("The plan is not readable.");
  const v = value as Record<string, unknown>;
  const goal = str(v.goal, 1000);
  if (!goal) throw new Error("The plan has no goal.");
  if (!Array.isArray(v.tasks) || v.tasks.length < 1 || v.tasks.length > MAX_TASKS) throw new Error(`A plan needs 1 to ${MAX_TASKS} tasks.`);
  const products = parseProducts(v.products);
  const productIds = new Set(products.map((p) => p.id));
  const owners = new Map<string, string>();
  const tasks: PlanTask[] = v.tasks.map((raw: unknown, index: number) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const id = typeof t.id === "string" && TASK_ID.test(t.id) ? t.id : null;
    const title = str(t.title, 160);
    const role = typeof t.role === "string" && ROLE.test(t.role) ? t.role : null;
    const taskGoal = str(t.goal, 3000);
    if (!id || !title || !role || !taskGoal) throw new Error(`Task ${index + 1} is incomplete.`);
    if (!roles.includes(role)) throw new Error(`Task ${id} needs the role ${role}, which no agent in the tree has.`);
    const dependsOn = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    if (!dependsOn.every((d) => typeof d === "string" && TASK_ID.test(d))) throw new Error(`Task ${id} has an invalid dependency.`);
    const deliverables = Array.isArray(t.deliverables) ? t.deliverables.map(safeRelativePath) : [];
    if (deliverables.length < 1 || deliverables.length > MAX_FILES_PER_TASK || deliverables.some((d) => d === null)) {
      throw new Error(`Task ${id} must deliver 1 to ${MAX_FILES_PER_TASK} files with plain relative names.`);
    }
    for (const file of deliverables as string[]) {
      const key = file.toLowerCase();
      if (owners.has(key)) throw new Error(`${file} is delivered by both ${owners.get(key)} and ${id}.`);
      owners.set(key, id);
    }
    const handoff = parseHandoff(t.handoff, id);
    const product = typeof t.product === "string" && t.product.trim() ? t.product.trim().toLowerCase() : null;
    if (product !== null && !productIds.has(product)) throw new Error(`Task ${id} builds the product ${product}, which the plan does not name.`);
    const agent = str(t.agent, 48);
    const why = str(t.why, 160);
    return { id, title, role, goal: taskGoal, dependsOn: dependsOn as string[], deliverables: deliverables as string[], ...(agent ? { agent } : {}), ...(why ? { why } : {}), ...(product ? { product } : {}), ...(handoff ? { handoff } : {}) };
  });
  const ids = new Set(tasks.map((t) => t.id));
  if (ids.size !== tasks.length) throw new Error("Two tasks have the same id.");
  for (const t of tasks) {
    for (const d of t.dependsOn) if (!ids.has(d) || d === t.id) throw new Error(`Task ${t.id} depends on ${d}, which is not another task in the plan.`);
  }
  // No cycles: repeatedly take tasks whose dependencies are all taken.
  const done = new Set<string>();
  while (done.size < tasks.length) {
    const next = tasks.filter((t) => !done.has(t.id) && t.dependsOn.every((d) => done.has(d)));
    if (!next.length) throw new Error("The tasks depend on each other in a circle.");
    for (const t of next) done.add(t.id);
  }
  const rules = list(v.rules, "The plan's rules", 400);
  const plan: Plan = { goal, tasks, products, ...(rules.length ? { rules } : {}) };
  // References stay inside the task's scope: an earlier task it depends on, its own files, or a file
  // already in the project (checked against the folder before the run starts).
  for (const t of tasks) {
    const before = new Set(ancestors(plan, t).map((a) => a.id));
    for (const ref of t.handoff?.references ?? []) {
      if (ref.task) {
        if (!before.has(ref.task)) throw new Error(`Task ${t.id} refers to task ${ref.task}, which it does not depend on.`);
        continue;
      }
      const owner = fileOwner(plan, ref.file!);
      if (owner && owner.id !== t.id && !before.has(owner.id)) {
        throw new Error(`Task ${t.id} refers to ${ref.file}, which task ${owner.id} delivers, but ${t.id} does not depend on ${owner.id}.`);
      }
    }
  }
  return plan;
}

// Files a plan refers to that must already be in the project folder (no task delivers them), and
// that are not there. Checked before anything starts, so nothing is launched without them.
export function missingProjectFiles(plan: Plan, existing: string[]): { taskId: string; file: string }[] {
  const have = new Set(existing.map((f) => f.toLowerCase()));
  const missing: { taskId: string; file: string }[] = [];
  for (const t of plan.tasks) {
    for (const ref of t.handoff?.references ?? []) {
      if (ref.file && !fileOwner(plan, ref.file) && !have.has(ref.file.toLowerCase())) missing.push({ taskId: t.id, file: ref.file });
    }
  }
  return missing;
}

export const MAX_DIRECT_CHARS = 4000;
export const MAX_OPEN_FILES = 8;

// A one-task plan for a request the user gave one agent directly, from the agent's panel in the tree.
export function directPlan(request: unknown, agent: { id: string; name: string; role: string }): Plan {
  const text = str(request, MAX_DIRECT_CHARS);
  if (!text) throw new Error(`Write what ${agent.name} should do (at most ${MAX_DIRECT_CHARS} characters).`);
  const short = text.replace(/\s+/g, " ");
  return {
    goal: short.length > 160 ? `${short.slice(0, 157)}…` : short,
    tasks: [{ id: "t1", title: short.length > 80 ? `${short.slice(0, 77)}…` : short, role: agent.role, goal: text, dependsOn: [], deliverables: [], open: true, agentId: agent.id }],
    products: [],
  };
}
