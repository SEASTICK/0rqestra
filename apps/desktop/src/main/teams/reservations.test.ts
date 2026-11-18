import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Plan } from "../team/plan";
import { ReservationCoordinator, covered, normalizeRepoPath, pathsOverlap, type Gate } from "./reservations";

describe("repository paths", () => {
  it("normalizes Windows separators and rejects absolute paths and traversal", () => {
    expect(normalizeRepoPath("src\\auth\\session.ts")).toBe("src/auth/session.ts");
    expect(normalizeRepoPath("./src//ui/")).toBe("src/ui/");
    for (const bad of ["C:\\repo\\a.ts", "c:/x", "/etc/passwd", "~/x", "../up", "src/../x", "src/./x", "", "a b"]) expect(normalizeRepoPath(bad), bad).toBeNull();
  });

  it("finds overlap between the same path and a folder and its contents, without case, and nothing else", () => {
    expect(pathsOverlap("src/auth/", "src/auth/session.ts")).toBe(true);
    expect(pathsOverlap("src/auth/session.ts", "SRC/Auth/")).toBe(true);
    expect(pathsOverlap("src/auth/session.ts", "src/auth/session.ts")).toBe(true);
    expect(pathsOverlap("src/auth/", "src/auth-old/")).toBe(false);
    expect(pathsOverlap("src/auth/", "src/ui/")).toBe(false);
    expect(pathsOverlap("src/auth", "src/authx.ts")).toBe(false);
    expect(covered("src/auth/a.ts", ["src/auth/"])).toBe(true);
    expect(covered("src/auth-old/a.ts", ["src/auth/"])).toBe(false);
  });
});

// A stand-in for the database functions, with the same rules: one project, server time, leases.
class FakeServer {
  rows: { id: string; user: string; name: string; run: string; task: string; branch: string | null; paths: string[]; status: string; token: string; expires: number }[] = [];
  now = 1_000_000;
  down = false;
  calls: string[] = [];
  forUser(user: string) {
    return async (fn: string, a: Record<string, unknown>): Promise<unknown> => {
      this.calls.push(fn);
      if (this.down) throw new Error("Could not reach the Teams server.");
      const iso = (t: number) => new Date(t).toISOString();
      const ttl = Number(a.p_ttl_seconds ?? 120) * 1000;
      const expire = () => this.rows.forEach((r) => { if (r.status === "active" && r.expires <= this.now) r.status = "expired"; });
      const conflicts = (paths: string[], exclude?: string) => this.rows.filter((r) => r.status === "active" && r.expires > this.now && r.id !== exclude)
        .map((r) => ({ name: r.name, task: r.task, branch: r.branch, overlaps: paths.flatMap((y) => r.paths.filter((t) => pathsOverlap(y, t)).map((t) => ({ yours: y, theirs: t }))) }))
        .filter((c) => c.overlaps.length);
      const held = (id: unknown, token: unknown) => this.rows.find((r) => r.id === id && r.user === user && r.token === token && r.status === "active" && r.expires > this.now);
      if (fn === "acquire_reservation") {
        expire();
        const mine = this.rows.find((r) => r.user === user && r.run === a.p_run_id && r.status === "active");
        if (mine) { mine.expires = this.now + ttl; return { status: "granted", reservation_id: mine.id, lease_token: mine.token, paths: mine.paths, expires_at: iso(mine.expires), server_now: iso(this.now) }; }
        const c = conflicts(a.p_paths as string[]);
        if (c.length) return { status: "conflict", conflicts: c, server_now: iso(this.now) };
        const row = { id: crypto.randomUUID(), user, name: user, run: String(a.p_run_id), task: String(a.p_summary), branch: (a.p_branch as string) ?? null, paths: a.p_paths as string[], status: "active", token: crypto.randomUUID(), expires: this.now + ttl };
        this.rows.push(row);
        return { status: "granted", reservation_id: row.id, lease_token: row.token, paths: row.paths, expires_at: iso(row.expires), server_now: iso(this.now) };
      }
      if (fn === "renew_reservation") {
        const r = held(a.p_reservation_id, a.p_lease_token);
        if (!r) return { status: "lost", server_now: iso(this.now) };
        r.expires = this.now + ttl;
        return { status: "renewed", expires_at: iso(r.expires), server_now: iso(this.now) };
      }
      if (fn === "expand_reservation") {
        const r = held(a.p_reservation_id, a.p_lease_token);
        if (!r) return { status: "lost", server_now: iso(this.now) };
        expire();
        const add = (a.p_paths as string[]).filter((p) => !covered(p, r.paths));
        const c = conflicts(add, r.id);
        if (c.length) return { status: "conflict", conflicts: c, server_now: iso(this.now) };
        r.paths = [...r.paths, ...add];
        return { status: "expanded", paths: r.paths, expires_at: iso(r.expires), server_now: iso(this.now) };
      }
      if (fn === "release_reservation") {
        const r = this.rows.find((x) => x.id === a.p_reservation_id && x.user === user && x.token === a.p_lease_token);
        if (!r) return { status: "not_owner" };
        if (r.status === "active") r.status = "released";
        return { status: "released" };
      }
      throw new Error(fn);
    };
  }
}

