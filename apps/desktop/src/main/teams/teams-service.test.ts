import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gitRunner, readCheckout } from "./git-checkout";
import { LinkStore, SessionStore, type SecretBox } from "./local-store";
import type { PresenceTarget } from "./presence";
import type { FetchLike } from "./supabase-api";
import { TeamsService, type TeamsView } from "./teams-service";

// The Teams flow for two people on two computers, against a stand-in for Supabase that applies the
// same rules as the migration's functions (supabase/tests checks the real database). Checkouts are
// real Git folders.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orq-teams-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function checkout(name: string, remotes: Record<string, string>): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  for (const [remote, url] of Object.entries(remotes)) execFileSync("git", ["-C", dir, "remote", "add", remote, url]);
  return dir;
}

const SERVER = "https://test.supabase.co";
const config = () => ({ ok: true as const, config: { url: SERVER, publishableKey: "sb_publishable_test", source: "test" } });

// ---- A small stand-in for Supabase -----------------------------------------------------------

class FakeSupabase {
  users = new Map<string, string>(); // email -> id
  tokens = new Map<string, { userId: string; expired?: boolean }>();
  refreshTokens = new Map<string, string>(); // refresh token -> user id
  codes = new Map<string, string>(); // email -> code
  teams: { id: string; name: string; owner_id: string; created_at: number }[] = [];
  members: { team_id: string; user_id: string; email: string; role: "owner" | "member" }[] = [];
  invites: { id: string; team_id: string; email: string; code: string; expires_at: number; redeemed_at: string | null; revoked_at: string | null; created_at: number }[] = [];
  projects: { id: string; team_id: string; name: string; repo_owner: string; repo_name: string; repo_key: string }[] = [];
  briefs: { id: string; project_id: string; run_id: string; title: string; status: string; author_id: string; author_name: string; branch: string | null; paths: string[]; updated_at: string; seq: number; outcome: string | null; finished_at: string | null }[] = [];
  reads = new Map<string, number>();
  reservations: { id: string; project_id: string; run_id: string; reserved_by: string; reserved_by_name: string; summary: string; branch: string | null; paths: string[]; expires_at: string }[] = [];
  now = Date.now();
  requests: { method: string; url: string; headers: Record<string, string> }[] = [];
  meta = new Map<string, string>(); // email -> display name
  otpRequests: { email: string; createUser: boolean }[] = [];
  rateLimited = false;
  offline = false;

