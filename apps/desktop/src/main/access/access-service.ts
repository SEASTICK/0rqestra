import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { unifiedDiff } from "../team/diff";
import { readFiles } from "../team/workspace";
import { AccessStore, type AgentAccess } from "./access-store";
import { AccessDenied, liveRoot, resolveForRead, writeInside } from "./paths";
import { folderOutline } from "./folder-info";
import { gitCommit, gitPush, gitState, insideGitFolder, type GitRunner, type GitState } from "./git";

// The boundary where agents touch this computer. Agents never get the folders themselves: they ask
// (a need in their answer), and this service checks the agent's permission in the project and the
// real path on disk at that moment, then reads, lists or runs an approved command. Files an agent
// delivers land in the app's project workspace as before; they reach a granted folder only through
// apply, after the user saw the diff, with the author's write permission checked again then.

export interface ComputerGate {
  // What the agent may use, for its prompt; null when it has no access in this project.
  describe(agentKey: string | undefined): string | null;
  read(agentKey: string | undefined, agentName: string, ref: string): { ok: true; label: string; content: string } | { ok: false; message: string };
  check(agentKey: string | undefined, agentName: string, commandId: string): Promise<{ ok: true; label: string; content: string } | { ok: false; message: string }>;
  // Files a task delivered to the workspace, which the user may later apply to a granted folder.
  delivered(taskId: string, agentKey: string | undefined, agentName: string, paths: string[]): void;
}

export interface AccessEvent { projectId: string; at: string; agent: string; action: "read" | "list" | "check" | "apply" | "commit" | "push"; target: string; allowed: boolean; detail: string }

interface PendingFile { path: string; agentKey: string | undefined; agentName: string; taskId: string; runId: string }
interface Preview { id: string; projectId: string; folderId: string; at: number; items: Map<string, { hash: string | null; content: string; pending: PendingFile }> }

