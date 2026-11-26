import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { unifiedDiff } from "../team/diff";
import { readFiles } from "../team/workspace";
import { AccessStore, type AgentAccess } from "./access-store";
import { AccessDenied, liveRoot, resolveForRead, writeInside } from "./paths";
import { ChangeLedger, type ChangeEntry, type TaskOutcome } from "./change-ledger";
import { gitRunner } from "../teams/git-checkout";

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

export interface AccessEvent { projectId: string; at: string; agent: string; action: "read" | "list" | "check" | "apply"; target: string; allowed: boolean; detail: string }

interface PendingFile { path: string; agentKey: string | undefined; agentName: string; taskId: string; runId: string }
interface PreviewItem { hash: string | null; content: string; pending: PendingFile; delivered: string | null }
// runId is set for one run's review; null for the project-wide list in Computer access.
interface Preview { id: string; projectId: string; runId: string | null; folderId: string | null; branch: string | null; at: number; items: Map<string, PreviewItem> }

export interface AccessOptions {
  // Where each project's change ledger is kept; memory only when absent (tests).
  ledgerDir?: string;
  // Teams: this computer's linked checkout of a project, if any.
  checkoutFor?: (projectId: string) => string | null;
  // The current Git branch of a folder (null when it is not a checkout or HEAD is detached).
  branchOf?: (folder: string) => Promise<string | null>;
  // A run's waiting changes changed (delivered, applied, undone), so the window can refresh.
  onChanges?: (projectId: string) => void;
}