  fetch: FetchLike = async (url, init) => {
    if (this.offline) throw new Error("offline");
    this.requests.push({ method: init.method, url, headers: init.headers });
    const u = new URL(url);
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const reply = (status: number, value: unknown) => ({ ok: status < 300, status, text: async () => (value === undefined ? "" : JSON.stringify(value)) });
    const pgError = (status: number, code: string, message: string) => reply(status, { code, message, details: null, hint: null });
    if (init.headers.apikey !== "sb_publishable_test") return reply(401, { message: "Invalid API key" });
    if (u.pathname === "/auth/v1/otp") {
      const email = String(body.email);
      // As Supabase: without create_user an unknown address is refused, and nothing is sent.
      if (!this.users.has(email) && body.create_user !== true) return reply(422, { code: 422, error_code: "otp_disabled", msg: "Signups not allowed for otp" });
      if (this.rateLimited) return reply(429, { code: 429, error_code: "over_email_send_rate_limit", msg: "For security purposes, you can only request this after 42 seconds." });
      if (!this.users.has(email)) {
        this.users.set(email, crypto.randomUUID());
        const data = body.data as { display_name?: string } | undefined;
        if (data?.display_name) this.meta.set(email, data.display_name);
      }
      this.otpRequests.push({ email, createUser: body.create_user === true });
      this.codes.set(email, "123456");
      return reply(200, {});
    }
    if (u.pathname === "/auth/v1/user" && init.method === "PUT") {
      const auth = this.tokens.get((init.headers.Authorization ?? "").replace(/^Bearer /, ""));
      if (!auth) return reply(401, { code: 401, msg: "invalid JWT" });
      const email = [...this.users].find(([, id]) => id === auth.userId)![0];
      this.meta.set(email, String((body.data as { display_name?: string }).display_name ?? ""));
      return reply(200, { id: auth.userId, email, user_metadata: { display_name: this.meta.get(email) } });
    }
    if (u.pathname === "/auth/v1/verify") {
      const email = String(body.email);
      if (body.type !== "email" || this.codes.get(email) !== body.token) return reply(403, { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" });
      this.codes.delete(email);
      return reply(200, this.issue(this.users.get(email)!, email));
    }
    if (u.pathname === "/auth/v1/token") {
      const userId = this.refreshTokens.get(String(body.refresh_token));
      if (!userId) return reply(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
      this.refreshTokens.delete(String(body.refresh_token));
      const email = [...this.users].find(([, id]) => id === userId)![0];
      return reply(200, this.issue(userId, email));
    }
    const auth = this.tokens.get((init.headers.Authorization ?? "").replace(/^Bearer /, ""));
    if (!auth) return reply(401, { code: "PGRST301", message: "JWT invalid" });
    if (auth.expired) return reply(401, { code: "PGRST303", message: "JWT expired" });
    const me = auth.userId;
    const myEmail = [...this.users].find(([, id]) => id === me)![0];
    const isMember = (teamId: string) => this.members.some((m) => m.team_id === teamId && m.user_id === me);
    const isOwner = (teamId: string) => this.teams.some((t) => t.id === teamId && t.owner_id === me);
    if (u.pathname === "/auth/v1/logout") return reply(204, undefined);
    if (init.method === "GET" && u.pathname === "/rest/v1/teams") {
      return reply(200, this.teams.filter((t) => isMember(t.id)).map((t) => ({
        id: t.id, name: t.name, owner_id: t.owner_id,
        team_members: this.members.filter((m) => m.team_id === t.id).map(({ user_id, email, role }) => ({ user_id, email, role })),
        shared_projects: this.projects.filter((p) => p.team_id === t.id),
      })));
    }
    if (init.method === "GET" && u.pathname === "/rest/v1/team_invitations") {
      return reply(200, this.invites.filter((i) => isOwner(i.team_id)).map((i) => ({ id: i.id, team_id: i.team_id, email: i.email, expires_at: new Date(i.expires_at).toISOString(), redeemed_at: i.redeemed_at, revoked_at: i.revoked_at })));
    }
    if (u.pathname === "/rest/v1/rpc/team_catch_up") {
      const projectId = String(body.p_project_id);
      const project = this.projects.find((p) => p.id === projectId);
      if (!project || !isMember(project.team_id)) return pgError(403, "42501", "not_project_member");
      return reply(200, this.briefs.filter((b) => b.project_id === projectId && b.author_id !== me && (this.reads.get(`${me}:${b.id}`) ?? 0) < b.seq)
        .map((b) => ({ brief_id: b.id, run_id: b.run_id, author_id: b.author_id, author_name: b.author_name, title: b.title, status: b.status, branch: b.branch, paths: b.paths, outcome: b.outcome, seq: b.seq, seen_seq: this.reads.get(`${me}:${b.id}`) ?? null, updated_at: b.updated_at, finished_at: b.finished_at })));
    }
    if (u.pathname === "/rest/v1/rpc/mark_briefs_seen") {
      const projectId = String(body.p_project_id);
      const project = this.projects.find((p) => p.id === projectId);
      if (!project || !isMember(project.team_id)) return pgError(403, "42501", "not_project_member");
      for (const i of body.p_items as { id: string; seq: number }[]) {
        const b = this.briefs.find((x) => x.id === i.id && x.project_id === projectId);
        if (b) this.reads.set(`${me}:${b.id}`, Math.max(this.reads.get(`${me}:${b.id}`) ?? 0, Math.min(i.seq, b.seq)));
      }
      return reply(200, 1);
    }
    if (init.method === "GET" && u.pathname === "/rest/v1/task_reservations") {
      const memberOf = (projectId: string) => this.projects.some((p) => p.id === projectId && isMember(p.team_id));
      return reply(200, this.reservations.filter((r) => memberOf(r.project_id)));
    }
    if (init.method === "GET" && u.pathname === "/rest/v1/work_briefs" && u.searchParams.get("author_id")) {
      const author = u.searchParams.get("author_id")!.replace(/^eq\./, "");
      const projectId = u.searchParams.get("project_id")!.replace(/^eq\./, "");
      const project = this.projects.find((p) => p.id === projectId);
      if (!project || !isMember(project.team_id)) return reply(200, []);
      return reply(200, this.briefs.filter((b) => b.project_id === projectId && b.author_id === author));
    }
    if (init.method === "GET" && u.pathname === "/rest/v1/work_briefs") {
      const memberOf = (projectId: string) => this.projects.some((p) => p.id === projectId && isMember(p.team_id));
      return reply(200, this.briefs.filter((b) => memberOf(b.project_id) && ["in_progress", "blocked"].includes(b.status)));
    }
    if (init.method === "POST" && u.pathname === "/rest/v1/shared_projects") {
      const teamId = String(body.team_id);
      if (!isOwner(teamId)) return pgError(403, "42501", 'new row violates row-level security policy for table "shared_projects"');
      const repo_key = `github.com/${body.repo_owner}/${body.repo_name}`.toLowerCase();
      if (this.projects.some((p) => p.team_id === teamId && p.repo_key === repo_key)) return pgError(409, "23505", "duplicate key value violates unique constraint");
      const row = { id: crypto.randomUUID(), team_id: teamId, name: String(body.name), repo_owner: String(body.repo_owner), repo_name: String(body.repo_name), repo_key };
      this.projects.push(row);
      return reply(201, [{ id: row.id, repo_key }]);
    }
    if (u.pathname === "/rest/v1/rpc/create_team") {
      const id = crypto.randomUUID();
      this.teams.push({ id, name: String(body.p_name).trim(), owner_id: me, created_at: this.now });
      this.members.push({ team_id: id, user_id: me, email: myEmail, role: "owner" });
      return reply(200, id);
    }
    if (u.pathname === "/rest/v1/rpc/create_invitation") {
      const teamId = String(body.p_team_id);
      if (!isOwner(teamId)) return pgError(403, "42501", "not_team_owner");
      const email = String(body.p_email).trim().toLowerCase();
      for (const i of this.invites) if (i.team_id === teamId && i.email === email && !i.redeemed_at && !i.revoked_at) i.revoked_at = new Date(this.now).toISOString();
      const raw = crypto.randomBytes(12).toString("hex").toUpperCase();
      const code = raw.match(/.{6}/g)!.join("-");
      const inv = { id: crypto.randomUUID(), team_id: teamId, email, code: raw, expires_at: this.now + 72 * 3600_000, redeemed_at: null, revoked_at: null, created_at: this.now };
      this.invites.push(inv);
      return reply(200, [{ invitation_id: inv.id, code, email, expires_at: new Date(inv.expires_at).toISOString() }]);
    }
    if (u.pathname === "/rest/v1/rpc/revoke_invitation") {
      const inv = this.invites.find((i) => i.id === body.p_invitation_id && isOwner(i.team_id));
      if (!inv) return pgError(404, "P0002", "invite_not_found");
      if (!inv.redeemed_at) inv.revoked_at ??= new Date(this.now).toISOString();
      return reply(204, undefined);
    }
    if (u.pathname === "/rest/v1/rpc/redeem_invitation") {
      const code = String(body.p_code).replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
      const inv = this.invites.find((i) => i.code === code);
      if (!inv) return pgError(404, "P0002", "invite_not_found");
      if (inv.revoked_at) return pgError(400, "P0001", "invite_revoked");
      if (inv.redeemed_at) return pgError(400, "P0001", "invite_used");
      if (inv.expires_at <= this.now) return pgError(400, "P0001", "invite_expired");
      if (inv.email !== myEmail) return pgError(403, "42501", "invite_wrong_email");
      this.members.push({ team_id: inv.team_id, user_id: me, email: myEmail, role: "member" });
      inv.redeemed_at = new Date(this.now).toISOString();
      return reply(200, inv.team_id);
    }
    return reply(404, { message: `No route ${init.method} ${u.pathname}` });
  };

  private issue(userId: string, email: string) {
    const access = crypto.randomUUID();
    const refresh = crypto.randomUUID();
    this.tokens.set(access, { userId });
    this.refreshTokens.set(refresh, userId);
    const name = this.meta.get(email);
    return { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "bearer", user: { id: userId, email, user_metadata: name ? { display_name: name } : {} } };
  }
}

const box: SecretBox = {
  available: () => true,
  encrypt: (text) => Buffer.from(`enc:${Buffer.from(text).toString("base64")}`),
  decrypt: (data) => Buffer.from(data.toString().replace(/^enc:/, ""), "base64").toString(),
};

// One "computer": its own user-data folder and its own Teams service.
function computer(name: string, server: FakeSupabase, now = () => server.now) {
  const dir = path.join(tmp, `userdata-${name}-${crypto.randomUUID()}`);
  const make = () => {
    const events: TeamsView[] = [];
    const targets: PresenceTarget[][] = [];
    const service = new TeamsService({
      config,
      fetch: server.fetch,
      sessions: new SessionStore(path.join(dir, "session.bin"), box),
      links: new LinkStore(path.join(dir, "links.json")),
      git: gitRunner(() => process.env),
      emit: (v) => events.push(v),
      onPresenceTargets: (t) => targets.push(t),
      now,
      caseInsensitivePaths: process.platform !== "linux",
    });
    return { service, events, targets };
  };
  return { dir, ...make(), restart: make };
}

// Signs in, creating the account if needed (the tests' people are new to the stand-in server).
async function signIn(service: TeamsService, email: string) {
  await service.sendCode(email, { mode: "register", displayName: email.split("@")[0] });
  return service.verifyCode("123 456");
}

describe("Teams, phase 1", () => {
  let server: FakeSupabase;
  beforeEach(() => {
    server = new FakeSupabase();
  });

  it("shows a setup state when Supabase is not configured", () => {
    const service = new TeamsService({
      config: () => ({ ok: false, problem: null }),
      fetch: server.fetch,
      sessions: new SessionStore(path.join(tmp, "none", "s.bin"), box),
      links: new LinkStore(path.join(tmp, "none", "l.json")),
      git: gitRunner(() => process.env),
      emit: () => {},
    });
    expect(service.view()).toMatchObject({ status: "unconfigured", configProblem: null, teams: [] });
    return expect(service.sendCode("a@example.test")).rejects.toThrow(/not set up/);
  });

  it("signs in with an email code, sends the key as apikey only, and refuses a wrong code", async () => {
    const a = computer("a", server);
    await a.service.sendCode("A@Example.test", { mode: "register", displayName: "Ann" });
    expect(a.service.view()).toMatchObject({ status: "code_sent", pendingEmail: "a@example.test" });
    await expect(a.service.verifyCode("999999")).rejects.toThrow(/wrong or has expired/);
    await expect(a.service.verifyCode("abc")).rejects.toThrow(/only digits/);
    const view = await a.service.verifyCode("123456");
    expect(view).toMatchObject({ status: "signed_in", email: "a@example.test", teams: [] });
    for (const r of server.requests) {
      expect(r.headers.apikey).toBe("sb_publishable_test");
      expect(r.headers.Authorization ?? "").not.toContain("sb_publishable");
    }
    // The session on disk is the encrypted form.
    expect(fs.readFileSync(path.join(a.dir, "session.bin"), "utf8")).toMatch(/^enc:/);
  });

  it("runs the whole two-person flow and keeps the links after a restart", async () => {
    const sshClone = checkout("a-ssh", { origin: "git@github.com:SEASTICK/orq-test.git" });
    const httpsClone = checkout("b-https", { origin: "https://github.com/seastick/orq-test.git" });
    const otherRepo = checkout("b-other", { origin: "https://github.com/seastick/something-else.git" });
    const a = computer("a", server);
    const b = computer("b", server);
    const c = computer("c", server);

    // A creates the team and registers the SSH clone.
    await signIn(a.service, "a@example.test");
    let view = await a.service.createTeam("  Orq team ");
    const team = view.teams[0]!;
    expect(team).toMatchObject({ name: "Orq team", isOwner: true, members: [{ email: "a@example.test", role: "owner", isYou: true }] });
    const pickA = await a.service.inspectFolder(sshClone);
    expect(pickA.repo).toMatchObject({ owner: "SEASTICK", name: "orq-test", key: "github.com/seastick/orq-test", remote: "origin" });
    view = await a.service.registerProject({ teamId: team.id, selectionId: pickA.id, localProjectId: "local-a", name: "Orq test" });
    const project = view.teams[0]!.projects[0]!;
    expect(project).toMatchObject({ name: "Orq test", repo: { key: "github.com/seastick/orq-test" }, link: { localProjectId: "local-a", state: "linked" } });
    // Only the repository identity went to the server, never the folder.
    expect(JSON.stringify(server.projects)).not.toContain("a-ssh");

    // The same repository cannot be registered twice, even from another clone or spelling.
    const again = await a.service.inspectFolder(httpsClone);
    await expect(a.service.registerProject({ teamId: team.id, selectionId: again.id, localProjectId: "local-a2", name: "Again" })).rejects.toThrow(/already a shared project/);

    // A invites B.
    const { invite } = await a.service.createInvite(team.id, "B@example.test");
    expect(invite.code).toMatch(/^[0-9A-F]{6}(-[0-9A-F]{6}){3}$/);
    expect(invite.shareText).toContain(invite.code);
    expect(a.service.inviteText(invite.id)).toBe(invite.shareText);
    expect(a.service.view().teams[0]!.invites[0]).toMatchObject({ email: "b@example.test", state: "pending" });

    // C has the code but signed in with another address: refused, and C sees nothing.
    await signIn(c.service, "c@example.test");
    await expect(c.service.acceptInvite(invite.code)).rejects.toThrow(/different email address/);
    expect((await c.service.refresh()).teams).toEqual([]);
    await expect(c.service.linkCheckout({ sharedProjectId: project.id, selectionId: "x", localProjectId: "local-c" })).rejects.toThrow(/Unknown shared project/);

    // B accepts and links the HTTPS clone; a different repository is rejected.
    await signIn(b.service, "b@example.test");
    view = await b.service.acceptInvite(invite.code.toLowerCase());
    expect(view.teams[0]).toMatchObject({ name: "Orq team", isOwner: false, invites: [] });
    expect(view.teams[0]!.members.map((m) => m.email)).toEqual(["a@example.test", "b@example.test"]);
    expect(view.teams[0]!.projects[0]!.link).toBeNull();
    const wrong = await b.service.inspectFolder(otherRepo);
    await expect(b.service.linkCheckout({ sharedProjectId: project.id, selectionId: wrong.id, localProjectId: "local-b" })).rejects.toThrow(/not SEASTICK\/orq-test: it points to seastick\/something-else/);
    await expect(b.service.registerProject({ teamId: team.id, selectionId: wrong.id, localProjectId: "local-b", name: "x" })).rejects.toThrow(/Only the team owner/);
    const pickB = await b.service.inspectFolder(httpsClone);
    view = await b.service.linkCheckout({ sharedProjectId: project.id, selectionId: pickB.id, localProjectId: "local-b" });
    expect(view.teams[0]!.projects[0]!.link).toMatchObject({ localProjectId: "local-b", state: "linked", path: path.resolve((await readCheckout(httpsClone, gitRunner(() => process.env)) as { facts: { root: string } }).facts.root) });

    // The code cannot be used again.
    await expect(b.service.acceptInvite(invite.code)).rejects.toThrow(/already been used/);

    // After a restart both computers are still signed in and linked.
    const b2 = b.restart().service;
    view = await b2.refresh();
    expect(view).toMatchObject({ status: "signed_in", email: "b@example.test" });
    expect(view.teams[0]!.projects[0]!.link).toMatchObject({ localProjectId: "local-b", state: "linked" });
    const a2 = a.restart().service;
    expect((await a2.refresh()).teams[0]!.projects[0]!.link).toMatchObject({ localProjectId: "local-a", state: "linked" });
    // Codes are not kept anywhere after a restart.
    expect(() => a2.inviteText(invite.id)).toThrow(/no longer available/);

    // A changed or missing folder is reported, not silently trusted.
    execFileSync("git", ["-C", httpsClone, "remote", "set-url", "origin", "https://github.com/seastick/something-else.git"]);
    expect((await b2.refresh()).teams[0]!.projects[0]!.link).toMatchObject({ state: "mismatch" });
    fs.rmSync(sshClone, { recursive: true, force: true });
    expect((await a2.refresh()).teams[0]!.projects[0]!.link).toMatchObject({ state: "missing" });
  });

  it("refuses revoked and expired invites", async () => {
    const a = computer("a", server);
    const b = computer("b", server);
    await signIn(a.service, "a@example.test");
    const teamId = (await a.service.createTeam("T")).teams[0]!.id;
    const first = (await a.service.createInvite(teamId, "b@example.test")).invite;
    const second = (await a.service.createInvite(teamId, "b@example.test")).invite;
    expect(a.service.view().teams[0]!.invites.map((i) => i.state)).toEqual(["revoked", "pending"]);
    await a.service.revokeInvite(second.id);
    await signIn(b.service, "b@example.test");
    await expect(b.service.acceptInvite(first.code)).rejects.toThrow(/withdrawn/);
    await expect(b.service.acceptInvite(second.code)).rejects.toThrow(/withdrawn/);
    const third = (await a.service.createInvite(teamId, "b@example.test")).invite;
    server.now += 73 * 3600_000;
    await expect(b.service.acceptInvite(third.code)).rejects.toThrow(/expired/);
    await expect(b.service.acceptInvite("not-a-code")).rejects.toThrow(/24 letters and digits/);
    expect((await b.service.refresh()).teams).toEqual([]);
  });

  it("asks which remote to use when a checkout's remotes disagree", async () => {
    const fork = checkout("fork", { origin: "git@github.com:me/orq-fork.git", upstream: "https://github.com/seastick/orq.git" });
    const none = checkout("none", {});
    const a = computer("a", server);
    await signIn(a.service, "a@example.test");
    const teamId = (await a.service.createTeam("T")).teams[0]!.id;
    const pick = await a.service.inspectFolder(fork);
    expect(pick).toMatchObject({ repo: null, needsRemoteChoice: true });
    await expect(a.service.registerProject({ teamId, selectionId: pick.id, localProjectId: "p", name: "Orq" })).rejects.toThrow(/Choose the remote/);
    expect(a.service.describeSelection(pick.id, "upstream").repo).toMatchObject({ key: "github.com/seastick/orq", remote: "upstream" });
    const view = await a.service.registerProject({ teamId, selectionId: pick.id, remote: "upstream", localProjectId: "p", name: "Orq" });
    expect(view.teams[0]!.projects[0]!.repo.key).toBe("github.com/seastick/orq");
    expect((await a.service.inspectFolder(none)).problem).toMatch(/no Git remote/);
    expect((await a.service.inspectFolder(path.join(tmp, "does-not-exist"))).problem).toMatch(/not a Git checkout/);
  });

  it("refreshes an expired token once, and signs out when the session is over", async () => {
    let now = server.now;
    const a = computer("a", server, () => now);
    await signIn(a.service, "a@example.test");
    await a.service.createTeam("T");
    now += 2 * 3600_000;
    expect((await a.service.refresh()).teams).toHaveLength(1);
    expect(server.requests.some((r) => r.url.includes("grant_type=refresh_token"))).toBe(true);
    // The server forgets every session: the next refresh is refused and Teams signs out.
    server.refreshTokens.clear();
    now += 2 * 3600_000;
    const view = await a.service.refresh();
    expect(view.status).toBe("signed_out");
    expect(fs.existsSync(path.join(a.dir, "session.bin"))).toBe(false);
  });

  it("signs out locally even when the server cannot be reached", async () => {
    const a = computer("a", server);
    await signIn(a.service, "a@example.test");
    server.offline = true;
    expect((await a.service.signOut()).status).toBe("signed_out");
    expect(a.restart().service.view().status).toBe("signed_out");
  });
});

describe("Teams, phase 2", () => {
  it("watches presence for every shared project of my teams, and stops on sign-out", async () => {
    const server = new FakeSupabase();
    const a = computer("a", server);
    const b = computer("b", server);
    await signIn(a.service, "a@example.test");
    const teamId = (await a.service.createTeam("T")).teams[0]!.id;
    const pick = await a.service.inspectFolder(checkout("p2-a", { origin: "https://github.com/seastick/p2.git" }));
    const project = (await a.service.registerProject({ teamId, selectionId: pick.id, localProjectId: "la", name: "P2" })).teams[0]!.projects[0]!;
    const code = (await a.service.createInvite(teamId, "b@example.test")).invite.code;
    await signIn(b.service, "b@example.test");
    const viewB = await b.service.acceptInvite(code);
    const ids = Object.fromEntries(viewB.teams[0]!.members.map((m) => [m.email, m.userId]));
    expect(b.targets.at(-1)).toEqual([{ projectId: project.id, selfId: ids["b@example.test"], memberIds: [ids["a@example.test"], ids["b@example.test"]] }]);
    expect(viewB.userId).toBe(ids["b@example.test"]);
    // Presence shows up in the view, and is cleared when signing out.
    b.service.setPresence({ [project.id]: { connection: "live", online: [ids["a@example.test"]!], publishing: true, problem: null } });
    expect(b.service.view().presence[project.id]!.online).toEqual([ids["a@example.test"]]);
    expect(b.targets.length).toBeGreaterThan(0);
    const before = b.targets.length;
    b.service.setPresence({});
    expect(b.targets.length).toBe(before); // presence updates do not re-send unchanged targets
    await b.service.signOut();
    expect(b.targets.at(-1)).toEqual([]);
    expect(b.service.view().presence).toEqual({});
  });

  it("reads open briefs as active work, and shows none when there are none", async () => {
    const server = new FakeSupabase();
    const a = computer("a", server);
    await signIn(a.service, "a@example.test");
    const teamId = (await a.service.createTeam("T")).teams[0]!.id;
    const pick = await a.service.inspectFolder(checkout("p2-b", { origin: "https://github.com/seastick/p2b.git" }));
    const project = (await a.service.registerProject({ teamId, selectionId: pick.id, localProjectId: "la", name: "P" })).teams[0]!.projects[0]!;
    expect(project.briefs).toEqual([]);
    const me = a.service.view().userId!;
    server.briefs.push({ id: "b1", project_id: project.id, run_id: "r1", title: "Login page", status: "in_progress", author_id: me, author_name: "a", branch: "main", paths: ["src/login.tsx"], updated_at: "2026-11-18T10:00:00Z", seq: 1, outcome: null, finished_at: null });
    server.briefs.push({ id: "b2", project_id: project.id, run_id: "r2", title: "Old", status: "completed", author_id: me, author_name: "a", branch: null, paths: [], updated_at: "2026-11-17T10:00:00Z", seq: 2, outcome: "done", finished_at: "2026-11-17T10:00:00Z" });
    const view = await a.service.refresh();
    expect(view.teams[0]!.projects[0]!.briefs).toEqual([{ id: "b1", runId: "r1", title: "Login page", status: "in_progress", authorId: me, authorName: "a", branch: "main", paths: ["src/login.tsx"], updatedAt: "2026-11-18T10:00:00Z" }]);
    expect(view.briefsAt[project.id]).toBeGreaterThan(0);
    // A finished run leaves Active work on the next read.
    server.briefs[0]!.status = "completed";
    await a.service.refreshBriefs(project.id);
    expect(a.service.view().teams[0]!.projects[0]!.briefs).toEqual([]);
  });
});

describe("Teams, phase 4", () => {
  async function twoPeople() {
    const server = new FakeSupabase();
    const a = computer("a", server);
    const b = computer("b", server);
    await signIn(a.service, "a@example.test");
    const teamId = (await a.service.createTeam("T")).teams[0]!.id;
    const pick = await a.service.inspectFolder(checkout(`p4-${crypto.randomUUID().slice(0, 6)}`, { origin: `https://github.com/seastick/p4-${crypto.randomUUID().slice(0, 6)}.git` }));
    const project = (await a.service.registerProject({ teamId, selectionId: pick.id, localProjectId: "la", name: "P" })).teams[0]!.projects[0]!;
    const code = (await a.service.createInvite(teamId, "b@example.test")).invite.code;
    await signIn(b.service, "b@example.test");
    await b.service.acceptInvite(code);
    const aId = a.service.view().userId!;
    const bId = b.service.view().userId!;
    return { server, a, b, project, aId, bId };
  }

  it("catches up on a teammate's unseen revisions once, and again only when a brief changes", async () => {
    const { server, b, project, aId } = await twoPeople();
    server.briefs.push({ id: crypto.randomUUID(), project_id: project.id, run_id: "r1", title: "Login", status: "completed", author_id: aId, author_name: "a", branch: "main", paths: ["src/a.ts"], updated_at: "2026-11-19T09:00:00Z", seq: 3, outcome: "2 of 2 tasks finished.", finished_at: "2026-11-19T09:00:00Z" });
    const first = await b.service.catchUp(project.id);
    expect(first.ok && first.items.map((i) => [i.title, i.status, i.seq, i.outcome])).toEqual([["Login", "completed", 3, "2 of 2 tasks finished."]]);
    // Not marked yet (for example the app closed before the message was saved): still eligible.
    expect(((await b.service.catchUp(project.id)) as { items: unknown[] }).items).toHaveLength(1);
    expect(await b.service.markSeen(project.id, first.ok ? first.items.map((i) => ({ id: i.id, seq: i.seq })) : [])).toBe(true);
    expect(((await b.service.catchUp(project.id)) as { items: unknown[] }).items).toHaveLength(0);
    // A new revision of the same brief is eligible again.
    server.briefs[0]!.seq = 4;
    expect(((await b.service.catchUp(project.id)) as { items: { seenSeq: number }[] }).items[0]!.seenSeq).toBe(3);
  });

  it("never includes my own briefs, and reports an unreachable server instead of an empty catch-up", async () => {
    const { server, a, project, aId } = await twoPeople();
    server.briefs.push({ id: crypto.randomUUID(), project_id: project.id, run_id: "mine", title: "Mine", status: "in_progress", author_id: aId, author_name: "a", branch: null, paths: [], updated_at: "2026-11-19T09:00:00Z", seq: 1, outcome: null, finished_at: null });
    expect(await a.service.catchUp(project.id)).toMatchObject({ ok: true, items: [] });
    server.offline = true;
    expect(await a.service.catchUp(project.id)).toMatchObject({ ok: false });
    expect(await a.service.markSeen(project.id, [{ id: server.briefs[0]!.id, seq: 1 }])).toBe(false);
  });

  it("returns one teammate's current work, and refuses other projects and other people", async () => {
    const { server, b, project, aId } = await twoPeople();
    server.briefs.push({ id: crypto.randomUUID(), project_id: project.id, run_id: "r1", title: "Login", status: "in_progress", author_id: aId, author_name: "a", branch: "feature/x", paths: ["src/a.ts"], updated_at: "2026-11-19T09:00:00Z", seq: 2, outcome: null, finished_at: null });
    const work = await b.service.teammateWork(project.id, aId);
    expect(work.ok && work.items.map((i) => [i.title, i.branch, i.paths])).toEqual([["Login", "feature/x", ["src/a.ts"]]]);
    const other = crypto.randomUUID();
    await expect(b.service.teammateWork(other, aId)).rejects.toThrow(/Unknown shared project/);
    await expect(b.service.teammateWork(project.id, crypto.randomUUID())).rejects.toThrow(/Unknown teammate/);
    expect(await b.service.catchUp(other)).toMatchObject({ ok: false, problem: "Unknown shared project." });
    await expect(b.service.markSeen(other, [])).rejects.toThrow(/Unknown shared project/);
    // After signing out, nothing of the project is available.
    await b.service.signOut();
    expect(await b.service.catchUp(project.id)).toMatchObject({ ok: false });
  });
});

describe("Teams, phase 5", () => {
  it("shows active reservations of the project in the view, and nothing from projects I am not in", async () => {
    const server = new FakeSupabase();
    const a = computer("a", server);
    await signIn(a.service, "a@example.test");
    const teamId = (await a.service.createTeam("T")).teams[0]!.id;
    const pick = await a.service.inspectFolder(checkout(`p5-${crypto.randomUUID().slice(0, 6)}`, { origin: `https://github.com/seastick/p5-${crypto.randomUUID().slice(0, 6)}.git` }));
    const project = (await a.service.registerProject({ teamId, selectionId: pick.id, localProjectId: "la", name: "P" })).teams[0]!.projects[0]!;
    expect(project.reservations).toEqual([]);
    const later = new Date(server.now + 120_000).toISOString();
    server.reservations.push({ id: "r1", project_id: project.id, run_id: "plan-1", reserved_by: "philip", reserved_by_name: "philip", summary: "Rework sign-in", branch: "feature/auth", paths: ["src/auth/"], expires_at: later });
    server.reservations.push({ id: "r2", project_id: crypto.randomUUID(), run_id: "x", reserved_by: "z", reserved_by_name: "z", summary: "Elsewhere", branch: null, paths: ["a/"], expires_at: later });
    await a.service.refreshBriefs(project.id);
    expect(a.service.view().teams[0]!.projects[0]!.reservations).toEqual([{ id: "r1", runId: "plan-1", userId: "philip", name: "philip", task: "Rework sign-in", branch: "feature/auth", paths: ["src/auth/"], expiresAt: later }]);
    await expect(a.service.reservationRpc("drop_everything", {})).rejects.toThrow(/Unknown reservation call/);
  });
});

describe("0rqestra account", () => {
  it("creates an account with a display name, and signing in never creates one", async () => {
    const server = new FakeSupabase();
    const a = computer("acct", server);
    await expect(a.service.sendCode("new@example.test")).rejects.toThrow(/There is no 0rqestra account for new@example.test. Choose Create account/);
    expect(server.users.has("new@example.test")).toBe(false);
    expect(a.service.view()).toMatchObject({ status: "signed_out" });
    await expect(a.service.sendCode("new@example.test", { mode: "register", displayName: "  " })).rejects.toThrow(/display name/);
    await a.service.sendCode("new@example.test", { mode: "register", displayName: "Ann Persson" });
    expect(a.service.view()).toMatchObject({ status: "code_sent", pendingEmail: "new@example.test", pendingMode: "register" });
    await expect(a.service.verifyCode("000000")).rejects.toThrow(/wrong or has expired/);
    // The email is kept after a wrong code, so the user can try again.
    expect(a.service.view().pendingEmail).toBe("new@example.test");
    const v = await a.service.verifyCode("123456");
    expect(v).toMatchObject({ status: "signed_in", email: "new@example.test", displayName: "Ann Persson" });
    expect(server.meta.get("new@example.test")).toBe("Ann Persson");
    // Signed out, the same address signs in (no new account).
    await a.service.signOut();
    await a.service.sendCode("new@example.test");
    expect(server.otpRequests.at(-1)).toEqual({ email: "new@example.test", createUser: false });
    expect((await a.service.verifyCode("123456")).displayName).toBe("Ann Persson");
    // The display name and session survive a restart, with the token only in the encrypted file.
    const again = a.restart().service.view();
    expect(again).toMatchObject({ status: "signed_in", displayName: "Ann Persson" });
  });

  it("enforces a resend cooldown, and takes Supabase's own wait when it gives one", async () => {
    const server = new FakeSupabase();
    let now = 1_000_000;
    const a = computer("cool", server, () => now);
    await a.service.sendCode("c@example.test", { mode: "register", displayName: "C" });
    expect(a.service.view().resendAt).toBe(now + 60_000);
    await expect(a.service.sendCode("c@example.test", { mode: "register" })).rejects.toThrow(/in 60 seconds/);
    now += 61_000;
    // A resend without the name keeps the name given first.
    await a.service.sendCode("c@example.test", { mode: "register" });
    server.rateLimited = true;
    now += 61_000;
    await expect(a.service.sendCode("c@example.test", { mode: "register" })).rejects.toThrow(/in 42 seconds/);
    expect(a.service.view()).toMatchObject({ status: "code_sent", pendingEmail: "c@example.test", resendAt: now + 42_000 });
    server.rateLimited = false;
    expect((await a.service.verifyCode("123456")).displayName).toBe("C");
  });

  it("asks to sign in again when Supabase ends the session, and keeps working offline otherwise", async () => {
    const server = new FakeSupabase();
    let now = server.now;
    const a = computer("end", server, () => now);
    await signIn(a.service, "e@example.test");
    // Offline at startup: the saved session still opens the app as signed in.
    server.offline = true;
    const offline = a.restart().service;
    expect(offline.view()).toMatchObject({ status: "signed_in", sessionEnded: null });
    now += 2 * 3600_000;
    expect((await offline.refresh()).status).toBe("signed_in"); // a network failure does not end it
    server.offline = false;
    server.refreshTokens.clear(); // revoked on the server
    const v = await offline.refresh();
    expect(v.status).toBe("signed_out");
    expect(v.sessionEnded).toMatch(/session has ended/);
  });

  it("switching accounts clears the previous account's teams from the view", async () => {
    const server = new FakeSupabase();
    const a = computer("switch", server);
    await signIn(a.service, "first@example.test");
    await a.service.createTeam("First's team");
    expect(a.service.view().teams).toHaveLength(1);
    await a.service.signOut();
    expect(a.service.view()).toMatchObject({ status: "signed_out", teams: [], presence: {}, displayName: null });
    const v = await signIn(a.service, "second@example.test");
    expect(v).toMatchObject({ email: "second@example.test", teams: [] });
  });
});
