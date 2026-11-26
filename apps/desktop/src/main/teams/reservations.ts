import type { Plan } from "../team/plan";

// Path reservations (Teams phase 5). Before a coordinated team run starts in a linked project, its
// owner's app reserves the run's repository-relative files in Supabase; the server grants the whole
// set or none, and refuses overlaps with any other active reservation in the project (any person,
// any branch). While the run is active the lease is renewed; every write the runner makes is
// authorised against it first, and a write outside it needs an atomic expansion. If the lease can
// no longer be confirmed, writes pause until Supabase confirms it again. The reservation is
// released when the run stops writing; after a crash it simply expires.
//
// This covers writes through 0rqestra's runner only. Edits made by hand or with other tools are
// outside this coordination.

export interface Conflict {
  name: string;
  task: string;
  branch: string | null;
  overlaps: { yours: string; theirs: string }[];
}

export type Gate =
  | { kind: "solo" }
  | { kind: "granted"; guard: WriteGuard }
  | { kind: "conflict"; conflicts: Conflict[]; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "no_scope"; message: string };

export interface WriteGuard {
  // Resolves when the paths may be written now; throws (with a readable message) when they may not.
  authorize(paths: string[]): Promise<void>;
  release(): Promise<void>;
}

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

interface Granted {
  status: "granted" | "renewed" | "expanded";
  reservation_id?: string;
  lease_token?: string;
  paths?: string[];
  expires_at?: string;
  server_now: string;
}

type Timer = unknown;

export interface CoordinatorDeps {
  rpc: Rpc;
  linkFor: (localProjectId: string) => { sharedProjectId: string; userId: string; path: string } | null;
  branchOf: (folder: string) => Promise<string | null>;
  onChange?: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  sleep?: (ms: number) => Promise<void>;
  ttlSeconds?: number;
  // How long a write waits for the lease to be confirmed again before it is refused.
  waitForLeaseMs?: number;
}

const REPO_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\/?$/;

// The same rules as the database: forward slashes, no drive letter, no leading slash, no "." or
// ".." segments. Returns null for anything else.
export function normalizeRepoPath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/{2,}/g, "/");
  if (!p || p.length > 300 || /^[A-Za-z]:/.test(p) || p.startsWith("/") || p.startsWith("~")) return null;
  if (p.split("/").some((s) => s === "." || s === "..")) return null;
  return REPO_PATH.test(p) ? p : null;
}

const key = (p: string) => p.toLowerCase().replace(/\/+$/, "");