const READ_CHARS = 40_000;
const LIST_MAX = 200;
const OUTPUT_CHARS = 20_000;
const CHECK_TIMEOUT_MS = 10 * 60_000;
// Credentials stay out of commands agents start: variables that look like keys or tokens are dropped.
const SECRET_ENV = /(key|token|secret|password|passwd|credential|auth|cookie|session)/i;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export class AccessService {
  private readonly pending = new Map<string, Map<string, PendingFile>>();
  private readonly previews = new Map<string, Preview>();
  private readonly log = new Map<string, AccessEvent[]>();

  constructor(
    readonly store: AccessStore,
    private readonly workspaceFor: (projectId: string) => string,
    private readonly onEvent: (event: AccessEvent) => void = () => {},
    // Teams: a teammate's active reservation covering one of these paths, as a message; else null.
    private readonly reservedByOthers: (projectId: string, paths: string[]) => string | null = () => null,
    private readonly git: GitRunner | null = null,
    // Where files waiting to be applied are kept, so they survive a restart (null: memory only).
    private readonly pendingFile: string | null = null,
  ) {
    this.loadPending();
  }

  private loadPending(): void {
    if (!this.pendingFile) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.pendingFile, "utf8")) as Record<string, PendingFile[]>;
      for (const [projectId, files] of Object.entries(saved)) {
        if (!Array.isArray(files)) continue;
        const map = new Map<string, PendingFile>();
        for (const f of files) if (f && typeof f.path === "string" && typeof f.taskId === "string") map.set(f.path.toLowerCase(), { path: f.path, agentKey: typeof f.agentKey === "string" ? f.agentKey : undefined, agentName: String(f.agentName ?? "Agent"), taskId: f.taskId, runId: String(f.runId ?? "") });
        if (map.size) this.pending.set(projectId, map);
      }
    } catch {
      /* nothing saved yet */
    }
  }

  private savePending(): void {
    if (!this.pendingFile) return;
    try {
      fs.mkdirSync(path.dirname(this.pendingFile), { recursive: true });
      fs.writeFileSync(this.pendingFile, JSON.stringify(Object.fromEntries([...this.pending].filter(([, m]) => m.size).map(([id, m]) => [id, [...m.values()]]))));
    } catch {
      /* kept in memory for this run */
    }
  }

  // For the Manager and the Planner: the folders this project works on, with their files' names, so a
  // plan names real paths. Agents read the contents themselves, through their own access.
  overview(projectId: string): string | null {
    const folders = this.store.project(projectId).folders;
    const lines: string[] = [];
    for (const f of folders) {
      let root: string;
      try {
        root = liveRoot(f.path);
      } catch {
        continue;
      }
      lines.push(`Folder ${f.id}: ${f.path}${f.write ? " (changes are applied there after the user reviews them)" : " (read only)"}`, ...folderOutline(root).map((l) => `  ${l}`));
    }
    if (!lines.length) return null;
    return [
      "## The code this project works on (folders the user granted on this computer)",
      "This project improves existing code. Plan tasks against these real files and folders, by their paths inside the folder. The agents read the files themselves through their computer access; deliver changed or new files with the same paths, and the user reviews each change before it reaches the folder. Keep each task small and focused on a few files.",
      ...lines,
    ].join("\n");
  }

  private record(e: Omit<AccessEvent, "at">): void {
    const event = { ...e, at: new Date().toISOString() };
    const list = this.log.get(e.projectId) ?? [];
    list.push(event);
    this.log.set(e.projectId, list.slice(-100));
    this.onEvent(event);
  }

  recent(projectId: string): AccessEvent[] {
    return [...(this.log.get(projectId) ?? [])].reverse();
  }

  gateFor(projectId: string, runId = ""): ComputerGate {
    return {
      delivered: (taskId, agentKey, agentName, paths) => this.recordFiles(projectId, runId, taskId, agentKey, agentName, paths),
      describe: (agentKey) => this.describe(projectId, agentKey),
      read: (agentKey, agentName, ref) => this.read(projectId, agentKey, agentName, ref),
      check: (agentKey, agentName, commandId) => this.check(projectId, agentKey, agentName, commandId),
    };
  }

  describe(projectId: string, agentKey: string | undefined): string | null {
    const access = this.store.agent(projectId, agentKey);
    if (!access.read) return null;
    const p = this.store.project(projectId);
    if (!p.folders.length) return null;
    const lines = [
      "## Computer access (granted by the user on this computer)",
      "You may read these folders. To read a file or list a folder, ask with a need of kind \"computer\" whose ref is the folder id, a slash and the path inside it, for example:",
      `<orqestra-need>{"kind":"computer","ref":"${p.folders[0]!.id}/README.md","why":"to see how the project is set up"}</orqestra-need>`,
      "Use the folder id alone to list the folder. Only paths inside these folders are given; anything else is refused.",
      ...p.folders.map((f) => `- ${f.id}: ${f.path}`),
    ];
    if (access.write) {
      const writable = p.folders.filter((f) => f.write);
      lines.push(writable.length
        ? `Your delivered files may be applied to ${writable.map((f) => f.id).join(", ")} after the user reviews a diff. Deliver them as usual; you never write those folders directly.`
        : "No folder accepts changes yet, so your files stay in the project workspace.");
    }
    if (access.commands && p.commands.length) {
      lines.push("You may run these checks the user approved. Ask with a need of kind \"check\" whose ref is the check id; you get its output and exit code:");
      for (const c of p.commands) lines.push(`- ${c.id}: ${c.label} (\`${c.command}\` in ${c.cwd || "."} of ${c.folderId})`);
    }
    return lines.join("\n");
  }

  read(projectId: string, agentKey: string | undefined, agentName: string, ref: string): { ok: true; label: string; content: string } | { ok: false; message: string } {
    const deny = (message: string, action: "read" | "list" = "read") => {
      this.record({ projectId, agent: agentName, action, target: ref, allowed: false, detail: message });
      return { ok: false as const, message };
    };
    if (!this.store.agent(projectId, agentKey).read) return deny(`${agentName} has no read access to folders on this computer in this project.`);
    const slash = ref.replace(/\\/g, "/").indexOf("/");
    const folderId = slash < 0 ? ref : ref.slice(0, slash);
    const rel = slash < 0 ? "" : ref.slice(slash + 1);
    const folder = this.store.project(projectId).folders.find((f) => f.id === folderId);
    if (!folder) return deny(`"${folderId}" is not a granted folder.`);
    try {
      const real = resolveForRead(folder.path, rel);
      const st = fs.statSync(real);
      if (st.isDirectory()) {
        const entries = fs.readdirSync(real, { withFileTypes: true }).slice(0, LIST_MAX).map((e) => (e.isDirectory() ? `${e.name}/` : e.isSymbolicLink() ? `${e.name} (link, not followed)` : e.name));
        this.record({ projectId, agent: agentName, action: "list", target: path.join(folder.path, rel), allowed: true, detail: `${entries.length} entries` });
        return { ok: true, label: `the folder ${ref}`, content: `--- ${ref}/ ---\n${entries.join("\n")}` };
      }
      if (st.size > 2_000_000) return deny(`${rel} is too large to read (${st.size} bytes).`);
      const text = fs.readFileSync(real, "utf8");
      this.record({ projectId, agent: agentName, action: "read", target: path.join(folder.path, rel), allowed: true, detail: `${st.size} bytes` });
      return { ok: true, label: `the file ${ref}`, content: `--- ${ref} ---\n${text.length > READ_CHARS ? `${text.slice(0, READ_CHARS)}\n[... cut to fit ...]` : text}` };
    } catch (error) {
      return deny(error instanceof AccessDenied ? error.message : `Could not read ${ref}: ${(error as Error).message}`);
    }
  }

  // Runs an approved command in its folder. Stops at once when access is revoked while it runs.
  async check(projectId: string, agentKey: string | undefined, agentName: string, commandId: string): Promise<{ ok: true; label: string; content: string } | { ok: false; message: string }> {
    const deny = (message: string) => {
      this.record({ projectId, agent: agentName, action: "check", target: commandId, allowed: false, detail: message });
      return { ok: false as const, message };
    };
    if (!this.store.agent(projectId, agentKey).commands) return deny(`${agentName} may not run checks on this computer in this project.`);
    const p = this.store.project(projectId);
    const command = p.commands.find((c) => c.id === commandId);
    if (!command) return deny(`"${commandId}" is not an approved check.`);
    const folder = p.folders.find((f) => f.id === command.folderId);
    if (!folder) return deny(`The folder for ${command.label} is no longer granted.`);
    let cwd: string;
    try {
      cwd = resolveForRead(folder.path, command.cwd);
    } catch (error) {
      return deny((error as Error).message);
    }
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k)) env[k] = v;
    this.record({ projectId, agent: agentName, action: "check", target: `${command.command} (in ${cwd})`, allowed: true, detail: "started" });
    const result = await new Promise<{ code: number | null; out: string; ended: string | null }>((resolve) => {
      let out = "";
      let ended: string | null = null;
      const child = spawn(command.command, { cwd, env, shell: true, windowsHide: true });
      const add = (b: Buffer) => { if (out.length < OUTPUT_CHARS * 2) out += b.toString("utf8"); };
      child.stdout?.on("data", add);
      child.stderr?.on("data", add);
      const kill = (why: string) => {
        ended = why;
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGKILL");
      };
      const timer = setTimeout(() => kill(`Stopped after ${CHECK_TIMEOUT_MS / 60_000} minutes.`), CHECK_TIMEOUT_MS);
      // Revoking access, or removing the check, stops it.
      const watch = setInterval(() => {
        const now = this.store.project(projectId);
        if (!this.store.agent(projectId, agentKey).commands || !now.commands.some((c) => c.id === commandId) || !now.folders.some((f) => f.id === folder.id)) kill("Stopped: access was revoked.");
      }, 500);
      child.on("error", (error) => { out += `\n${error.message}`; });
      child.on("close", (code) => { clearTimeout(timer); clearInterval(watch); resolve({ code, out, ended }); });
    });
    const tail = result.out.length > OUTPUT_CHARS ? `[... earlier output cut ...]\n${result.out.slice(-OUTPUT_CHARS)}` : result.out;
    this.record({ projectId, agent: agentName, action: "check", target: command.command, allowed: !result.ended?.includes("revoked"), detail: result.ended ?? `exit code ${result.code}` });
    if (result.ended?.includes("revoked")) return { ok: false, message: `${command.label} was stopped: access was revoked.` };
    return { ok: true, label: `the check ${command.label}`, content: `--- ${command.label}: ${command.command} (in ${cwd}) ---\n${result.ended ?? `Exit code ${result.code}`}\n${tail}` };
  }

  // ---- Applying delivered files to a granted folder -----------------------------------------

  // A run delivered files (the runner already kept them to the task's approved scope).
  recordFiles(projectId: string, runId: string, taskId: string, agentKey: string | undefined, agentName: string, paths: string[]): void {
    const map = this.pending.get(projectId) ?? new Map<string, PendingFile>();
    for (const p of paths) map.set(p.toLowerCase(), { path: p, agentKey, agentName, taskId, runId });
    this.pending.set(projectId, map);
    this.savePending();
  }

  pendingFiles(projectId: string): PendingFile[] {
    return [...(this.pending.get(projectId)?.values() ?? [])];
  }

  private authorIssue(projectId: string, file: PendingFile, access: AgentAccess): string | null {
    void projectId;
    // Files in a .git folder could change the repository's settings or hooks; they are never applied.
    if (insideGitFolder(file.path)) return "Files inside a .git folder are never applied.";
    if (!access.write) return `${file.agentName} has no write access in this project, so this file stays in the workspace.`;
    return null;
  }

  // The diff for each delivered file against the granted folder, and what may be applied.
  previewApply(projectId: string, folderId: unknown) {
    const folder = this.store.project(projectId).folders.find((f) => f.id === folderId);
    if (!folder) throw new Error("Choose a granted folder.");
    liveRoot(folder.path);
    const files = this.pendingFiles(projectId);
    const workspace = this.workspaceFor(projectId);
    const reserved = folder.write ? this.reservedByOthers(projectId, files.map((f) => f.path)) : null;
    const preview: Preview = { id: crypto.randomUUID(), projectId, folderId: folder.id, at: Date.now(), items: new Map() };
    const items = files.map((file) => {
      const [delivered] = readFiles(workspace, [file.path], Number.MAX_SAFE_INTEGER);
      const target = path.join(folder.path, ...file.path.split("/"));
      let current: string | null = null;
      let problem: string | null = null;
      try {
        current = fs.existsSync(target) ? fs.readFileSync(resolveForRead(folder.path, file.path), "utf8") : null;
      } catch (error) {
        problem = (error as Error).message;
      }
      if (!delivered) problem = problem ?? "The delivered file is no longer in the workspace.";
      if (!folder.write) problem = problem ?? `${folder.path} is read-only for agents. Allow changes there first.`;
      problem = problem ?? this.authorIssue(projectId, file, this.store.agent(projectId, file.agentKey)) ?? reserved;
      const same = delivered && current === delivered.content;
      if (delivered && !problem && !same) preview.items.set(file.path.toLowerCase(), { hash: current === null ? null : sha(current), content: delivered.content, pending: file });
      return {
        path: file.path, agent: file.agentName, taskId: file.taskId, target,
        status: problem ? "blocked" : same ? "same" : "ready",
        reason: problem,
        isNew: current === null,
        diff: delivered && !same ? unifiedDiff(file.path, current ?? "", delivered.content) ?? "" : "",
      };
    });
    this.previews.set(preview.id, preview);
    for (const [id, p] of this.previews) if (Date.now() - p.at > 30 * 60_000) this.previews.delete(id);
    return { previewId: preview.id, folderId: folder.id, folder: folder.path, items };
  }

  // Applies the chosen files of a preview. Everything is checked again: the author's permission and
  // the folder's (revoked since?), the real path, teammates' reservations, and the file on disk (if
  // it changed since the diff was shown, it is a conflict with a local edit and is not overwritten).
  apply(projectId: string, previewId: unknown, chosen: unknown) {
    const preview = typeof previewId === "string" ? this.previews.get(previewId) : undefined;
    if (!preview || preview.projectId !== projectId) throw new Error("Show the changes again before applying them.");
    const wanted = Array.isArray(chosen) ? chosen.filter((p): p is string => typeof p === "string").map((p) => p.toLowerCase()) : [];
    const applied: string[] = [];
    const conflicts: { path: string; reason: string }[] = [];
    const blocked: { path: string; reason: string }[] = [];
    const folder = this.store.project(projectId).folders.find((f) => f.id === preview.folderId);
    const reserved = folder ? this.reservedByOthers(projectId, wanted.map((w) => preview.items.get(w)?.pending.path ?? w)) : null;
    for (const key of wanted) {
      const item = preview.items.get(key);
      if (!item) { blocked.push({ path: key, reason: "Not in the reviewed changes." }); continue; }
      const rel = item.pending.path;
      const target = folder ? path.join(folder.path, ...rel.split("/")) : rel;
      const fail = (reason: string) => {
        blocked.push({ path: rel, reason });
        this.record({ projectId, agent: item.pending.agentName, action: "apply", target, allowed: false, detail: reason });
      };
      if (!folder) { fail("The folder is no longer granted."); continue; }
      if (!folder.write) { fail(`${folder.path} is read-only for agents now.`); continue; }
      const issue = this.authorIssue(projectId, item.pending, this.store.agent(projectId, item.pending.agentKey));
      if (issue) { fail(issue); continue; }
      if (reserved) { fail(reserved); continue; }
      try {
        const now = fs.existsSync(target) ? sha(fs.readFileSync(resolveForRead(folder.path, rel), "utf8")) : null;
        if (now !== item.hash) {
          conflicts.push({ path: rel, reason: "The file changed on this computer after the diff was shown. Your local edit was kept; review the changes again." });
          this.record({ projectId, agent: item.pending.agentName, action: "apply", target, allowed: false, detail: "conflict with a local edit" });
          continue;
        }
        writeInside(folder.path, rel, item.content);
        applied.push(rel);
        this.pending.get(projectId)?.delete(key);
        this.record({ projectId, agent: item.pending.agentName, action: "apply", target, allowed: true, detail: item.hash === null ? "new file" : "updated" });
      } catch (error) {
        fail(error instanceof AccessDenied ? error.message : `Could not write ${rel}: ${(error as Error).message}`);
      }
    }
    this.previews.delete(preview.id);
    if (applied.length) this.savePending();
    return { applied, conflicts, blocked };
  }

  // ---- Commit and push what was applied (the user's buttons, never an agent) --------------------

  private writableFolder(projectId: string, folderId: unknown) {
    const folder = this.store.project(projectId).folders.find((f) => f.id === folderId);
    if (!folder) throw new Error("Choose a granted folder.");
    if (!folder.write) throw new Error(`${folder.path} does not accept changes. Allow changes there first.`);
    if (!this.git) throw new Error("git is not available here.");
    return { folder, git: this.git };
  }

  async gitState(projectId: string, folderId: unknown): Promise<GitState> {
    const folder = this.store.project(projectId).folders.find((f) => f.id === folderId);
    if (!folder || !this.git) return { repo: false, branch: null, upstream: null, ahead: 0, remote: false, problem: folder ? "git is not available here." : "Choose a granted folder." };
    return gitState(this.git, folder.path);
  }

  async commit(projectId: string, folderId: unknown, paths: unknown, message: unknown) {
    const { folder, git } = this.writableFolder(projectId, folderId);
    try {
      const r = await gitCommit(git, folder.path, paths, message);
      this.record({ projectId, agent: "You", action: "commit", target: folder.path, allowed: true, detail: `${r.commit} on ${r.branch ?? "a detached HEAD"}` });
      return r;
    } catch (error) {
      this.record({ projectId, agent: "You", action: "commit", target: folder.path, allowed: false, detail: (error as Error).message.split("\n")[0]! });
      throw error;
    }
  }

  async push(projectId: string, folderId: unknown) {
    const { folder, git } = this.writableFolder(projectId, folderId);
    try {
      const r = await gitPush(git, folder.path);
      this.record({ projectId, agent: "You", action: "push", target: folder.path, allowed: true, detail: `pushed ${r.branch}` });
      return r;
    } catch (error) {
      this.record({ projectId, agent: "You", action: "push", target: folder.path, allowed: false, detail: (error as Error).message.split("\n")[0]! });
      throw error;
    }
  }

  forgetProject(projectId: string): void {
    this.store.forgetProject(projectId);
    this.pending.delete(projectId);
    this.savePending();
    this.log.delete(projectId);
    for (const [id, p] of this.previews) if (p.projectId === projectId) this.previews.delete(id);
  }
}
