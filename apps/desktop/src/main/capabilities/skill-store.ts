import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Skills on this computer: imported copies in 0rqestra's app data, and which agent has which skill.
// A skill is a SKILL.md (instructions with a short name and description) and, from a folder, the
// files next to it. The copy is the app's own, so it keeps working when the original is moved or
// deleted. Assignments are kept per agent under the agent's permanent key (not its name and not a
// project), so an agent keeps its skills when renamed, after a restart, and in every project it is
// added to. No credentials are stored here.

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  // Where it was imported from (a file or folder name), for the user.
  source: string;
  files: number;
  importedAt: string;
}

export interface SkillPreview {
  selectionId: string;
  name: string;
  description: string;
  excerpt: string;
  source: string;
  files: string[];
  // Set when a skill with this name is already on this computer (installing reuses or updates it).
  existingId: string | null;
}

interface Staged { name: string; description: string; markdown: string; source: string; files: { rel: string; data: Buffer }[]; at: number }
interface AssignmentFile { agents: Record<string, { name: string; skills: string[] }> }

export const AGENT_KEY = /^[A-Za-z0-9:_-]{1,100}$/;
export const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_MD = 100_000;
const MAX_FILES = 50;
const MAX_FOLDER_BYTES = 2_000_000;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,99}$/;
const STAGE_TTL_MS = 30 * 60_000;

