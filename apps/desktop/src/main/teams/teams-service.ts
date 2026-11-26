import crypto from "node:crypto";
import path from "node:path";
import { readCheckout, type CheckoutFacts, type GitRunner } from "./git-checkout";
import type { CheckoutLink, LinkStore, SessionStore } from "./local-store";
import { remoteMatching, resolveIdentity, type RemoteChoice } from "./repo-identity";
import { SupabaseApi, SupabaseError, type AuthSession, type FetchLike } from "./supabase-api";
import type { ConfigResult } from "./teams-config";
import type { PresenceSnapshot, PresenceTarget } from "./presence";
import { teamNowText } from "./team-now";
import { pathsOverlap } from "./reservations";

// Teams between the window and Supabase, free of Electron so it is unit-tested. Everything from the
// window is checked here; the window never sends a path, a token or a user id. Teams sign-in is
// separate from the Claude Code and Codex sign-ins.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_ID = /^[A-Za-z0-9_-]{1,100}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Lower case letters, digits and _, 3 to 24 characters, not starting with _ (the database checks the same).
export const USERNAME = /^[a-z0-9][a-z0-9_]{2,23}$/;
const SERVER_DOWN = "Can't reach the 0rqestra server. Check your internet connection and try again. Local projects keep working without it.";
const REFRESH_MARGIN_MS = 60_000;
const SELECTION_TTL_MS = 30 * 60_000;

export type TeamsStatus = "unconfigured" | "signed_out" | "code_sent" | "signed_in";
// The 0rqestra account flow: create an account, or sign in to an existing one (never creates one).
export type CodeMode = "register" | "sign_in";
export const RESEND_COOLDOWN_MS = 60_000;

// Teammates are shown by username; their email addresses are never sent to other people.
export interface MemberView { userId: string; name: string; role: "owner" | "member"; isYou: boolean }
// A friend, or a friend request waiting for an answer (usernames only).
export interface FriendView { requestId: string; userId: string; username: string; state: "friend" | "incoming" | "outgoing" }
// A pending invitation to a team: to me (incoming), or from a team I own (outgoing).
export interface TeamInviteView { id: string; teamId: string; teamName: string; userId: string; username: string; direction: "incoming" | "outgoing" }
export interface InviteView { id: string; email: string; expiresAt: string; state: "pending" | "used" | "revoked" | "expired" }
export interface LinkView {
  localProjectId: string;
  path: string;
  branch: string | null;
  // "linked": the folder is there and still points to the repository.
  state: "linked" | "missing" | "mismatch" | "unreadable";
  problem: string | null;
}
// A brief someone published about their work (written from phase 3 on; read here).
export interface BriefView { id: string; runId: string; title: string; status: string; authorId: string; authorName: string; branch: string | null; paths: string[]; updatedAt: string }
// A teammate's brief for the catch-up and the "What is … working on?" button (phase 4).
export interface CatchUpItem {
  id: string; runId: string; authorId: string; authorName: string; title: string; status: string; branch: string | null;
  paths: string[]; outcome: string | null; seq: number; seenSeq: number | null; updatedAt: string; finishedAt: string | null;
}
export type FetchResult<T> = { ok: true; items: T[]; at: number } | { ok: false; problem: string };
// This computer's own briefs and whether the server has them (phase 3).
export interface LocalBriefView { runId: string; title: string; status: string; outcome: string | null; updatedAt: number; sync: "pending" | "synced" | "failed"; error: string | null }
// An active path reservation (phase 5).
export interface ReservationView { id: string; runId: string; userId: string; name: string; task: string; branch: string | null; paths: string[]; expiresAt: string }
export interface SharedProjectView { id: string; name: string; repo: { owner: string; name: string; key: string }; link: LinkView | null; briefs: BriefView[]; reservations: ReservationView[] }
// One message in a shared project's team chat. "summary": a Manager summary a member chose to share.
export interface TeamMessageView { id: string; authorId: string; authorName: string; kind: "message" | "summary"; body: string; createdAt: string }
// A shared project's team chat: the latest messages, when they were read, and why they could not be.
// "needs_update": the Teams server does not have the team chat yet (its database migration is missing).
export interface TeamChatView { messages: TeamMessageView[]; at: number | null; problem: string | null; needsUpdate: boolean }
export interface TeamView { id: string; name: string; isOwner: boolean; members: MemberView[]; invites: InviteView[]; projects: SharedProjectView[] }

export interface TeamsView {
  status: TeamsStatus;
  userId: string | null;
  configProblem: string | null;
  server: string | null;
  email: string | null;
  // The account's display name (from its profile), or null if it never set one.
  displayName: string | null;
  // The account's unique username, and whether it still has to choose one.
  username: string | null;
  needsUsername: boolean;
  friends: FriendView[];
  teamInvites: TeamInviteView[];
  // Set while the 0rqestra server cannot be reached.
  serverProblem: string | null;
  pendingEmail: string | null;
  pendingMode: CodeMode | null;
  // When another code may be requested (ms since the epoch); 0 when it may be now.
  resendAt: number;
  // Set when Supabase ended the session (expired or revoked): the user is asked to sign in again.
  sessionEnded: string | null;
  // False when this computer cannot encrypt the session: it then ends when the app quits.
  rememberSession: boolean;
  teams: TeamView[];
  // Set when the last load failed (for example offline); the previous teams are kept.
  loadProblem: string | null;
  // Who is online, per shared project (phase 2). Empty until the presence connection reports.
  presence: PresenceSnapshot;
  // When the active briefs were last read from the server (ms), per shared project (phase 3).
  briefsAt: Record<string, number>;
  // This computer's own briefs per shared project, with their sync state (phase 3).
  localBriefs: Record<string, LocalBriefView[]>;
  // The team chat per shared project.
  chat: Record<string, TeamChatView>;
}

export interface CheckoutSelection {
  id: string;
  path: string;
  branch: string | null;
  remotes: RemoteChoice[];
  // The repository this folder belongs to, or why it cannot be decided yet.
  repo: { owner: string; name: string; key: string; remote: string } | null;
  problem: string | null;
  needsRemoteChoice: boolean;
}

export interface CreatedInvite { id: string; teamId: string; teamName: string; email: string; code: string; expiresAt: string; shareText: string }

interface TeamRow { id: string; name: string; owner_id: string; team_members: { user_id: string; username: string | null; role: "owner" | "member" }[]; shared_projects: { id: string; name: string; repo_owner: string; repo_name: string; repo_key: string }[] }
interface BriefRow { id: string; project_id: string; run_id: string; title: string; status: string; author_id: string; author_name: string | null; branch: string | null; paths: string[] | null; updated_at: string }
interface CatchUpRow { brief_id: string; run_id: string; author_id: string; author_name: string | null; title: string; status: string; branch: string | null; paths: string[] | null; outcome: string | null; seq: number; seen_seq: number | null; updated_at: string; finished_at: string | null }
const catchUpItem = (r: CatchUpRow): CatchUpItem => ({
  id: r.brief_id, runId: r.run_id, authorId: r.author_id, authorName: r.author_name ?? "", title: r.title, status: r.status, branch: r.branch,
  paths: r.paths ?? [], outcome: r.outcome, seq: r.seq, seenSeq: r.seen_seq, updatedAt: r.updated_at, finishedAt: r.finished_at,
});
interface ReservationRow { id: string; project_id: string; run_id: string; reserved_by: string; reserved_by_name: string | null; summary: string; branch: string | null; paths: string[] | null; expires_at: string }
const reservationView = (r: ReservationRow): ReservationView => ({ id: r.id, runId: r.run_id, userId: r.reserved_by, name: r.reserved_by_name ?? "", task: r.summary, branch: r.branch, paths: r.paths ?? [], expiresAt: r.expires_at });
const BRIEF_COLUMNS = "id,project_id,run_id,title,status,author_id,author_name,branch,paths,updated_at";
const briefView = (b: BriefRow): BriefView => ({ id: b.id, runId: b.run_id, title: b.title, status: b.status, authorId: b.author_id, authorName: b.author_name ?? "", branch: b.branch, paths: b.paths ?? [], updatedAt: b.updated_at });
interface InviteRow { id: string; team_id: string; email: string; expires_at: string; redeemed_at: string | null; revoked_at: string | null }
interface FriendRow { request_id: string; user_id: string; username: string; state: string }
interface TeamInviteRow { invite_id: string; team_id: string; team_name: string; user_id: string; username: string; direction: string }

