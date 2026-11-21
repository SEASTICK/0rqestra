import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AccessDenied, liveRoot, relativeParts, resolveForRead } from "./paths";

// Computer access, per project, kept on this computer only (userData/access/access.json; never sent
// to Teams or anywhere else). A project has folders the user granted, with whether agents may write
// there; each agent (by its permanent key) has its own permissions in that project; and the project
// has commands the user approved, each with its working folder. Nothing is allowed by default.
// The file is read again on every check, so a revoke takes effect at once, also during a run.

export interface FolderGrant { id: string; path: string; write: boolean; addedAt: string }
export interface AgentAccess { read: boolean; write: boolean; commands: boolean }
export interface ApprovedCommand { id: string; label: string; command: string; folderId: string; cwd: string; approvedAt: string }
interface ProjectAccess { folders: FolderGrant[]; agents: Record<string, AgentAccess>; commands: ApprovedCommand[] }
interface AccessFile { version: 1; projects: Record<string, ProjectAccess> }

export const NO_ACCESS: AgentAccess = { read: false, write: false, commands: false };
const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const AGENT_KEY = /^[A-Za-z0-9_:.-]{1,160}$/;
const MAX_FOLDERS = 20;
const MAX_COMMANDS = 20;

export interface AccessView {
  folders: (FolderGrant & { available: boolean; problem: string | null })[];
  agents: Record<string, AgentAccess>;
  commands: (ApprovedCommand & { folderPath: string; cwdPath: string })[];
}