const plan = (files: string[], goal = "Rework sign-in"): Plan => ({ goal, tasks: [{ id: "t1", title: "x", role: "Builder", goal: "y", dependsOn: [], deliverables: files }] });

function person(server: FakeServer, user: string, linked = true) {
  const timers: { fn: () => void; at: number }[] = [];
  const c = new ReservationCoordinator({
    rpc: server.forUser(user),
    linkFor: (id) => (linked && id === "local" ? { sharedProjectId: "shared", userId: user, path: "C:\\work\\repo" } : null),
    branchOf: async () => (user === "philip" ? "feature/auth" : "main"),
    now: () => server.now,
    setTimer: (fn, ms) => { const t = { fn, at: server.now + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); },
    sleep: async (ms) => { server.now += ms; },
    ttlSeconds: 120,
    waitForLeaseMs: 30_000,
  });
  const tick = async (ms: number) => {
    server.now += ms;
    for (const t of timers.filter((x) => x.at <= server.now)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    await new Promise((r) => setTimeout(r, 0));
  };
  return { c, tick };
}
const start = (p: ReturnType<typeof person>, runId: string, files: string[]) => p.c.beforeStart({ runId, localProjectId: "local", plan: plan(files) });
const guardOf = (g: Gate) => { if (g.kind !== "granted") throw new Error(`not granted: ${g.kind}`); return g.guard; };

describe("reservations", () => {
  it("lets a solo project run without coordination", async () => {
    const server = new FakeServer();
    expect((await person(server, "me", false).c.beforeStart({ runId: "r", localProjectId: "local", plan: plan(["a.ts"]) })).kind).toBe("solo");
    expect(server.calls).toEqual([]);
  });

  it("blocks an overlapping run with the teammate's name, task and paths, across branches; others start", async () => {
    const server = new FakeServer();
    const philip = person(server, "philip");
    const me = person(server, "me");
    expect((await start(philip, "p1", ["src/auth/"])).kind).toBe("granted");
    const blocked = await start(me, "m1", ["src/auth/session.ts"]);
    expect(blocked.kind).toBe("conflict");
    expect(blocked.kind === "conflict" && blocked.message).toMatch(/philip is working on “Rework sign-in” \(branch feature\/auth\), which reserves src\/auth\/ — overlapping src\/auth\/session.ts/);
    expect((await start(me, "m2", ["src/ui/button.tsx", "src/auth-old/x.ts"])).kind).toBe("granted");
  });

  it("is safe to retry a start: the same run id gets the same reservation", async () => {
    const server = new FakeServer();
    const me = person(server, "me");
    const a = guardOf(await start(me, "m1", ["src/a.ts"]));
    const fresh = person(server, "me"); // e.g. the start request was sent again
    const b = guardOf(await start(fresh, "m1", ["src/a.ts"]));
    expect(server.rows.filter((r) => r.status === "active")).toHaveLength(1);
    expect((a as unknown as { token: string }).token).toBe((b as unknown as { token: string }).token);
  });

  it("asks for a scope when the plan names no usable files, and refuses to start without the server", async () => {
    const server = new FakeServer();
    const me = person(server, "me");
    expect((await me.c.beforeStart({ runId: "x", localProjectId: "local", plan: plan(["C:/abs.ts"]) })).kind).toBe("no_scope");
    server.down = true;
    const g = await start(me, "m1", ["src/a.ts"]);
    expect(g.kind).toBe("unavailable");
    expect(g.kind === "unavailable" && g.message).toMatch(/Coordination with your team is unavailable/);
  });

  it("authorises writes inside the reservation, expands it atomically, and keeps it when an expansion is denied", async () => {
    const server = new FakeServer();
    const philip = person(server, "philip");
    const me = person(server, "me");
    guardOf(await start(philip, "p1", ["src/auth/"]));
    const g = guardOf(await start(me, "m1", ["src/ui/"]));
    await g.authorize(["src/ui/a.tsx"]);
    expect(server.calls.filter((c) => c === "expand_reservation")).toHaveLength(0);
    await g.authorize(["docs/ui.md"]);
    expect(server.rows.find((r) => r.user === "me")!.paths).toEqual(["src/ui/", "docs/ui.md"]);
    await expect(g.authorize(["src/auth/session.ts"])).rejects.toThrow(/Not written: philip is working on/);
    expect(server.rows.find((r) => r.user === "me")!).toMatchObject({ status: "active", paths: ["src/ui/", "docs/ui.md"] });
    await expect(g.authorize(["C:\\Users\\me\\x.ts"])).rejects.toThrow(/not repository-relative/);
  });

  it("renews with server time while the run is active, and releases when it finishes", async () => {
    const server = new FakeServer();
    const me = person(server, "me");
    guardOf(await start(me, "m1", ["src/a.ts"]));
    for (let i = 0; i < 10; i += 1) await me.tick(30_000); // 5 minutes, longer than the 2-minute lease
    expect(server.rows[0]).toMatchObject({ status: "active" });
    expect(server.rows[0]!.expires).toBeGreaterThan(server.now);
    await me.c.onRunFinished("m1");
    expect(server.rows[0]!.status).toBe("released");
    // Released: the scope is free for someone else.
    expect((await start(person(server, "philip"), "p1", ["src/a.ts"])).kind).toBe("granted");
  });

  it("lets an abandoned reservation expire after a crash", async () => {
    const server = new FakeServer();
    guardOf(await start(person(server, "philip"), "p1", ["src/auth/"])); // then Philip's app crashes
    const me = person(server, "me");
    expect((await start(me, "m1", ["src/auth/x.ts"])).kind).toBe("conflict");
    server.now += 121_000;
    expect((await start(me, "m1", ["src/auth/x.ts"])).kind).toBe("granted");
    expect(server.rows[0]!.status).toBe("expired");
  });

  it("pauses writes on connection loss once the lease can no longer be confirmed, and resumes when confirmed", async () => {
    const server = new FakeServer();
    const me = person(server, "me");
    const g = guardOf(await start(me, "m1", ["src/a.ts"]));
    server.down = true;
    await me.tick(30_000); // renewal fails, but the lease is still known valid
    await g.authorize(["src/a.ts"]);
    server.now += 100_000; // past the lease's known expiry
    let refused = false;
    const pending = g.authorize(["src/a.ts"]).catch(() => { refused = true; });
    await pending;
    expect(refused).toBe(true); // could not confirm within the wait: nothing written
    server.down = false;
    // The old lease expired on the server; confirming means acquiring the scope again.
    await g.authorize(["src/a.ts"]);
    expect(server.rows.filter((r) => r.status === "active")).toHaveLength(1);
  });

  it("a stale session cannot write after another run acquired its former scope", async () => {
    const server = new FakeServer();
    const me = person(server, "me");
    const g = guardOf(await start(me, "m1", ["src/auth/"]));
    server.down = true;
    server.now += 200_000; // my app was cut off; my lease expired on the server
    server.down = false;
    expect((await start(person(server, "philip"), "p1", ["src/auth/session.ts"])).kind).toBe("granted");
    await expect(g.authorize(["src/auth/x.ts"])).rejects.toThrow(/Coordination with your team was lost/);
    // And the old token cannot renew or release Philip's reservation.
    const stale = server.rows.find((r) => r.user === "me")!;
    expect(await server.forUser("me")("renew_reservation", { p_reservation_id: server.rows.find((r) => r.user === "philip")!.id, p_lease_token: stale.token })).toMatchObject({ status: "lost" });
    expect(await server.forUser("me")("release_reservation", { p_reservation_id: server.rows.find((r) => r.user === "philip")!.id, p_lease_token: stale.token })).toMatchObject({ status: "not_owner" });
    expect(server.rows.find((r) => r.user === "philip")!.status).toBe("active");
  });
});