// Reads the front matter (name, description) of a SKILL.md, as Claude Code and Codex skills write it.
export function parseSkill(markdown: string, fallbackName: string): { name: string; description: string; body: string } {
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const meta: Record<string, string> = {};
  if (front) {
    for (const line of front[1]!.split("\n")) {
      const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (m) meta[m[1]!.toLowerCase()] = m[2]!.replace(/^["']|["']$/g, "").trim();
    }
  }
  const body = (front ? text.slice(front[0].length) : text).trim();
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const firstParagraph = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#")) ?? "";
  const name = (meta.name || heading || fallbackName).slice(0, 80);
  const description = (meta.description || firstParagraph).replace(/\s+/g, " ").slice(0, 400);
  return { name, description, body };
}

export function skillIdFor(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "skill";
}

export class SkillStore {
  private staged = new Map<string, Staged>();

  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {}

  private get skillsDir(): string { return path.join(this.dir, "skills"); }
  private readJson<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as T;
    } catch {
      return fallback;
    }
  }
  private writeJson(file: string, value: unknown): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = path.join(this.dir, file);
    const tmp = `${target}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, target);
  }

  list(): SkillRecord[] {
    return this.readJson<SkillRecord[]>("skills.json", []).filter((s) => SKILL_ID.test(s.id));
  }

  get(id: string): { record: SkillRecord; instructions: string } | null {
    if (!SKILL_ID.test(id)) return null;
    const record = this.list().find((s) => s.id === id);
    if (!record) return null;
    try {
      const markdown = fs.readFileSync(path.join(this.skillsDir, id, "SKILL.md"), "utf8");
      return { record, instructions: parseSkill(markdown, record.name).body };
    } catch {
      return null;
    }
  }

  // ---- Importing: stage (preview), then install (copy) -------------------------------------

  private stage(s: Omit<Staged, "at">): SkillPreview {
    for (const [k, v] of this.staged) if (this.now() - v.at > STAGE_TTL_MS) this.staged.delete(k);
    const selectionId = crypto.randomUUID();
    this.staged.set(selectionId, { ...s, at: this.now() });
    const existing = this.list().find((r) => r.name.toLowerCase() === s.name.toLowerCase());
    return { selectionId, name: s.name, description: s.description, excerpt: parseSkill(s.markdown, s.name).body.slice(0, 1200), source: s.source, files: s.files.map((f) => f.rel), existingId: existing?.id ?? null };
  }

  // A SKILL.md given as text (dropped on the window).
  stageText(fileName: string, text: string): SkillPreview {
    if (typeof text !== "string" || !text.trim()) throw new Error("That file is empty.");
    if (text.length > MAX_SKILL_MD) throw new Error("A SKILL.md can be at most 100 KB.");
    const source = path.basename(String(fileName || "SKILL.md")).slice(0, 100);
    const parsed = parseSkill(text, source.replace(/\.md$/i, ""));
    return this.stage({ name: parsed.name, description: parsed.description, markdown: text, source, files: [{ rel: "SKILL.md", data: Buffer.from(text, "utf8") }] });
  }

  // A file or folder the user chose in the system dialog.
  stagePath(chosen: string): SkillPreview {
    const stat = fs.lstatSync(chosen);
    if (stat.isSymbolicLink()) throw new Error("Choose the skill itself, not a link to it.");
    if (stat.isFile()) {
      if (stat.size > MAX_SKILL_MD) throw new Error("A SKILL.md can be at most 100 KB.");
      return this.stageText(path.basename(chosen), fs.readFileSync(chosen, "utf8"));
    }
    if (!stat.isDirectory()) throw new Error("Choose a SKILL.md file or a skill folder.");
    const files: { rel: string; data: Buffer }[] = [];
    let bytes = 0;
    const walk = (dir: string, prefix: string, depth: number) => {
      if (depth > 4) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith(".") || e.isSymbolicLink() || !SEGMENT.test(e.name)) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel, depth + 1);
        else if (e.isFile()) {
          const data = fs.readFileSync(path.join(dir, e.name));
          bytes += data.length;
          if (files.length >= MAX_FILES || bytes > MAX_FOLDER_BYTES) throw new Error(`A skill folder can have at most ${MAX_FILES} files and 2 MB.`);
          files.push({ rel, data });
        }
      }
    };
    walk(chosen, "", 0);
    const main = files.find((f) => f.rel.toLowerCase() === "skill.md");
    if (!main) throw new Error("That folder has no SKILL.md at its top level.");
    const markdown = main.data.toString("utf8");
    if (markdown.length > MAX_SKILL_MD) throw new Error("A SKILL.md can be at most 100 KB.");
    const parsed = parseSkill(markdown, path.basename(chosen));
    return this.stage({ name: parsed.name, description: parsed.description, markdown, source: path.basename(chosen), files: files.map((f) => (f === main ? { rel: "SKILL.md", data: f.data } : f)) });
  }

  // Copies a staged skill into the app's own folder. Re-importing a skill with the same name
  // updates that copy (agents that have it keep it).
  install(selectionId: unknown): SkillRecord {
    const s = typeof selectionId === "string" ? this.staged.get(selectionId) : undefined;
    if (!s) throw new Error("Choose the skill again.");
    const all = this.list();
    const existing = all.find((r) => r.name.toLowerCase() === s.name.toLowerCase());
    let id = existing?.id ?? skillIdFor(s.name);
    if (!existing) for (let n = 2; all.some((r) => r.id === id); n += 1) id = `${skillIdFor(s.name).slice(0, 44)}-${n}`;
    const target = path.join(this.skillsDir, id);
    const tmp = `${target}.${crypto.randomUUID()}.tmp`;
    for (const f of s.files) {
      const out = path.join(tmp, ...f.rel.split("/"));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, f.data);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);
    const record: SkillRecord = { id, name: s.name, description: s.description, source: s.source, files: s.files.length, importedAt: new Date(this.now()).toISOString() };
    this.writeJson("skills.json", [...all.filter((r) => r.id !== id), record]);
    this.staged.delete(selectionId as string);
    return record;
  }

  // ---- Assignments, per agent --------------------------------------------------------------

  private assignments(): AssignmentFile {
    const a = this.readJson<AssignmentFile>("assignments.json", { agents: {} });
    return a && typeof a.agents === "object" ? a : { agents: {} };
  }

  installedOn(agentKey: string): string[] {
    if (!AGENT_KEY.test(agentKey)) return [];
    const known = new Set(this.list().map((s) => s.id));
    return (this.assignments().agents[agentKey]?.skills ?? []).filter((id) => known.has(id));
  }

  assign(agentKey: unknown, skillId: unknown, agentName: unknown): string[] {
    if (typeof agentKey !== "string" || !AGENT_KEY.test(agentKey)) throw new Error("Unknown agent.");
    if (typeof skillId !== "string" || !this.list().some((s) => s.id === skillId)) throw new Error("Unknown skill.");
    const a = this.assignments();
    const current = a.agents[agentKey] ?? { name: "", skills: [] };
    a.agents[agentKey] = { name: typeof agentName === "string" ? agentName.slice(0, 48) : current.name, skills: [...new Set([...current.skills, skillId])] };
    this.writeJson("assignments.json", a);
    return this.installedOn(agentKey);
  }

  // Removes a skill from one agent only; other agents and the skill itself stay.
  unassign(agentKey: unknown, skillId: unknown): string[] {
    if (typeof agentKey !== "string" || !AGENT_KEY.test(agentKey)) throw new Error("Unknown agent.");
    const a = this.assignments();
    const current = a.agents[agentKey];
    if (current) {
      a.agents[agentKey] = { ...current, skills: current.skills.filter((s) => s !== skillId) };
      this.writeJson("assignments.json", a);
    }
    return this.installedOn(agentKey);
  }

  // What an agent may use in a project: its installed skills plus the project's skills that are on
  // for it. Unknown ids are dropped.
  allowedFor(agentKey: string | undefined, projectSkills: string[] = []): SkillRecord[] {
    const ids = new Set([...(agentKey ? this.installedOn(agentKey) : []), ...projectSkills]);
    return this.list().filter((s) => ids.has(s.id));
  }
}