const READ_CHARS = 40_000;
const LIST_MAX = 200;
const OUTPUT_CHARS = 20_000;
const CHECK_TIMEOUT_MS = 10 * 60_000;
// Credentials stay out of commands agents start: variables that look like keys or tokens are dropped.
const SECRET_ENV = /(key|token|secret|password|passwd|credential|auth|cookie|session)/i;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export class AccessService {
  private readonly previews = new Map<string, Preview>();
  private readonly log = new Map<string, AccessEvent[]>();
  private readonly ledger: ChangeLedger;

  constructor(
    readonly store: AccessStore,
    private readonly workspaceFor: (projectId: string) => string,
    private readonly onEvent: (event: AccessEvent) => void = () => {},
    // Teams: a teammate's active reservation covering one of these paths, as a message; else null.
    private readonly reservedByOthers: (projectId: string, paths: string[]) => string | null = () => null,
    private readonly options: AccessOptions = {},
  ) {
    this.ledger = new ChangeLedger(options.ledgerDir ?? null);
  }

  private onChanges(projectId: string): void {
    try {
      this.options.onChanges?.(projectId);
    } catch {
      /* a listener never affects applying */
    }
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
      check: (agentKey, agentName, commandId) => this.check(projectId, agentKey, agentName, commandId, runId),
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
  async check(projectId: string, agentKey: string | undefined, agentName: string, commandId: string, runId = ""): Promise<{ ok: true; label: string; content: string } | { ok: false; message: string }> {
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
    // Evidence for the run's review: this check really ran, with this result.
    if (runId) this.ledger.check(projectId, runId, { commandId, label: command.label, command: command.command, cwd, agent: agentName, exitCode: result.code, ended: result.ended, at: new Date().toISOString() });
    return { ok: true, label: `the check ${command.label}`, content: `--- ${command.label}: ${command.command} (in ${cwd}) ---\n${result.ended ?? `Exit code ${result.code}`}\n${tail}` };
  }

  // ---- Applying delivered files to a granted folder -----------------------------------------

  // A run delivered files (the runner already kept them to the task's approved scope). The hash of
  // each workspace file right now is what this run wrote; a later change to it is noticed at review.
  recordFiles(projectId: string, runId: string, taskId: string, agentKey: string | undefined, agentName: string, paths: string[]): void {
    const workspace = this.workspaceFor(projectId);
    for (const p of paths) {
      const [now] = readFiles(workspace, [p], Number.MAX_SAFE_INTEGER);
      this.ledger.deliver(projectId, { path: p, runId, taskId, agentKey, agentName, hash: now ? sha(now.content) : null });
    }
    this.onChanges(projectId);
  }

  // What the window learns from a run as it goes: each task's outcome and the end of the run.
  runEvent(projectId: string, runId: string, event: { type: string; [key: string]: unknown }): void {
    if (!runId) return;
    if (event.type === "task" && typeof event.taskId === "string" && typeof event.status === "string") {
      this.ledger.task(projectId, runId, event.taskId, { status: event.status, ...(typeof event.note === "string" ? { note: event.note } : {}) });
    } else if (event.type === "review" && typeof event.taskId === "string") {
      this.ledger.task(projectId, runId, event.taskId, { approved: event.approved === true, problems: Array.isArray(event.problems) ? event.problems.filter((p): p is string => typeof p === "string").slice(0, 5) : [] });
    } else if (event.type === "run-finished" && typeof event.status === "string") {
      this.ledger.finished(projectId, runId, event.status);
      this.onChanges(projectId);
    }
  }

  // Undo put the run's files back in the workspace, so none of them is waiting any more.
  dismissRun(projectId: string, runId: string): void {
    this.ledger.dismissRun(projectId, runId);
    this.onChanges(projectId);
  }

  // The latest pending delivery of each path (the project-wide list in Computer access).
  pendingFiles(projectId: string): PendingFile[] {
    const latest = new Map<string, ChangeEntry>();
    for (const e of this.ledger.entries(projectId)) {
      if (e.state === "dismissed") continue;
      const key = e.path.toLowerCase();
      const seen = latest.get(key);
      if (!seen || e.seq > seen.seq) latest.set(key, e);
    }
    return [...latest.values()].filter((e) => e.state === "pending").sort((a, b) => a.seq - b.seq).map((e) => ({ path: e.path, agentKey: e.agentKey, agentName: e.agentName, taskId: e.taskId, runId: e.runId }));
  }

  // Per run: files still waiting, and how many of them this run's review could still apply (the
  // others were changed again by a later run or in the workspace).
  pendingByRun(projectId: string): Record<string, { pending: number; current: number }> {
    const workspace = this.workspaceFor(projectId);
    const out: Record<string, { pending: number; current: number }> = {};
    for (const e of this.ledger.entries(projectId)) {
      if (e.state !== "pending") continue;
      const row = out[e.runId] ?? { pending: 0, current: 0 };
      row.pending += 1;
      if (!this.replacedBy(projectId, workspace, e)) row.current += 1;
      out[e.runId] = row;
    }
    return out;
  }

  // Why this run's version of a file is no longer the one in the workspace, or null when it still is.
  private replacedBy(projectId: string, workspace: string, entry: ChangeEntry): string | null {
    const newer = this.ledger.newer(projectId, entry);
    if (newer) return `A later run changed this file after this run (${newer.agentName}, ${newer.state === "applied" ? "already applied" : "still waiting"}). Review that run's changes instead; this card never applies the newer version.`;
    const [now] = readFiles(workspace, [entry.path], Number.MAX_SAFE_INTEGER);
    if (!now) return "The file is no longer in the project workspace.";
    if (entry.hash === null || sha(now.content) !== entry.hash) return "The file in the project workspace changed after this run (for example by Undo), so this run's version is gone.";
    return null;
  }

  private authorIssue(projectId: string, file: { agentName: string }, access: AgentAccess): string | null {
    void projectId;
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
    const preview: Preview = { id: crypto.randomUUID(), projectId, runId: null, folderId: folder.id, branch: null, at: Date.now(), items: new Map() };
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
      if (delivered && !problem && !same) preview.items.set(file.path.toLowerCase(), { hash: current === null ? null : sha(current), content: delivered.content, pending: file, delivered: null });
      return {
        path: file.path, agent: file.agentName, taskId: file.taskId, target,
        status: problem ? "blocked" : same ? "same" : "ready",
        reason: problem,
        isNew: current === null,
        diff: delivered && !same ? unifiedDiff(file.path, current ?? "", delivered.content) ?? "" : "",
      };
    });
    this.keepPreview(preview);
    return { previewId: preview.id, folder: folder.path, items };
  }

  private keepPreview(preview: Preview): void {
    this.previews.set(preview.id, preview);
    for (const [id, p] of this.previews) if (Date.now() - p.at > 30 * 60_000) this.previews.delete(id);
  }

  // The folder a run's changes would land in: the one asked for; else this computer's linked
  // checkout when agents may change it; else another folder that accepts changes; else a read-only
  // folder (so the diff still shows, with every file blocked until changes are allowed there).
  private destination(projectId: string, folderId: unknown) {
    const folders = this.store.project(projectId).folders.map((f) => {
      let available = true;
      try { liveRoot(f.path); } catch { available = false; }
      return { ...f, available };
    });
    const checkoutPath = this.options.checkoutFor?.(projectId) ?? null;
    const isCheckout = (p: string) => Boolean(checkoutPath) && p.toLowerCase() === checkoutPath!.toLowerCase();
    const usable = folders.filter((f) => f.available);
    const chosen = (typeof folderId === "string" && usable.find((f) => f.id === folderId))
      || usable.find((f) => f.write && isCheckout(f.path))
      || usable.find((f) => f.write)
      || usable.find((f) => isCheckout(f.path))
      || usable[0]
      || null;
    const checkoutGrant = checkoutPath ? folders.find((f) => isCheckout(f.path)) ?? null : null;
    return {
      folder: chosen,
      folders: usable.map((f) => ({ id: f.id, path: f.path, write: f.write, isCheckout: isCheckout(f.path) })),
      checkout: checkoutPath ? { path: checkoutPath, granted: Boolean(checkoutGrant), write: Boolean(checkoutGrant?.write) } : null,
    };
  }

  private async branchOf(folderPath: string): Promise<string | null> {
    try {
      return (await (this.options.branchOf ?? defaultBranchOf)(folderPath)) || null;
    } catch {
      return null;
    }
  }

  // One run's changes, and only that run's: each file it delivered that is still waiting, with the
  // diff against the destination folder, whether a reviewer approved it, why it cannot be applied
  // (if so), and the approved checks the app saw run during this run.
  async reviewRun(projectId: string, runId: unknown, folderId?: unknown) {
    if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error("Unknown run.");
    const { folder, folders, checkout } = this.destination(projectId, folderId);
    const branch = folder ? await this.branchOf(folder.path) : null;
    const workspace = this.workspaceFor(projectId);
    const record = this.ledger.runRecord(projectId, runId);
    const entries = this.ledger.entries(projectId).filter((e) => e.runId === runId && e.state === "pending").sort((a, b) => a.path.localeCompare(b.path));
    const reserved = folder?.write ? this.reservedByOthers(projectId, entries.map((e) => e.path)) : null;
    const preview: Preview = { id: crypto.randomUUID(), projectId, runId, folderId: folder?.id ?? null, branch, at: Date.now(), items: new Map() };
    const files = entries.map((entry) => {
      const verification = verificationOf(record.tasks[entry.taskId]);
      const replaced = this.replacedBy(projectId, workspace, entry);
      const [delivered] = readFiles(workspace, [entry.path], Number.MAX_SAFE_INTEGER);
      const target = folder ? path.join(folder.path, ...entry.path.split("/")) : null;
      let current: string | null = null;
      let problem: string | null = replaced;
      let status: "ready" | "same" | "blocked" | "replaced" = replaced ? "replaced" : "ready";
      if (folder && target) {
        try {
          current = fs.existsSync(target) ? fs.readFileSync(resolveForRead(folder.path, entry.path), "utf8") : null;
        } catch (error) {
          problem = problem ?? (error as Error).message;
        }
      }
      if (!problem && !folder) problem = "No folder on this computer accepts changes for this project yet.";
      if (!problem && folder && !folder.write) problem = `${folder.path} is read-only for agents. Allow changes there in Computer access first.`;
      if (!problem && verification.state === "blocked") problem = `Its task did not pass: ${verification.note}`;
      if (!problem) problem = this.authorIssue(projectId, entry, this.store.agent(projectId, entry.agentKey)) ?? reserved;
      const same = Boolean(delivered && folder && current === delivered.content);
      if (status !== "replaced") status = problem ? "blocked" : same ? "same" : "ready";
      if (status === "ready" && delivered) {
        preview.items.set(entry.path.toLowerCase(), {
          hash: current === null ? null : sha(current), content: delivered.content, delivered: entry.hash,
          pending: { path: entry.path, agentKey: entry.agentKey, agentName: entry.agentName, taskId: entry.taskId, runId: entry.runId },
        });
      }
      return {
        path: entry.path, agent: entry.agentName, taskId: entry.taskId, target,
        status, reason: problem, verification,
        isNew: current === null,
        // A replaced file shows no diff: the workspace holds another run's version, never this one's.
        diff: delivered && status !== "replaced" && !same ? unifiedDiff(entry.path, current ?? "", delivered.content) ?? "(too long to compare here)" : "",
      };
    });
    this.keepPreview(preview);
    return {
      previewId: preview.id, runId,
      destination: folder ? { id: folder.id, path: folder.path, write: folder.write, isCheckout: Boolean(checkout && folder.path.toLowerCase() === checkout.path.toLowerCase()) } : null,
      folders, checkout, branch,
      needsAccess: !folder || !folder.write,
      files,
      // Only checks the app itself ran during this run; results agents mention are not evidence.
      checks: record.checks.map((c) => ({ label: c.label, command: c.command, cwd: c.cwd, agent: c.agent, exitCode: c.exitCode, ended: c.ended, at: c.at, passed: c.ended === null && c.exitCode === 0 })),
      finished: record.finished ?? null,
    };
  }

  // Applies the chosen files of one run's review. Everything is checked again first: that the review
  // is this run's, the folder and its permission, the Git branch (switched since? then nothing is
  // written and the review is stale), each author's permission, teammates' reservations, that the
  // workspace still holds this run's version and no later run changed the file, and the file on
  // disk (a local edit since the diff is kept and reported as a conflict).
  async applyRun(projectId: string, runId: unknown, previewId: unknown, chosen: unknown) {
    const preview = typeof previewId === "string" ? this.previews.get(previewId) : undefined;
    if (!preview || preview.projectId !== projectId || !preview.runId || preview.runId !== runId) throw new Error("Open this run's review again before applying its changes.");
    const wanted = [...new Set(Array.isArray(chosen) ? chosen.filter((p): p is string => typeof p === "string").map((p) => p.toLowerCase()) : [])];
    const applied: string[] = [];
    const conflicts: { path: string; reason: string }[] = [];
    const blocked: { path: string; reason: string }[] = [];
    const done = (stale: string | null) => {
      this.previews.delete(preview.id);
      this.onChanges(projectId);
      const left = this.pendingByRun(projectId)[preview.runId!] ?? { pending: 0, current: 0 };
      return { applied, conflicts, blocked, stale, remaining: left };
    };
    const folder = this.store.project(projectId).folders.find((f) => f.id === preview.folderId);
    const refuseAll = (reason: string) => { for (const key of wanted) blocked.push({ path: preview.items.get(key)?.pending.path ?? key, reason }); };
    if (!folder) { refuseAll("The folder is no longer granted."); return done(null); }
    try { liveRoot(folder.path); } catch (error) { refuseAll((error as Error).message); return done(null); }
    if (!folder.write) { refuseAll(`${folder.path} is read-only for agents now.`); return done(null); }
    const branchNow = await this.branchOf(folder.path);
    if (branchNow !== preview.branch) {
      const reason = `The branch in ${folder.path} changed from ${preview.branch ?? "none"} to ${branchNow ?? "none"} after the diff was shown. Nothing was written; refresh the review.`;
      refuseAll(reason);
      return done(reason);
    }
    const workspace = this.workspaceFor(projectId);
    const record = this.ledger.runRecord(projectId, preview.runId);
    const entries = this.ledger.entries(projectId).filter((e) => e.runId === preview.runId && e.state === "pending");
    const reserved = this.reservedByOthers(projectId, wanted.map((w) => preview.items.get(w)?.pending.path ?? w));
    let stale: string | null = null;
    for (const key of wanted) {
      const item = preview.items.get(key);
      if (!item) { blocked.push({ path: key, reason: "Not among this run's reviewed changes." }); continue; }
      const rel = item.pending.path;
      const target = path.join(folder.path, ...rel.split("/"));
      const fail = (reason: string) => {
        blocked.push({ path: rel, reason });
        this.record({ projectId, agent: item.pending.agentName, action: "apply", target, allowed: false, detail: reason });
      };
      const entry = entries.find((e) => e.path.toLowerCase() === key);
      if (!entry) { fail("It is no longer waiting (applied or undone since)."); continue; }
      const replaced = entry.hash !== item.delivered ? "This run delivered the file again after the diff was shown." : this.replacedBy(projectId, workspace, entry);
      if (replaced) { fail(replaced); stale = stale ?? "Some files changed in the project after the diff was shown. Refresh the review."; continue; }
      const [delivered] = readFiles(workspace, [rel], Number.MAX_SAFE_INTEGER);
      if (!delivered || delivered.content !== item.content) { fail("The workspace file changed after the diff was shown."); stale = stale ?? "Refresh the review."; continue; }
      const verification = verificationOf(record.tasks[entry.taskId]);
      if (verification.state === "blocked") { fail(`Its task did not pass: ${verification.note}`); continue; }
      const issue = this.authorIssue(projectId, item.pending, this.store.agent(projectId, item.pending.agentKey));
      if (issue) { fail(issue); continue; }
      if (reserved) { fail(reserved); continue; }
      try {
        const now = fs.existsSync(target) ? sha(fs.readFileSync(resolveForRead(folder.path, rel), "utf8")) : null;
        if (now !== item.hash) {
          conflicts.push({ path: rel, reason: "The file changed on this computer after the diff was shown. Your local edit was kept; refresh the review to see the new diff." });
          this.record({ projectId, agent: item.pending.agentName, action: "apply", target, allowed: false, detail: "conflict with a local edit" });
          stale = stale ?? "A file changed on this computer after the diff was shown. Refresh the review.";
          continue;
        }
        writeInside(folder.path, rel, item.content);
        applied.push(rel);
        this.ledger.settle(projectId, entry.runId, rel, "applied", folder.path);
        this.record({ projectId, agent: item.pending.agentName, action: "apply", target, allowed: true, detail: item.hash === null ? "new file" : "updated" });
      } catch (error) {
        fail(error instanceof AccessDenied ? error.message : `Could not write ${rel}: ${(error as Error).message}`);
      }
    }
    return done(stale);
  }

  // Applies the chosen files of a preview. Everything is checked again: the author's permission and
  // the folder's (revoked since?), the real path, teammates' reservations, and the file on disk (if
  // it changed since the diff was shown, it is a conflict with a local edit and is not overwritten).
  apply(projectId: string, previewId: unknown, chosen: unknown) {
    const preview = typeof previewId === "string" ? this.previews.get(previewId) : undefined;
    if (!preview || preview.projectId !== projectId || preview.runId) throw new Error("Show the changes again before applying them.");
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
        this.ledger.settle(projectId, item.pending.runId, rel, "applied", folder.path);
        this.record({ projectId, agent: item.pending.agentName, action: "apply", target, allowed: true, detail: item.hash === null ? "new file" : "updated" });
      } catch (error) {
        fail(error instanceof AccessDenied ? error.message : `Could not write ${rel}: ${(error as Error).message}`);
      }
    }
    this.previews.delete(preview.id);
    if (applied.length) this.onChanges(projectId);
    return { applied, conflicts, blocked };
  }

  forgetProject(projectId: string): void {
    this.store.forgetProject(projectId);
    this.ledger.forget(projectId);
    this.log.delete(projectId);
    for (const [id, p] of this.previews) if (p.projectId === projectId) this.previews.delete(id);
  }
}

// What the app recorded about a file's task: approved by a reviewer, delivered without review, or
// not passed (failed, blocked, stopped, or not finished).
export function verificationOf(task: TaskOutcome | undefined): { state: "reviewed" | "unverified" | "blocked"; note: string } {
  if (!task) return { state: "unverified", note: "No review was recorded for this file." };
  if (task.status === "done") return task.approved ? { state: "reviewed", note: task.note ?? "Approved by a reviewer." } : { state: "unverified", note: task.note ?? "Done without a recorded review." };
  if (task.status === "unverified") return { state: "unverified", note: task.note ?? "No reviewer checked this." };
  if (["failed", "blocked", "stopped"].includes(task.status)) return { state: "blocked", note: task.note ?? `The task ${task.status === "failed" ? "failed review" : `was ${task.status}`}.` };
  return { state: "blocked", note: "Its task has not finished." };
}

async function defaultBranchOf(folder: string): Promise<string | null> {
  const r = await gitRunner(() => process.env)(folder, ["branch", "--show-current"]);
  return r.ok ? r.stdout.trim() || null : null;
}