export class AccessStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "access", "access.json");
  }

  private read(): AccessFile {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8")) as AccessFile;
      if (v && v.version === 1 && v.projects && typeof v.projects === "object") return v;
    } catch {
      // No access granted yet (or an unreadable file: then nothing is allowed).
    }
    return { version: 1, projects: {} };
  }

  private write(data: AccessFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(temp, this.file);
  }

  private change(projectId: string, fn: (p: ProjectAccess) => void): AccessView {
    checkProject(projectId);
    const data = this.read();
    const p = data.projects[projectId] ?? { folders: [], agents: {}, commands: [] };
    fn(p);
    data.projects[projectId] = p;
    this.write(data);
    return this.view(projectId);
  }

  project(projectId: string): ProjectAccess {
    checkProject(projectId);
    return this.read().projects[projectId] ?? { folders: [], agents: {}, commands: [] };
  }

  view(projectId: string): AccessView {
    const p = this.project(projectId);
    const folderPath = (id: string) => p.folders.find((f) => f.id === id)?.path ?? "";
    return {
      folders: p.folders.map((f) => {
        try {
          liveRoot(f.path);
          return { ...f, available: true, problem: null };
        } catch (error) {
          return { ...f, available: false, problem: (error as Error).message };
        }
      }),
      agents: { ...p.agents },
      commands: p.commands.map((c) => ({ ...c, folderPath: folderPath(c.folderId), cwdPath: c.cwd ? path.join(folderPath(c.folderId), ...c.cwd.split("/")) : folderPath(c.folderId) })),
    };
  }

  // A folder the user chose in the system's folder picker. Granted read-only.
  addFolder(projectId: string, chosen: string): AccessView {
    if (typeof chosen !== "string" || !path.isAbsolute(chosen)) throw new Error("Choose a folder.");
    let real: string;
    try {
      real = fs.realpathSync.native(chosen);
    } catch {
      throw new Error("That folder does not exist.");
    }
    if (!fs.statSync(real).isDirectory()) throw new Error("Choose a folder, not a file.");
    if (path.parse(real).root.toLowerCase() === real.toLowerCase() || path.parse(real).root.toLowerCase() === `${real.toLowerCase()}\\`) throw new Error("A whole drive cannot be granted. Choose the project's folder.");
    return this.change(projectId, (p) => {
      if (p.folders.some((f) => f.path.toLowerCase() === real.toLowerCase())) return;
      if (p.folders.length >= MAX_FOLDERS) throw new Error(`At most ${MAX_FOLDERS} folders per project.`);
      p.folders.push({ id: newId("f"), path: real, write: false, addedAt: new Date().toISOString() });
    });
  }

  setFolderWrite(projectId: string, folderId: unknown, write: unknown): AccessView {
    return this.change(projectId, (p) => {
      const f = p.folders.find((x) => x.id === folderId);
      if (!f) throw new Error("Unknown folder.");
      f.write = write === true;
    });
  }

  revokeFolder(projectId: string, folderId: unknown): AccessView {
    return this.change(projectId, (p) => {
      p.folders = p.folders.filter((f) => f.id !== folderId);
      p.commands = p.commands.filter((c) => c.folderId !== folderId);
    });
  }

  setAgent(projectId: string, agentKey: unknown, raw: unknown): AccessView {
    if (typeof agentKey !== "string" || !AGENT_KEY.test(agentKey)) throw new Error("Unknown agent.");
    const v = (raw ?? {}) as Record<string, unknown>;
    return this.change(projectId, (p) => {
      const next = { read: v.read === true, write: v.write === true, commands: v.commands === true };
      // Writing and running checks need reading.
      if (next.write || next.commands) next.read = true;
      if (!next.read && !next.write && !next.commands) delete p.agents[agentKey];
      else p.agents[agentKey] = next;
    });
  }

  // "Revoke all": every agent loses access in this project; the folders stay listed.
  revokeAgents(projectId: string): AccessView {
    return this.change(projectId, (p) => {
      p.agents = {};
    });
  }

  // A command the user approves, after seeing the command and the folder it runs in.
  addCommand(projectId: string, raw: unknown): AccessView {
    const v = (raw ?? {}) as Record<string, unknown>;
    const label = typeof v.label === "string" ? v.label.trim().slice(0, 40) : "";
    const command = typeof v.command === "string" ? v.command.trim() : "";
    const cwd = typeof v.cwd === "string" ? v.cwd.trim() : "";
    if (!label) throw new Error("Give the command a name, such as Tests.");
    if (!command || command.length > 300 || [...command].some((c) => c.charCodeAt(0) < 32)) throw new Error("Enter the command on one line (at most 300 characters).");
    const parts = relativeParts(cwd);
    if (!parts) throw new Error("The working folder must be inside the granted folder.");
    return this.change(projectId, (p) => {
      const folder = p.folders.find((f) => f.id === v.folderId);
      if (!folder) throw new Error("Choose a granted folder for the command.");
      const real = resolveForRead(folder.path, parts.join("/"));
      if (!fs.statSync(real).isDirectory()) throw new Error("The working folder must be a folder.");
      if (p.commands.length >= MAX_COMMANDS) throw new Error(`At most ${MAX_COMMANDS} commands per project.`);
      p.commands.push({ id: newId("c"), label, command, folderId: folder.id, cwd: parts.join("/"), approvedAt: new Date().toISOString() });
    });
  }

  removeCommand(projectId: string, commandId: unknown): AccessView {
    return this.change(projectId, (p) => {
      p.commands = p.commands.filter((c) => c.id !== commandId);
    });
  }

  // The project was removed from 0rqestra: its computer access goes with it.
  forgetProject(projectId: string): void {
    checkProject(projectId);
    const data = this.read();
    if (!data.projects[projectId]) return;
    delete data.projects[projectId];
    this.write(data);
  }

  // What an agent may do in a project, now.
  agent(projectId: string, agentKey: string | undefined): AgentAccess {
    if (!agentKey) return NO_ACCESS;
    return this.project(projectId).agents[agentKey] ?? NO_ACCESS;
  }
}

function checkProject(projectId: string): void {
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) throw new AccessDenied("Unknown project.");
}

function newId(prefix: string): string {
  return `${prefix}${crypto.randomBytes(5).toString("hex")}`;
}