const MESSAGES: Record<string, string> = {
  otp_expired: "That code is wrong or has expired. Check the newest email, or ask for a new code.",
  over_email_send_rate_limit: "The Teams server has sent as many emails as it may for now. Supabase's built-in email allows only a few per hour: wait, or ask the server's owner to set up custom SMTP.",
  over_request_rate_limit: "Too many attempts. Wait a minute and try again.",
  email_address_invalid: "That email address is not accepted.",
  signup_disabled: "This Teams server does not allow new accounts. Ask its owner to allow email sign-up.",
  email_provider_disabled: "Email sign-in is turned off on this Teams server.",
  not_signed_in: "Sign in to Teams first.",
  email_not_confirmed: "Your email address is not confirmed yet. Sign in again with a code.",
  invalid_team_name: "Give the team a name of 1 to 80 characters.",
  too_many_teams: "You already own 20 teams.",
  not_team_owner: "Only the team owner can do that.",
  invalid_email: "That email address does not look right.",
  already_member: "That person is already in the team.",
  invite_not_found: "That invite code was not found. Check it, or ask the owner for a new one.",
  invite_revoked: "That invite was withdrawn by the team owner. Ask for a new one.",
  invite_used: "That invite has already been used. Ask the owner for a new one.",
  invite_expired: "That invite has expired. Ask the owner for a new one.",
  invite_wrong_email: "That invite is for a different email address. Sign in with the address it was sent to.",
  not_project_member: "You are not a member of this shared project's team.",
  invalid_username: "A username has 3 to 24 lower-case letters, digits or _, and does not start with _.",
  username_taken: "That username is taken. Choose another one.",
  username_required: "Choose a username first.",
  user_not_found: "No 0rqestra account has that username. Check the spelling: it must match exactly.",
  cannot_friend_self: "That is your own username.",
  request_not_found: "That friend request is no longer there.",
  not_friends: "You can only invite people who accepted your friend request.",
  too_many_requests: "You have 100 friend requests waiting for an answer. Withdraw some first.",
  too_many_invites: "This team has 50 invitations waiting. Withdraw some first.",
  invalid_message: "Write a message of 1 to 4,000 characters.",
  too_many_messages: "That is many messages in a minute. Wait a moment and send it again.",
  try_again: "Something changed at the same moment. Try again.",
};

// Invitations to friends have no code, so their errors are worded differently.
const FRIEND_INVITE_MESSAGES: Record<string, string> = {
  invite_not_found: "That invitation is no longer there. Ask the team owner to invite you again.",
  invite_revoked: "The team owner withdrew that invitation.",
};

