// A plan from the Manager: tasks for the roles in the tree, their order, and the files each one
// delivers. Everything here comes from a model and then from the window, so it is validated before
// anything runs.

export const MAX_TASKS = 8;
export const MAX_FILES_PER_TASK = 8;
export const REVIEW_ROLES = ["Code Reviewer", "Security Reviewer", "Reviewer", "Tester"];
const TASK_ID = /^[A-Za-z0-9_-]{1,24}$/;
const ROLE = /^[A-Za-z][A-Za-z ]{0,39}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export interface PlanTask {
  id: string;
  title: string;
  role: string;
  goal: string;
  dependsOn: string[];
  deliverables: string[];
  // The product this task builds (one of Plan.products), when it builds one.
  product?: string;
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

// A safe relative file path inside the project folder: plain segments, no "..", no absolute paths,
// no drive letters, no hidden files. Returns the normalised path or null.
export function safeRelativePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  const parts = value.replace(/\\/g, "/").split("/");
  if (parts.length > 6 || parts.some((p) => !SEGMENT.test(p) || p === "." || p === "..")) return null;
  return parts.join("/");
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

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
    const product = typeof t.product === "string" && t.product.trim() ? t.product.trim().toLowerCase() : null;
    if (product !== null && !productIds.has(product)) throw new Error(`Task ${id} builds the product ${product}, which the plan does not name.`);
    return { id, title, role, goal: taskGoal, dependsOn: dependsOn as string[], deliverables: deliverables as string[], ...(product ? { product } : {}) };
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
  return { goal, tasks, products };
}