// Same path, or one is a folder of the other (case-insensitive). src/auth/ overlaps
// src/auth/session.ts but not src/auth-old/.
export function pathsOverlap(a: string, b: string): boolean {
  const x = key(a);
  const y = key(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export function covered(path: string, reserved: string[]): boolean {
  const p = key(path);
  return reserved.some((r) => p === key(r) || p.startsWith(`${key(r)}/`));
}

export function conflictMessage(conflicts: Conflict[]): string {
  return conflicts
    .map((c) => `${c.name} is working on “${c.task || "a team run"}”${c.branch ? ` (branch ${c.branch})` : ""}, which reserves ${[...new Set(c.overlaps.map((o) => o.theirs))].join(", ")} — overlapping ${[...new Set(c.overlaps.map((o) => o.yours))].join(", ")}.`)
    .join(" ");
}

function parseConflicts(raw: unknown): Conflict[] {
  return (Array.isArray(raw) ? raw : []).map((c: Record<string, unknown>) => ({
    name: String(c.name ?? "A teammate"),
    task: String(c.task ?? ""),
    branch: typeof c.branch === "string" ? c.branch : null,
    overlaps: Array.isArray(c.overlaps) ? (c.overlaps as { yours: string; theirs: string }[]) : [],
  }));
}

// conflicts: the teammates whose reservations overlap, when that is why (shown by the run card).
export class WriteRefused extends Error {
  constructor(message: string, readonly conflicts: Conflict[] = []) {
    super(message);
  }
}

class Lease implements WriteGuard {
  token: string;
  paths: string[];
  // Local time until which the lease is known to be valid (server expiry, adjusted for clock offset,
  // minus a safety margin).
  validUntil: number;
  state: "valid" | "paused" | "released" = "valid";
  private timer: Timer | null = null;

  constructor(
    private readonly c: ReservationCoordinator,
    readonly projectId: string,
    readonly runId: string,
    public reservationId: string,
    granted: Granted,
    private readonly summary: string,
    private readonly branch: string | null,
  ) {
    this.token = granted.lease_token!;
    this.paths = granted.paths ?? [];
    this.validUntil = this.deadline(granted);
    this.schedule();
  }

  private deadline(g: Granted): number {
    const server = Date.parse(g.server_now);
    const expires = Date.parse(g.expires_at ?? "");
    if (!Number.isFinite(server) || !Number.isFinite(expires)) return this.c.now();
    return this.c.now() + (expires - server) - 10_000;
  }

  isValid(): boolean {
    return this.state === "valid" && this.c.now() < this.validUntil;
  }

  private schedule(): void {
    if (this.state === "released") return;
    this.timer = this.c.setTimer(() => {
      this.timer = null;
      void this.renew().finally(() => this.schedule());
    }, Math.max(5_000, (this.c.ttlSeconds * 1000) / 4));
  }

  // Renews the lease. When it is lost (expired, or replaced), tries to get the same paths again
  // under a new lease; until that works the lease stays paused and writes wait.
  async renew(): Promise<boolean> {
    if (this.state === "released") return false;
    try {
      const r = (await this.c.rpc("renew_reservation", { p_reservation_id: this.reservationId, p_lease_token: this.token, p_ttl_seconds: this.c.ttlSeconds })) as Granted | { status: "lost" };
      if (r.status === "renewed") {
        this.validUntil = this.deadline(r as Granted);
        this.state = "valid";
        this.c.changed();
        return true;
      }
      // Lost: never keep writing on an old lease. Ask for the scope again (a new lease token).
      this.state = "paused";
      this.c.changed();
      const again = (await this.c.rpc("acquire_reservation", {
        p_project_id: this.projectId, p_run_id: this.runId, p_summary: this.summary, p_branch: this.branch, p_paths: this.paths, p_ttl_seconds: this.c.ttlSeconds,
      })) as Granted | { status: "conflict" };
      if (again.status === "granted") {
        const g = again as Granted;
        this.reservationId = g.reservation_id!;
        this.token = g.lease_token!;
        this.paths = g.paths ?? this.paths;
        this.validUntil = this.deadline(g);
        this.state = "valid";
        this.c.changed();
        return true;
      }
      return false;
    } catch {
      // Unreachable: the lease stays usable only until its known expiry.
      if (!this.isValid() && this.state === "valid") {
        this.state = "paused";
        this.c.changed();
      }
      return false;
    }
  }

  async authorize(raw: string[]): Promise<void> {
    if (this.state === "released") throw new WriteRefused("This run's reservation was released; nothing more is written.");
    const paths = raw.map((p) => normalizeRepoPath(p));
    if (paths.some((p) => p === null)) throw new WriteRefused(`Refused a path that is not repository-relative: ${raw.find((_, i) => paths[i] === null)}`);
    // Writes wait while the lease cannot be confirmed, and resume once Supabase confirms it again.
    const deadline = this.c.now() + this.c.waitForLeaseMs;
    while (!this.isValid()) {
      if (await this.renew()) break;
      if (this.c.now() >= deadline) throw new WriteRefused("Coordination with your team was lost and this run's reservation could not be confirmed, so writing is paused. Check the connection and start the run again.");
      await this.c.sleep(5_000);
    }
    const outside = (paths as string[]).filter((p) => !covered(p, this.paths));
    if (!outside.length) return;
    // A write outside the reservation needs an atomic expansion first; a refusal keeps the
    // reservation as it was.
    let r: Granted | { status: "conflict"; conflicts: unknown } | { status: "lost" };
    try {
      r = (await this.c.rpc("expand_reservation", { p_reservation_id: this.reservationId, p_lease_token: this.token, p_paths: outside })) as typeof r;
    } catch {
      throw new WriteRefused(`Could not reserve ${outside.join(", ")}: the Teams server cannot be reached, so nothing outside the reservation is written.`);
    }
    if (r.status === "expanded") {
      this.paths = (r as Granted).paths ?? [...this.paths, ...outside];
      this.c.changed();
      return;
    }
    if (r.status === "conflict") {
      const conflicts = parseConflicts((r as { conflicts: unknown }).conflicts);
      throw new WriteRefused(`Not written: ${conflictMessage(conflicts)}`, conflicts);
    }
    this.state = "paused";
    this.c.changed();
    throw new WriteRefused("This run's reservation is no longer held, so writing is paused.");
  }

  async release(): Promise<void> {
    if (this.state === "released") return;
    this.state = "released";
    if (this.timer) this.c.clearTimer(this.timer);
    this.timer = null;
    this.c.forget(this);
    try {
      await this.c.rpc("release_reservation", { p_reservation_id: this.reservationId, p_lease_token: this.token });
    } catch {
      /* it expires by itself */
    }
    this.c.changed();
  }
}

export class ReservationCoordinator {
  readonly ttlSeconds: number;
  readonly waitForLeaseMs: number;
  private leases = new Map<string, Lease>();
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => Timer;
  readonly clearTimer: (timer: Timer) => void;
  readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: CoordinatorDeps) {
    this.ttlSeconds = deps.ttlSeconds ?? 120;
    this.waitForLeaseMs = deps.waitForLeaseMs ?? 90_000;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    return this.deps.rpc(fn, args);
  }

  changed(): void {
    this.deps.onChange?.();
  }

  forget(lease: Lease): void {
    if (this.leases.get(lease.runId) === lease) this.leases.delete(lease.runId);
  }

  // Before a run starts: solo projects pass; linked ones need the whole reservation granted.
  async beforeStart(info: { runId: string; localProjectId: string; plan: Plan }): Promise<Gate> {
    const link = this.deps.linkFor(info.localProjectId);
    if (!link) return { kind: "solo" };
    const existing = this.leases.get(info.runId);
    if (existing && existing.state !== "released") return { kind: "granted", guard: existing };
    const scope = [...new Set(info.plan.tasks.flatMap((t) => t.deliverables).map(normalizeRepoPath).filter((p): p is string => p !== null))];
    if (!scope.length) {
      return { kind: "no_scope", message: "This plan names no files or folders to work in, so it cannot be coordinated with your team. Ask the Manager to list the files the work will change, then start again." };
    }
    const branch = await this.deps.branchOf(link.path).catch(() => null);
    const summary = info.plan.goal.replace(/\s+/g, " ").trim().slice(0, 160);
    let r: Granted | { status: "conflict"; conflicts: unknown };
    try {
      r = (await this.rpc("acquire_reservation", { p_project_id: link.sharedProjectId, p_run_id: info.runId, p_summary: summary, p_branch: branch, p_paths: scope, p_ttl_seconds: this.ttlSeconds })) as typeof r;
    } catch (error) {
      return { kind: "unavailable", message: `Coordination with your team is unavailable (${error instanceof Error ? error.message : String(error)}). The run was not started, so it cannot overlap a teammate's work. Try again when the connection works.` };
    }
    if (r.status === "conflict") {
      const conflicts = parseConflicts((r as { conflicts: unknown }).conflicts);
      return { kind: "conflict", conflicts, message: `Not started: ${conflictMessage(conflicts)} Wait and retry, or ask the Manager to change the plan to other files.` };
    }
    const g = r as Granted;
    const lease = new Lease(this, link.sharedProjectId, info.runId, g.reservation_id!, g, summary, branch);
    this.leases.set(info.runId, lease);
    this.changed();
    return { kind: "granted", guard: lease };
  }

  // Released when the run has stopped writing: completed, failed or stopped.
  async onRunFinished(runId: string): Promise<void> {
    await this.leases.get(runId)?.release();
  }

  async releaseAll(): Promise<void> {
    await Promise.all([...this.leases.values()].map((l) => l.release()));
  }

  // This computer's leases, for the bridge.
  mine(): { runId: string; projectId: string; paths: string[]; state: string }[] {
    return [...this.leases.values()].map((l) => ({ runId: l.runId, projectId: l.projectId, paths: [...l.paths], state: l.isValid() ? "valid" : l.state }));
  }
}