export function friendlyError(error: unknown): string {
  if (error instanceof SupabaseError) {
    const known = MESSAGES[error.message] ?? MESSAGES[error.code];
    if (known) return known;
    if (error.status === 429) return MESSAGES.over_request_rate_limit!;
    if (error.code === "42501") return "You do not have permission to do that in this team.";
    if (error.code === "network") return error.message;
    return `The Teams server refused: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

interface MessageRow { id: string; project_id: string; author_id: string; author_name: string | null; kind: string; body: string; created_at: string }
export const CHAT_LIMIT = 100;
const messageView = (r: MessageRow): TeamMessageView => ({ id: r.id, authorId: r.author_id, authorName: r.author_name ?? "", kind: r.kind === "summary" ? "summary" : "message", body: r.body, createdAt: r.created_at });

// PostgREST says a table or function is not there (the server has not got that migration yet).
export function isMissingTable(error: unknown): boolean {
  return error instanceof SupabaseError && (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST202" || error.code === "42883" || (error.status === 404 && /team_messages|send_team_message/.test(error.message)));
}

function inviteState(row: InviteRow, now: number): InviteView["state"] {
  if (row.redeemed_at) return "used";
  if (row.revoked_at) return "revoked";
  return Date.parse(row.expires_at) <= now ? "expired" : "pending";
}

function sameFolder(a: string, b: string, caseInsensitive: boolean): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return caseInsensitive ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export interface TeamsDeps {
  config: () => ConfigResult;
  fetch: FetchLike;
  sessions: SessionStore;
  links: LinkStore;
  git: GitRunner;
  emit: (view: TeamsView) => void;
  // Told which projects and people to watch for presence, whenever that changes.
  onPresenceTargets?: (targets: PresenceTarget[]) => void;
  // This computer's own briefs for a shared project (from the brief publisher).
  localBriefs?: (projectId: string) => LocalBriefView[];
  now?: () => number;
  caseInsensitivePaths?: boolean;
}

export class TeamsService {
  private session: AuthSession | null = null;
  private pendingEmail: string | null = null;
  private pendingMode: CodeMode | null = null;
  private pendingUsername: string | null = null;
  private username: string | null = null;
  private profileLoaded = false;
  private friends: FriendView[] = [];
  private teamInvites: TeamInviteView[] = [];
  private serverProblem: string | null = null;
  private resendAt = 0;
  private sessionEnded: string | null = null;
  private teams: TeamView[] = [];
  private loadProblem: string | null = null;
  private refreshing: Promise<AuthSession> | null = null;
  private selections = new Map<string, { facts: CheckoutFacts; at: number }>();
  private createdInvites = new Map<string, CreatedInvite>();
  private apiFor: { server: string; api: SupabaseApi } | null = null;
  private restored = false;
  private presence: PresenceSnapshot = {};
  private briefsAt: Record<string, number> = {};
  private chat: Record<string, TeamChatView> = {};
  private lastTargets = "";
  private readonly now: () => number;

  constructor(private readonly deps: TeamsDeps) {
    this.now = deps.now ?? Date.now;
  }

  private configured() {
    const c = this.deps.config();
    return c.ok ? c.config : null;
  }

  private api(): SupabaseApi {
    const config = this.configured();
    if (!config) throw new Error("Teams is not set up on this computer.");
    if (this.apiFor?.server !== config.url) this.apiFor = { server: config.url, api: new SupabaseApi(config, this.deps.fetch, this.now) };
    return this.apiFor.api;
  }

  private restore(): void {
    if (this.restored) return;
    this.restored = true;
    const config = this.configured();
    if (config) this.session = this.deps.sessions.load(config.url);
  }

  view(): TeamsView {
    this.restore();
    const c = this.deps.config();
    const config = c.ok ? c.config : null;
    const status: TeamsStatus = !config ? "unconfigured" : this.session ? "signed_in" : this.pendingEmail ? "code_sent" : "signed_out";
    return {
      status,
      userId: status === "signed_in" ? (this.session?.user.id ?? null) : null,
      configProblem: c.ok ? null : c.problem,
      server: config?.url ?? null,
      email: this.session?.user.email ?? null,
      displayName: this.session?.user.displayName ?? null,
      username: status === "signed_in" ? this.username : null,
      needsUsername: status === "signed_in" && this.profileLoaded && !this.username,
      friends: status === "signed_in" ? this.friends : [],
      teamInvites: status === "signed_in" ? this.teamInvites : [],
      serverProblem: config ? this.serverProblem : null,
      pendingEmail: this.pendingEmail,
      pendingMode: this.pendingEmail ? this.pendingMode : null,
      resendAt: this.resendAt > this.now() ? this.resendAt : 0,
      sessionEnded: this.session ? null : this.sessionEnded,
      rememberSession: this.deps.sessions.canPersist(),
      teams: status === "signed_in" ? this.teams : [],
      loadProblem: status === "signed_in" ? this.loadProblem : null,
      presence: status === "signed_in" ? this.presence : {},
      briefsAt: status === "signed_in" ? this.briefsAt : {},
      localBriefs: status === "signed_in" && this.deps.localBriefs
        ? Object.fromEntries(this.teams.flatMap((t) => t.projects).map((p) => [p.id, this.deps.localBriefs!(p.id)]))
        : {},
      chat: status === "signed_in" ? this.chat : {},
    };
  }

  private changed(): TeamsView {
    const v = this.view();
    const targets = this.presenceTargets(v);
    const key = JSON.stringify(targets);
    if (key !== this.lastTargets) {
      this.lastTargets = key;
      this.deps.onPresenceTargets?.(targets);
    }
    this.deps.emit(v);
    return v;
  }

  // Every shared project of every team I am in, with its members. Signed out: nothing.
  presenceTargets(v: TeamsView = this.view()): PresenceTarget[] {
    if (v.status !== "signed_in" || !v.userId) return [];
    const me = v.userId;
    return v.teams.flatMap((t) => t.projects.map((p) => ({ projectId: p.id, selfId: me, memberIds: t.members.map((m) => m.userId) })));
  }

  // Active work only: briefs of runs that are in progress or blocked. Reading never changes them.
  private async fetchBriefs(projectIds: string[]): Promise<BriefRow[]> {
    if (!projectIds.length) return [];
    const rows = await this.call((api, token) =>
      api.select<BriefRow>(token, "work_briefs", `select=${BRIEF_COLUMNS}&project_id=in.(${projectIds.join(",")})&status=in.(in_progress,blocked)&order=updated_at.desc&limit=200`),
    );
    const at = this.now();
    for (const id of projectIds) this.briefsAt[id] = at;
    return rows;
  }

  // Active, unexpired reservations (the lease token is never readable).
  private async fetchReservations(projectIds: string[]): Promise<ReservationRow[]> {
    if (!projectIds.length) return [];
    const rows = await this.call((api, token) =>
      api.select<ReservationRow>(token, "task_reservations", `select=id,project_id,run_id,reserved_by,reserved_by_name,summary,branch,paths,expires_at&project_id=in.(${projectIds.join(",")})&status=eq.active&order=created_at.asc&limit=200`),
    );
    return rows.filter((r) => Date.parse(r.expires_at) > this.now() - 60_000);
  }

  // A reservation function call for the coordinator (phase 5), with the session's token.
  async reservationRpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    if (!["acquire_reservation", "renew_reservation", "expand_reservation", "release_reservation"].includes(fn)) throw new Error("Unknown reservation call.");
    try {
      return await this.call((api, token) => api.rpc(token, fn, args));
    } catch (error) {
      throw new Error(friendlyError(error), { cause: error });
    }
  }

  // Reads the active briefs again (a brief changed, or the connection came back) and updates the
  // view. A failure keeps the briefs shown and their time, so the bridge can say they may be old.
  async refreshBriefs(projectId?: string): Promise<void> {
    if (!this.session || !this.configured()) return;
    const ids = this.teams.flatMap((t) => t.projects.map((p) => p.id)).filter((id) => !projectId || id === projectId);
    try {
      const rows = await this.fetchBriefs(ids);
      const held = await this.fetchReservations(ids);
      this.teams = this.teams.map((t) => ({
        ...t,
        projects: t.projects.map((p) => (ids.includes(p.id) ? { ...p, briefs: rows.filter((b) => b.project_id === p.id).map(briefView), reservations: held.filter((r) => r.project_id === p.id).map(reservationView) } : p)),
      }));
    } catch {
      /* keep what is shown; briefsAt tells how old it is */
    }
    this.changed();
  }

  // ---- Team chat ----------------------------------------------------------------------------

  // Reads the latest messages again (a message was added, or the connection came back). A failure keeps
  // what is shown; a server without the team chat says so once, instead of an error on every read.
  async refreshChat(projectId?: string): Promise<void> {
    if (!this.session || !this.configured()) return;
    const ids = this.teams.flatMap((t) => t.projects.map((p) => p.id)).filter((id) => !projectId || id === projectId);
    if (!ids.length) return;
    try {
      const rows = await this.call((api, token) =>
        api.select<MessageRow>(token, "team_messages", `select=id,project_id,author_id,author_name,kind,body,created_at&project_id=in.(${ids.join(",")})&order=created_at.desc&limit=${CHAT_LIMIT * ids.length}`),
      );
      const at = this.now();
      for (const id of ids) {
        const messages = rows.filter((r) => r.project_id === id).slice(0, CHAT_LIMIT).reverse().map(messageView);
        this.chat = { ...this.chat, [id]: { messages, at, problem: null, needsUpdate: false } };
      }
    } catch (error) {
      const missing = isMissingTable(error);
      for (const id of ids) {
        const old = this.chat[id] ?? { messages: [], at: null, problem: null, needsUpdate: false };
        this.chat = { ...this.chat, [id]: { ...old, needsUpdate: missing, problem: missing ? "The Teams server does not have the team chat yet. The owner of the server applies its database update (supabase/migrations/20261126210000_team_chat.sql)." : friendlyError(error) } };
      }
    }
    this.changed();
  }

  // Sends one message (or a Manager summary) to a shared project's team chat. The server takes the
  // author from the session and the name from the username; the text is kept as written.
  async sendTeamMessage(projectId: unknown, body: unknown, kind: unknown = "message"): Promise<TeamsView> {
    if (typeof projectId !== "string" || !this.teams.some((t) => t.projects.some((p) => p.id === projectId))) throw new Error("Unknown shared project.");
    const text = typeof body === "string" ? body.trim() : "";
    if (!text || text.length > 4000) throw new Error(MESSAGES.invalid_message!);
    const k = kind === "summary" ? "summary" : "message";
    try {
      await this.call((api, token) => api.rpc(token, "send_team_message", { p_project_id: projectId, p_body: text, p_kind: k }));
    } catch (error) {
      if (isMissingTable(error)) {
        await this.refreshChat(projectId);
        throw new Error("The Teams server does not have the team chat yet. The owner of the server applies its database update first.", { cause: error });
      }
      throw new Error(friendlyError(error), { cause: error });
    }
    await this.refreshChat(projectId);
    return this.view();
  }

  // Shared project and folder for a local project linked on this computer (for briefs).
  linkFor(localProjectId: string): { sharedProjectId: string; userId: string; path: string } | null {
    const link = this.myLinks().find((l) => l.localProjectId === localProjectId);
    return link ? { sharedProjectId: link.sharedProjectId, userId: link.userId, path: link.path } : null;
  }

  // Computer access: before agent changes are applied to a checkout, a teammate's active reservation
  // over one of the paths stops it. Null when nothing overlaps (or the project is not shared).
  reservedByOthers(localProjectId: string, paths: string[]): string | null {
    const link = this.myLinks().find((l) => l.localProjectId === localProjectId);
    if (!link || !this.session) return null;
    const project = this.teams.flatMap((t) => t.projects).find((p) => p.id === link.sharedProjectId);
    const me = this.session.user.id;
    for (const r of project?.reservations ?? []) {
      if (r.userId === me) continue;
      const hit = paths.find((p) => r.paths.some((q) => pathsOverlap(p, q)));
      if (hit) return `${r.name || "A teammate"} has reserved ${hit} for “${r.task || "a team run"}”. Wait until that run ends.`;
    }
    return null;
  }

  // "Team right now" for the Manager and the Planner of a local project linked to a shared
  // project: teammates' active work and reserved files. Null for a solo project or when signed out.
  teamNow(localProjectId: string): string | null {
    const link = this.myLinks().find((l) => l.localProjectId === localProjectId);
    if (!link || !this.session) return null;
    const team = this.teams.find((t) => t.projects.some((p) => p.id === link.sharedProjectId));
    const project = team?.projects.find((p) => p.id === link.sharedProjectId);
    if (!team || !project) return null;
    const presence = this.presence[project.id];
    const at = this.briefsAt[project.id];
    return teamNowText({
      projectName: project.name,
      repoKey: project.repo.key,
      me: this.session.user.id,
      members: team.members.map((m) => ({ userId: m.userId, name: m.name })),
      briefs: project.briefs,
      reservations: project.reservations,
      online: presence?.connection === "live" ? presence.online : null,
      ageMs: at ? this.now() - at : null,
      messages: (this.chat[project.id]?.messages ?? []).map((m) => ({ authorId: m.authorId, kind: m.kind, body: m.body, createdAt: m.createdAt })),
      nowMs: this.now(),
    });
  }

  currentUserId(): string | null {
    this.restore();
    return this.session?.user.id ?? null;
  }

  async branchOf(folder: string): Promise<string | null> {
    const read = await readCheckout(folder, this.deps.git);
    return read.ok ? read.facts.branch : null;
  }

  // Publishes or updates one run's brief. The server takes the author from the session.
  async publishBrief(b: { projectId: string; runId: string; seq: number; status: string; title: string; branch: string | null; paths: string[]; outcome: string | null }): Promise<{ applied: boolean; status: string; seq: number }> {
    try {
      const rows = await this.call((api, token) =>
        api.rpc<{ brief_id: string; status: string; seq: number; applied: boolean }[]>(token, "publish_run_brief", {
          p_project_id: b.projectId, p_run_id: b.runId, p_seq: b.seq, p_status: b.status, p_title: b.title, p_branch: b.branch, p_paths: b.paths, p_outcome: b.outcome,
        }),
      );
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (!row) throw new Error("The Teams server did not confirm the brief.");
      return { applied: row.applied, status: row.status, seq: row.seq };
    } catch (error) {
      throw new Error(friendlyError(error), { cause: error });
    }
  }

  // ---- Phase 4: catch-up and teammate status --------------------------------------------------

  private projectInMyTeams(projectId: unknown): { teamId: string; projectId: string } {
    if (typeof projectId !== "string" || !UUID.test(projectId)) throw new Error("Unknown shared project.");
    const team = this.teams.find((t) => t.projects.some((p) => p.id === projectId));
    if (!team) throw new Error("Unknown shared project.");
    return { teamId: team.id, projectId };
  }

  // Teammates' briefs this account has not seen at their current revision. Never throws: an
  // unreachable server is reported, so the app can try again on reconnect.
  async catchUp(projectId: unknown): Promise<FetchResult<CatchUpItem>> {
    try {
      const { projectId: id } = this.projectInMyTeams(projectId);
      const rows = await this.call((api, token) => api.rpc<CatchUpRow[]>(token, "team_catch_up", { p_project_id: id }));
      return { ok: true, items: (Array.isArray(rows) ? rows : []).map(catchUpItem), at: this.now() };
    } catch (error) {
      return { ok: false, problem: friendlyError(error) };
    }
  }

  // Records which revisions were shown. Called only after the catch-up is in the chat.
  async markSeen(projectId: unknown, rawItems: unknown): Promise<boolean> {
    const { projectId: id } = this.projectInMyTeams(projectId);
    if (!Array.isArray(rawItems) || rawItems.length > 100) throw new Error("Invalid items.");
    const items = rawItems.map((i: unknown) => {
      const v = (i ?? {}) as Record<string, unknown>;
      if (typeof v.id !== "string" || !UUID.test(v.id) || !Number.isInteger(v.seq) || (v.seq as number) < 1) throw new Error("Invalid items.");
      return { id: v.id, seq: v.seq as number };
    });
    if (!items.length) return true;
    try {
      await this.call((api, token) => api.rpc(token, "mark_briefs_seen", { p_project_id: id, p_items: items }));
      return true;
    } catch {
      return false;
    }
  }

  // One teammate's current briefs in a project: active ones, and runs finished in the last 7 days.
  async teammateWork(projectId: unknown, userId: unknown): Promise<FetchResult<CatchUpItem>> {
    const { teamId, projectId: id } = this.projectInMyTeams(projectId);
    const team = this.teams.find((t) => t.id === teamId)!;
    if (typeof userId !== "string" || !team.members.some((m) => m.userId === userId)) throw new Error("Unknown teammate.");
    const since = new Date(this.now() - 7 * 24 * 3600_000).toISOString();
    try {
      const rows = await this.call((api, token) =>
        api.select<BriefRow & { outcome: string | null; seq: number; finished_at: string | null }>(
          token,
          "work_briefs",
          `select=${BRIEF_COLUMNS},outcome,seq,finished_at&project_id=eq.${id}&author_id=eq.${userId}&or=(status.in.(in_progress,blocked),finished_at.gte.${encodeURIComponent(since)})&order=updated_at.desc&limit=10`,
        ),
      );
      return {
        ok: true,
        at: this.now(),
        items: rows.map((b) => ({ ...briefView(b), outcome: b.outcome, seq: b.seq, seenSeq: null, finishedAt: b.finished_at })),
      };
    } catch (error) {
      return { ok: false, problem: friendlyError(error) };
    }
  }

  // Lets the view show this computer's brief sync state as it changes.
  notifyLocalBriefs(): void {
    if (this.session) this.changed();
  }

  setPresence(snapshot: PresenceSnapshot): void {
    this.presence = snapshot;
    this.changed();
  }

  // A valid access token for the Realtime connection, refreshed when needed; null when signed out.
  async accessToken(): Promise<string | null> {
    this.restore();
    if (!this.session || !this.configured()) return null;
    try {
      return await this.token();
    } catch {
      return null;
    }
  }

  // ---- Sign-in ------------------------------------------------------------------------------

  // Sends a one-time code. "sign_in" (the default) never creates an account; "register" creates one
  // with the display name in its profile.
  async sendCode(raw: unknown, rawOptions?: unknown): Promise<TeamsView> {
    const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || email.length > 254) throw new Error(MESSAGES.invalid_email);
    const o = (rawOptions ?? {}) as Record<string, unknown>;
    const mode: CodeMode = o.mode === "register" ? "register" : "sign_in";
    // A resend for the same new account keeps the username given the first time.
    const given = typeof o.username === "string" ? o.username.trim().replace(/^@/, "").toLowerCase() : "";
    const username = given || (mode === "register" && email === this.pendingEmail ? (this.pendingUsername ?? "") : "");
    if (mode === "register" && !USERNAME.test(username)) throw new Error(MESSAGES.invalid_username);
    if (email === this.pendingEmail && this.resendAt > this.now()) {
      throw new Error(`You can ask for a new code in ${Math.ceil((this.resendAt - this.now()) / 1000)} seconds.`);
    }
    if (mode === "register") {
      let free: unknown;
      try {
        free = await this.api().rpc<boolean>(null, "username_available", { p_username: username });
      } catch (error) {
        this.noteNetwork(error);
        throw new Error(friendlyError(error), { cause: error });
      }
      if (free !== true) throw new Error(MESSAGES.username_taken);
    }
    try {
      await this.api().sendCode(email, { createUser: mode === "register", ...(mode === "register" ? { displayName: username, username } : {}) });
      this.serverProblem = null;
    } catch (error) {
      this.noteNetwork(error);
      // Supabase's own wait ("…only request this after 42 seconds") becomes the cooldown.
      const wait = error instanceof SupabaseError ? /after (\d+) seconds?/i.exec(error.message) : null;
      if (wait) this.resendAt = this.now() + Number(wait[1]) * 1000;
      if (error instanceof SupabaseError && (error.code === "otp_disabled" || /signups not allowed/i.test(error.message))) {
        throw new Error(`There is no 0rqestra account for ${email}. Choose Create account to make one.`, { cause: error });
      }
      throw new Error(wait ? `You can ask for a new code in ${wait[1]} seconds.` : friendlyError(error), { cause: error });
    }
    this.pendingEmail = email;
    this.pendingMode = mode;
    this.pendingUsername = mode === "register" ? username : null;
    this.resendAt = this.now() + RESEND_COOLDOWN_MS;
    return this.changed();
  }

  async verifyCode(raw: unknown): Promise<TeamsView> {
    const code = typeof raw === "string" ? raw.replace(/\s+/g, "") : "";
    if (!this.pendingEmail) throw new Error("Ask for a code first.");
    if (!/^\d{6,10}$/.test(code)) throw new Error("Enter the code from the email (only digits).");
    let session: AuthSession;
    try {
      session = await this.api().verifyCode(this.pendingEmail, code);
    } catch (error) {
      this.noteNetwork(error);
      throw new Error(friendlyError(error), { cause: error });
    }
    const wanted = this.pendingMode === "register" ? this.pendingUsername : null;
    // Another account's teams, presence, briefs and friends must not remain in the view.
    this.resetAccountData();
    this.teams = [];
    this.presence = {};
    this.briefsAt = {};
    this.chat = {};
    this.loadProblem = null;
    this.createdInvites.clear();
    this.setSession(session);
    this.pendingEmail = null;
    this.pendingMode = null;
    this.pendingUsername = null;
    this.resendAt = 0;
    this.sessionEnded = null;
    // A new account gets the username it registered with. An account that already had one keeps
    // it; if the name was taken in the meantime, the app asks for another.
    if (wanted) {
      try {
        const rows = await this.call((api, token) => api.select<{ username: string }>(token, "profiles", `select=username&user_id=eq.${session.user.id}`));
        if (!rows.length) await this.call((api, token) => api.rpc<string>(token, "set_username", { p_username: wanted }));
      } catch {
        /* needsUsername makes the app ask */
      }
    }
    await this.load();
    return this.changed();
  }

  cancelCode(): TeamsView {
    this.pendingEmail = null;
    this.pendingMode = null;
    this.pendingUsername = null;
    this.resendAt = 0;
    return this.changed();
  }

  async signOut(): Promise<TeamsView> {
    this.restore();
    const s = this.session;
    this.clearSession();
    this.sessionEnded = null;
    if (s) {
      // The local session is gone either way; telling the server is best effort.
      try {
        await this.api().signOut(s.accessToken);
      } catch {
        /* offline or already expired */
      }
    }
    return this.changed();
  }

  private setSession(session: AuthSession): void {
    this.session = session;
    const config = this.configured();
    if (config) this.deps.sessions.save(config.url, session);
  }

  private clearSession(): void {
    this.session = null;
    this.teams = [];
    this.loadProblem = null;
    this.presence = {};
    this.briefsAt = {};
    this.chat = {};
    this.createdInvites.clear();
    this.resetAccountData();
    this.deps.sessions.clear();
  }

  private resetAccountData(): void {
    this.username = null;
    this.profileLoaded = false;
    this.friends = [];
    this.teamInvites = [];
  }

  // Remembers that the server could not be reached (shown until a request succeeds again).
  private noteNetwork(error: unknown): void {
    if (error instanceof SupabaseError && (error.code === "network" || error.status >= 500)) this.serverProblem = SERVER_DOWN;
  }

  private async token(force = false): Promise<string> {
    this.restore();
    const s = this.session;
    if (!s) throw new Error(MESSAGES.not_signed_in);
    if (!force && s.expiresAt - REFRESH_MARGIN_MS > this.now()) return s.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.api()
        .refresh(s.refreshToken)
        .then((next) => {
          const kept = next.user.displayName ? next : { ...next, user: { ...next.user, displayName: s.user.displayName } };
          this.setSession(kept);
          return kept;
        })
        .catch((error: unknown) => {
          // A refused refresh token means the session is over; a network problem does not.
          if (error instanceof SupabaseError && error.status >= 400 && error.status < 500) {
            this.clearSession();
            this.sessionEnded = "Your 0rqestra session has ended. Sign in again to use your account and Teams.";
            this.changed();
            throw new Error("Your 0rqestra session has ended. Sign in again.", { cause: error });
          }
          throw error;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return (await this.refreshing).accessToken;
  }

  // Runs a request with a valid token; an expired-token answer refreshes once and retries.
  private async call<T>(fn: (api: SupabaseApi, token: string) => Promise<T>): Promise<T> {
    const api = this.api();
    try {
      return await fn(api, await this.token());
    } catch (error) {
      if (error instanceof SupabaseError && error.status === 401) return fn(api, await this.token(true));
      throw error;
    }
  }

  private userId(): string {
    if (!this.session) throw new Error(MESSAGES.not_signed_in);
    return this.session.user.id;
  }

  // ---- Teams --------------------------------------------------------------------------------

  async refresh(): Promise<TeamsView> {
    this.restore();
    if (!this.configured()) return this.changed();
    if (this.session) await this.load();
    else await this.checkServer();
    return this.changed();
  }

  // Asks the server whether it answers, so a signed-out window can say "offline" instead of
  // showing a sign-in form that cannot work.
  private async checkServer(): Promise<void> {
    try {
      await this.api().health();
      this.serverProblem = null;
    } catch (error) {
      if (error instanceof SupabaseError && (error.code === "network" || error.status >= 500)) this.serverProblem = SERVER_DOWN;
      else this.serverProblem = null;
    }
  }

  // The username, friends and team invitations. Called with every full load, and on its own more
  // often, so requests and invitations show up without a restart.
  private async loadSocial(): Promise<void> {
    const me = this.userId();
    const [profile, friends, invites] = await Promise.all([
      this.call((api, token) => api.select<{ username: string }>(token, "profiles", `select=username&user_id=eq.${me}`)),
      this.call((api, token) => api.rpc<FriendRow[]>(token, "list_friends", {})),
      this.call((api, token) => api.rpc<TeamInviteRow[]>(token, "list_team_invites", {})),
    ]);
    if (this.session?.user.id !== me) return;
    this.username = profile[0]?.username ?? null;
    this.profileLoaded = true;
    this.friends = (Array.isArray(friends) ? friends : [])
      .filter((f) => ["friend", "incoming", "outgoing"].includes(f.state))
      .map((f) => ({ requestId: f.request_id, userId: f.user_id, username: f.username, state: f.state as FriendView["state"] }));
    this.teamInvites = (Array.isArray(invites) ? invites : [])
      .filter((i) => i.direction === "incoming" || i.direction === "outgoing")
      .map((i) => ({ id: i.invite_id, teamId: i.team_id, teamName: i.team_name, userId: i.user_id, username: i.username, direction: i.direction as TeamInviteView["direction"] }));
  }

  // Re-reads friends and invitations only, and tells the window only when something changed.
  async refreshSocial(): Promise<void> {
    if (!this.session || !this.configured()) return;
    const before = JSON.stringify([this.username, this.friends, this.teamInvites]);
    try {
      await this.loadSocial();
      this.serverProblem = null;
    } catch (error) {
      this.noteNetwork(error);
    }
    if (JSON.stringify([this.username, this.friends, this.teamInvites]) !== before) this.changed();
  }

  private async load(): Promise<void> {
    try {
      const rows = await this.call((api, token) =>
        api.select<TeamRow>(token, "teams", "select=id,name,owner_id,team_members(user_id,username,role),shared_projects(id,name,repo_owner,repo_name,repo_key)&order=created_at.asc"),
      );
      const me = this.userId();
      const owned = rows.filter((t) => t.owner_id === me).map((t) => t.id);
      const invites = owned.length
        ? await this.call((api, token) =>
            api.select<InviteRow>(token, "team_invitations", `select=id,team_id,email,expires_at,redeemed_at,revoked_at&team_id=in.(${owned.join(",")})&order=created_at.desc&limit=200`),
          )
        : [];
      const projectIds = rows.flatMap((t) => t.shared_projects.map((p) => p.id));
      const briefs = await this.fetchBriefs(projectIds);
      const reservations = await this.fetchReservations(projectIds);
      const now = this.now();
      await this.loadSocial();
      this.teams = await Promise.all(
        rows.map(async (t) => ({
          id: t.id,
          name: t.name,
          isOwner: t.owner_id === me,
          members: t.team_members
            .map((m) => ({ userId: m.user_id, name: m.username ?? (m.user_id === me ? (this.username ?? "you") : "teammate"), role: m.role, isYou: m.user_id === me }))
            .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "owner" ? -1 : 1)),
          invites: invites.filter((i) => i.team_id === t.id).map((i) => ({ id: i.id, email: i.email, expiresAt: i.expires_at, state: inviteState(i, now) })),
          projects: await Promise.all(
            t.shared_projects.map(async (p) => ({ id: p.id, name: p.name, repo: { owner: p.repo_owner, name: p.repo_name, key: p.repo_key }, link: await this.linkView(p.id, p.repo_key),
              briefs: briefs.filter((b) => b.project_id === p.id).map(briefView),
              reservations: reservations.filter((r) => r.project_id === p.id).map(reservationView),
            })),
          ),
        })),
      );
      this.loadProblem = null;
      this.serverProblem = null;
      await this.refreshChat();
    } catch (error) {
      if (!this.session) return;
      this.noteNetwork(error);
      this.loadProblem = friendlyError(error);
    }
  }

  private myLinks(): CheckoutLink[] {
    const config = this.configured();
    if (!config || !this.session) return [];
    const me = this.session.user.id;
    return this.deps.links.all().filter((l) => l.userId === me && l.server === config.url);
  }

  // Checks a saved link against the folder as it is now.
  private async linkView(sharedProjectId: string, repoKey: string): Promise<LinkView | null> {
    const link = this.myLinks().find((l) => l.sharedProjectId === sharedProjectId);
    if (!link) return null;
    const read = await readCheckout(link.path, this.deps.git);
    if (!read.ok) {
      const missing = /not a Git checkout/.test(read.problem);
      return { localProjectId: link.localProjectId, path: link.path, branch: null, state: missing ? "missing" : "unreadable", problem: missing ? "The linked folder is gone or is no longer a Git checkout. Link the checkout again." : read.problem };
    }
    const match = remoteMatching(read.facts.remotes, repoKey);
    return {
      localProjectId: link.localProjectId,
      path: link.path,
      branch: read.facts.branch,
      state: match ? "linked" : "mismatch",
      problem: match ? null : `The folder no longer has a remote for ${repoKey}. Fix the remote or link another checkout.`,
    };
  }

  async createTeam(raw: unknown): Promise<TeamsView> {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (name.length < 1 || name.length > 80) throw new Error(MESSAGES.invalid_team_name);
    try {
      await this.call((api, token) => api.rpc<string>(token, "create_team", { p_name: name }));
    } catch (error) {
      throw new Error(friendlyError(error), { cause: error });
    }
    await this.load();
    return this.changed();
  }

  private team(teamId: unknown): TeamView {
    if (typeof teamId !== "string" || !UUID.test(teamId)) throw new Error("Unknown team.");
    const team = this.teams.find((t) => t.id === teamId);
    if (!team) throw new Error("Unknown team.");
    return team;
  }

  async createInvite(teamId: unknown, rawEmail: unknown): Promise<{ invite: CreatedInvite; view: TeamsView }> {
    const team = this.team(teamId);
    const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || email.length > 254) throw new Error(MESSAGES.invalid_email);
    let rows: { invitation_id: string; code: string; email: string; expires_at: string }[];
    try {
      rows = await this.call((api, token) => api.rpc(token, "create_invitation", { p_team_id: team.id, p_email: email }));
    } catch (error) {
      throw new Error(friendlyError(error), { cause: error });
    }
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || typeof row.code !== "string") throw new Error("The Teams server did not return an invite code.");
    const expires = new Date(row.expires_at);
    const invite: CreatedInvite = {
      id: row.invitation_id,
      teamId: team.id,
      teamName: team.name,
      email: row.email,
      code: row.code,
      expiresAt: row.expires_at,
      shareText: `You are invited to the 0rqestra team "${team.name}".\nSign in to Teams in 0rqestra as ${row.email}, choose "Join a team" and enter this code:\n\n${row.code}\n\nThe code works once and expires ${expires.toUTCString()}.`,
    };
    this.createdInvites.set(invite.id, invite);
    await this.load();
    return { invite, view: this.changed() };
  }

  // The share text of an invite created in this session. Codes are not stored anywhere else.
  inviteText(inviteId: unknown): string {
    const invite = typeof inviteId === "string" ? this.createdInvites.get(inviteId) : undefined;
    if (!invite) throw new Error("That invite code is no longer available here. Create a new invite.");
    return invite.shareText;
  }

  async revokeInvite(inviteId: unknown): Promise<TeamsView> {
    if (typeof inviteId !== "string" || !UUID.test(inviteId)) throw new Error("Unknown invite.");
    try {
      await this.call((api, token) => api.rpc(token, "revoke_invitation", { p_invitation_id: inviteId }));
    } catch (error) {
      throw new Error(friendlyError(error), { cause: error });
    }
    this.createdInvites.delete(inviteId);
    await this.load();
    return this.changed();
  }

  async acceptInvite(raw: unknown): Promise<TeamsView> {
    const code = typeof raw === "string" ? raw.trim() : "";
    const hex = code.replace(/[^0-9A-Fa-f]/g, "");
    if (hex.length !== 24 || code.length > 60) throw new Error("An invite code has 24 letters and digits, like 1A2B3C-4D5E6F-7A8B9C-0D1E2F.");
    try {
      await this.call((api, token) => api.rpc<string>(token, "redeem_invitation", { p_code: code }));
    } catch (error) {
      throw new Error(friendlyError(error), { cause: error });
    }
    await this.load();
    return this.changed();
  }

  // ---- Username and friends ------------------------------------------------------------------

  async setUsername(raw: unknown): Promise<TeamsView> {
    const name = typeof raw === "string" ? raw.trim().replace(/^@/, "").toLowerCase() : "";
    if (!USERNAME.test(name)) throw new Error(MESSAGES.invalid_username);
    try {
      const saved = await this.call((api, token) => api.rpc<string>(token, "set_username", { p_username: name }));
      this.username = typeof saved === "string" ? saved : name;
      this.profileLoaded = true;
    } catch (error) {
      throw new Error(friendlyError(error), { cause: error });
    }
    await this.load();
    return this.changed();
  }

  private async social<T>(fn: (api: SupabaseApi, token: string) => Promise<T>, own: Record<string, string> = {}): Promise<T> {
    let result: T;
    try {
      result = await this.call(fn);
    } catch (error) {
      this.noteNetwork(error);
      const message = error instanceof SupabaseError ? own[error.message] : undefined;
      throw new Error(message ?? friendlyError(error), { cause: error });
    }
    try {
      await this.loadSocial();
    } catch {
      /* shown on the next refresh */
    }
    return result;
  }

  private uuid(raw: unknown, what: string): string {
    if (typeof raw !== "string" || !UUID.test(raw)) throw new Error(`Unknown ${what}.`);
    return raw;
  }

  // Finds the account with exactly this username and sends it a friend request. If that person had
  // already asked you, you become friends right away.
  async sendFriendRequest(raw: unknown): Promise<{ status: "pending" | "accepted"; view: TeamsView }> {
    const name = typeof raw === "string" ? raw.trim().replace(/^@/, "").toLowerCase() : "";
    if (!USERNAME.test(name)) throw new Error("Enter the exact username: 3 to 24 lower-case letters, digits or _.");
    if (this.username && name === this.username) throw new Error(MESSAGES.cannot_friend_self);
    const rows = await this.social((api, token) => api.rpc<{ request_id: string; status: string }[]>(token, "send_friend_request", { p_username: name }));
    const status = Array.isArray(rows) && rows[0]?.status === "accepted" ? "accepted" : "pending";
    return { status, view: this.changed() };
  }

  async respondFriend(requestId: unknown, accept: unknown): Promise<TeamsView> {
    const id = this.uuid(requestId, "friend request");
    await this.social((api, token) => api.rpc<string>(token, "respond_friend_request", { p_request_id: id, p_accept: accept === true }));
    return this.changed();
  }

  // Withdraws a request you sent, or ends a friendship.
  async removeFriend(userId: unknown): Promise<TeamsView> {
    const id = this.uuid(userId, "person");
    await this.social((api, token) => api.rpc(token, "remove_friend", { p_user_id: id }));
    return this.changed();
  }

  // Owner: invites an accepted friend to the team. The friend answers inside the app.
  async inviteFriend(teamId: unknown, userId: unknown): Promise<TeamsView> {
    const team = this.team(teamId);
    if (!team.isOwner) throw new Error(MESSAGES.not_team_owner);
    const id = this.uuid(userId, "person");
    if (!this.friends.some((f) => f.userId === id && f.state === "friend")) throw new Error(MESSAGES.not_friends);
    if (team.members.some((m) => m.userId === id)) throw new Error(MESSAGES.already_member);
    await this.social((api, token) => api.rpc<string>(token, "invite_friend_to_team", { p_team_id: team.id, p_user_id: id }));
    return this.changed();
  }

  // The invited person accepts (and joins the team) or declines.
  async respondTeamInvite(inviteId: unknown, accept: unknown): Promise<TeamsView> {
    const id = this.uuid(inviteId, "invitation");
    await this.social((api, token) => api.rpc(token, "respond_team_invite", { p_invite_id: id, p_accept: accept === true }), FRIEND_INVITE_MESSAGES);
    if (accept === true) await this.load();
    return this.changed();
  }

  async revokeTeamInvite(inviteId: unknown): Promise<TeamsView> {
    const id = this.uuid(inviteId, "invitation");
    await this.social((api, token) => api.rpc(token, "revoke_team_invite", { p_invite_id: id }), FRIEND_INVITE_MESSAGES);
    return this.changed();
  }

  // ---- Checkouts ----------------------------------------------------------------------------

  // Reads a folder the user picked in the system dialog. The result is kept here under an id, so
  // the window can refer to it without ever sending a path.
  async inspectFolder(folder: string, chosenRemote: string | null = null): Promise<CheckoutSelection> {
    for (const [id, s] of this.selections) if (this.now() - s.at > SELECTION_TTL_MS) this.selections.delete(id);
    const read = await readCheckout(folder, this.deps.git);
    if (!read.ok) return { id: "", path: folder, branch: null, remotes: [], repo: null, problem: read.problem, needsRemoteChoice: false };
    const facts = { ...read.facts, root: path.resolve(read.facts.root) };
    const id = crypto.randomUUID();
    this.selections.set(id, { facts, at: this.now() });
    return this.describe(id, facts, chosenRemote);
  }

  describeSelection(selectionId: unknown, remote: unknown): CheckoutSelection {
    const s = typeof selectionId === "string" ? this.selections.get(selectionId) : undefined;
    if (!s) throw new Error("Choose the checkout folder again.");
    const name = typeof remote === "string" && remote.length <= 200 ? remote : null;
    return this.describe(selectionId as string, s.facts, name);
  }

  private describe(id: string, facts: CheckoutFacts, chosenRemote: string | null): CheckoutSelection {
    const r = resolveIdentity(facts.remotes, chosenRemote);
    return {
      id,
      path: facts.root,
      branch: facts.branch,
      remotes: r.remotes,
      repo: r.status === "ok" ? { owner: r.identity.owner, name: r.identity.name, key: r.identity.key, remote: r.remote } : null,
      problem: r.status === "ok" ? null : r.problem,
      needsRemoteChoice: r.status === "ambiguous",
    };
  }

  private async freshSelection(selectionId: unknown): Promise<CheckoutFacts> {
    const s = typeof selectionId === "string" ? this.selections.get(selectionId) : undefined;
    if (!s) throw new Error("Choose the checkout folder again.");
    // Read it again: the folder may have changed since it was chosen.
    const read = await readCheckout(s.facts.root, this.deps.git);
    if (!read.ok) throw new Error(read.problem);
    return { ...read.facts, root: path.resolve(read.facts.root) };
  }

  private localId(raw: unknown): string {
    if (typeof raw !== "string" || !LOCAL_ID.test(raw)) throw new Error("Choose a 0rqestra project.");
    return raw;
  }

  private saveLink(localProjectId: string, sharedProjectId: string, teamId: string, repoKey: string, folder: string): void {
    const config = this.configured()!;
    const me = this.userId();
    const clash = this.myLinks().find((l) => l.localProjectId !== localProjectId && l.sharedProjectId !== sharedProjectId && sameFolder(l.path, folder, this.deps.caseInsensitivePaths ?? false));
    if (clash) throw new Error("This folder is already linked to another shared project.");
    this.deps.links.put({ localProjectId, sharedProjectId, teamId, repoKey, path: folder, userId: me, server: config.url, linkedAt: new Date(this.now()).toISOString() });
  }

  // Owner: registers the checkout's GitHub repository as a shared project and links this checkout.
  async registerProject(raw: unknown): Promise<TeamsView> {
    const v = (raw ?? {}) as Record<string, unknown>;
    const team = this.team(v.teamId);
    if (!team.isOwner) throw new Error(MESSAGES.not_team_owner);
    const localProjectId = this.localId(v.localProjectId);
    const name = typeof v.name === "string" ? v.name.trim() : "";
    if (name.length < 1 || name.length > 80) throw new Error("Give the shared project a name of 1 to 80 characters.");
    const remote = typeof v.remote === "string" && v.remote ? v.remote : null;
    const facts = await this.freshSelection(v.selectionId);
    const r = resolveIdentity(facts.remotes, remote);
    if (r.status !== "ok") throw new Error(r.problem);
    if (team.projects.some((p) => p.repo.key === r.identity.key)) throw new Error(`${r.identity.owner}/${r.identity.name} is already a shared project in ${team.name}. Link your checkout to it instead.`);
    let row: { id: string; repo_key: string };
    try {
      row = await this.call((api, token) =>
        api.insert<{ id: string; repo_key: string }>(token, "shared_projects", { team_id: team.id, name, repo_owner: r.identity.owner, repo_name: r.identity.name }, "id,repo_key"),
      );
    } catch (error) {
      if (error instanceof SupabaseError && error.code === "23505") throw new Error(`${r.identity.owner}/${r.identity.name} is already a shared project in ${team.name}.`, { cause: error });
      throw new Error(friendlyError(error), { cause: error });
    }
    this.saveLink(localProjectId, row.id, team.id, row.repo_key, facts.root);
    await this.load();
    return this.changed();
  }

  // Any member: links their own checkout after confirming it points to the shared repository.
  async linkCheckout(raw: unknown): Promise<TeamsView> {
    const v = (raw ?? {}) as Record<string, unknown>;
    const localProjectId = this.localId(v.localProjectId);
    if (typeof v.sharedProjectId !== "string" || !UUID.test(v.sharedProjectId)) throw new Error("Unknown shared project.");
    const team = this.teams.find((t) => t.projects.some((p) => p.id === v.sharedProjectId));
    const project = team?.projects.find((p) => p.id === v.sharedProjectId);
    if (!team || !project) throw new Error("Unknown shared project.");
    const facts = await this.freshSelection(v.selectionId);
    if (!remoteMatching(facts.remotes, project.repo.key)) {
      const found = resolveIdentity(facts.remotes);
      const what = found.status === "ok" ? `points to ${found.identity.owner}/${found.identity.name}` : `has no remote for it (${found.problem})`;
      throw new Error(`This checkout is not ${project.repo.owner}/${project.repo.name}: it ${what}. Choose a clone of ${project.repo.owner}/${project.repo.name}.`);
    }
    this.saveLink(localProjectId, project.id, team.id, project.repo.key, facts.root);
    await this.load();
    return this.changed();
  }

  async unlink(raw: unknown): Promise<TeamsView> {
    if (typeof raw !== "string" || !UUID.test(raw)) throw new Error("Unknown shared project.");
    const me = this.userId();
    this.deps.links.remove((l) => l.sharedProjectId === raw && l.userId === me);
    await this.load();
    return this.changed();
  }

  // ---- Managing a team (owners; members can leave) ---------------------------------------------
  // The database decides who may do what (row-level security and the owner-only function); these
  // checks only give a clear message first. After each change the teams are read again, so access,
  // presence and briefs follow at once (a removed member's subscriptions stop with the next load).

  private async teamChange(fn: (api: SupabaseApi, token: string) => Promise<unknown>, own: Record<string, string> = {}): Promise<TeamsView> {
    try {
      await this.call(fn);
    } catch (error) {
      const message = error instanceof SupabaseError ? own[error.message] : undefined;
      throw new Error(message ?? friendlyError(error), { cause: error });
    }
    await this.load();
    return this.changed();
  }

  async removeMember(teamId: unknown, userId: unknown): Promise<TeamsView> {
    const team = this.team(teamId);
    if (!team.isOwner) throw new Error(MESSAGES.not_team_owner);
    const member = team.members.find((m) => m.userId === userId && !m.isYou);
    if (!member) throw new Error("Unknown member.");
    return this.teamChange(async (api, token) => {
      const gone = await api.remove(token, "team_members", `team_id=eq.${team.id}&user_id=eq.${member.userId}`);
      if (!gone.length) throw new SupabaseError("not_removed", 403, "42501");
    }, { not_removed: "That member could not be removed. Only the owner can remove members." });
  }

  // A member leaves. An owner first hands the team to another member, or deletes a team they are
  // alone in. The member's checkout on this computer stays; only the link is removed.
  async leaveTeam(teamId: unknown): Promise<TeamsView> {
    const team = this.team(teamId);
    if (team.isOwner) {
      throw new Error(team.members.length > 1 ? "Make another member the owner before you leave." : "You are the only member: delete the team instead.");
    }
    const me = this.userId();
    await this.teamChange(async (api, token) => {
      const gone = await api.remove(token, "team_members", `team_id=eq.${team.id}&user_id=eq.${me}`);
      if (!gone.length) throw new SupabaseError("not_removed", 403, "42501");
    }, { not_removed: "You could not leave this team." });
    this.deps.links.remove((l) => l.teamId === team.id && l.userId === me);
    return this.changed();
  }

  async transferOwnership(teamId: unknown, userId: unknown): Promise<TeamsView> {
    const team = this.team(teamId);
    if (!team.isOwner) throw new Error(MESSAGES.not_team_owner);
    const member = team.members.find((m) => m.userId === userId && !m.isYou);
    if (!member) throw new Error("Choose a member of the team.");
    return this.teamChange((api, token) => api.rpc(token, "transfer_team_ownership", { p_team_id: team.id, p_new_owner: member.userId }), {
      not_a_member: "That person is no longer in the team.", invalid_new_owner: "Choose another member.",
    });
  }

  // Owner, alone in the team: deletes it with its shared projects (checkouts stay on each computer).
  async deleteTeam(teamId: unknown): Promise<TeamsView> {
    const team = this.team(teamId);
    if (!team.isOwner) throw new Error(MESSAGES.not_team_owner);
    if (team.members.length > 1) throw new Error("Remove the other members, or make one of them the owner, first.");
    const me = this.userId();
    await this.teamChange(async (api, token) => {
      const gone = await api.remove(token, "teams", `id=eq.${team.id}`);
      if (!gone.length) throw new SupabaseError("not_removed", 403, "42501");
    }, { not_removed: "The team could not be deleted." });
    this.deps.links.remove((l) => l.teamId === team.id && l.userId === me);
    return this.changed();
  }

  // Owner: removes a shared project from the team, for everyone. Each member's checkout stays on
  // their computer; their link to it goes.
  async removeSharedProject(sharedProjectId: unknown): Promise<TeamsView> {
    if (typeof sharedProjectId !== "string" || !UUID.test(sharedProjectId)) throw new Error("Unknown shared project.");
    const team = this.teams.find((t) => t.projects.some((p) => p.id === sharedProjectId));
    if (!team) throw new Error("Unknown shared project.");
    if (!team.isOwner) throw new Error(MESSAGES.not_team_owner);
    const me = this.userId();
    await this.teamChange(async (api, token) => {
      const gone = await api.remove(token, "shared_projects", `id=eq.${sharedProjectId}`);
      if (!gone.length) throw new SupabaseError("not_removed", 403, "42501");
    }, { not_removed: "Only the team owner can remove a shared project." });
    this.deps.links.remove((l) => l.sharedProjectId === sharedProjectId && l.userId === me);
    return this.changed();
  }

  // The local folder linked to a shared project, for "Open folder". Null when there is none.
  linkedFolder(sharedProjectId: unknown): string | null {
    if (typeof sharedProjectId !== "string") return null;
    return this.myLinks().find((l) => l.sharedProjectId === sharedProjectId)?.path ?? null;
  }
}
