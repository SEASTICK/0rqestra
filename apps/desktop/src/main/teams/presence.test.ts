import { describe, expect, it } from "vitest";
import { ActivityMonitor, isActive } from "./activity";
import { HEARTBEAT_MS, PresenceHub, UNAVAILABLE_AFTER_MS, presenceTopic, type PresenceSnapshot, type SocketLike } from "./presence";

// A controlled clock and timers, and sockets that record what is sent.
function harness() {
  let now = 1_000_000;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const sockets: FakeSocket[] = [];
  const snapshots: PresenceSnapshot[] = [];
  let token: string | null = "token-1";
  class FakeSocket implements SocketLike {
    sent: Record<string, unknown>[] = [];
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    send(data: string) {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }
    close() {
      this.closed = true;
    }
    serverSends(msg: Record<string, unknown>) {
      this.onmessage?.({ data: JSON.stringify(msg) });
    }
    joins() {
      return this.sent.filter((m) => m.event === "phx_join");
    }
    // Answers every pending join with ok and an empty presence state.
    acceptJoins(state: Record<string, Record<string, unknown>> = {}) {
      for (const j of this.joins()) {
        if ((j as { answered?: boolean }).answered) continue;
        (j as { answered?: boolean }).answered = true;
        this.serverSends({ topic: j.topic, event: "phx_reply", payload: { status: "ok", response: {} }, ref: j.ref, join_ref: j.join_ref });
        this.serverSends({ topic: j.topic, event: "presence_state", payload: state[String(j.topic)] ?? {}, ref: null, join_ref: j.join_ref });
      }
    }
    joinRefOf(topic: string) {
      return this.joins().filter((j) => j.topic === `realtime:${topic}`).at(-1)?.join_ref;
    }
  }
  const hub = new PresenceHub({
    url: "wss://x/realtime/v1/websocket?apikey=k&vsn=1.0.0",
    sessionKey: "session-me",
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    getToken: async () => token,
    onChange: (s) => snapshots.push(s),
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
    }
    now = end;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { hub, sockets, snapshots, advance, flush, last: () => snapshots.at(-1)!, setToken: (t: string | null) => (token = t) };
}

const P = "11111111-1111-1111-1111-111111111111";
const ME = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ANN = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const meta = (ref: string) => ({ metas: [{ phx_ref: ref, session: ref }] });

async function connected() {
  const h = harness();
  h.hub.setTargets([{ projectId: P, selfId: ME, memberIds: [ME, ANN] }]);
  const s = h.sockets[0]!;
  s.onopen?.();
  await h.flush();
  return { ...h, s };
}

describe("presence over private Realtime channels", () => {
  it("joins one private channel per member, with the access token, and publishes only on its own topic", async () => {
    const { s } = await connected();
    const joins = s.joins().filter((j) => String(j.topic).includes(":user:"));
    expect(joins.map((j) => j.topic).sort()).toEqual([`realtime:${presenceTopic(P, ANN)}`, `realtime:${presenceTopic(P, ME)}`].sort());
    for (const j of joins) expect(j.payload).toMatchObject({ config: { private: true, presence: { enabled: true, key: "session-me" } }, access_token: "token-1" });
    s.acceptJoins();
    const tracks = s.sent.filter((m) => m.event === "presence");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ topic: `realtime:${presenceTopic(P, ME)}`, payload: { type: "presence", event: "track" } });
  });

  it("is connecting until every channel has synced, then shows who is online", async () => {
    const h = await connected();
    expect(h.last()[P]!.connection).toBe("connecting");
    h.s.acceptJoins({ [`realtime:${presenceTopic(P, ANN)}`]: { "session-ann": meta("r1") } });
    expect(h.last()[P]).toMatchObject({ connection: "live", online: [ANN], publishing: true });
  });

  it("takes identity from the topic, not from the payload", async () => {
    const h = await connected();
    // Someone's presence entry claims to be Ann, but it arrives on my own topic: it counts as me.
    h.s.acceptJoins({ [`realtime:${presenceTopic(P, ME)}`]: { "fake-ann": { metas: [{ phx_ref: "x", user_id: ANN, email: "ann@x" }] } } });
    expect(h.last()[P]!.online).toEqual([ME]);
  });

  it("keeps a person online while at least one of their sessions is there", async () => {
    const h = await connected();
    const annTopic = `realtime:${presenceTopic(P, ANN)}`;
    h.s.acceptJoins({ [annTopic]: { laptop: meta("r1"), desktop: meta("r2") } });
    const ref = h.s.joinRefOf(presenceTopic(P, ANN));
    h.s.serverSends({ topic: annTopic, event: "presence_diff", payload: { joins: {}, leaves: { laptop: meta("r1") } }, ref: null, join_ref: ref });
    expect(h.last()[P]!.online).toEqual([ANN]);
    h.s.serverSends({ topic: annTopic, event: "presence_diff", payload: { joins: {}, leaves: { desktop: meta("r2") } }, ref: null, join_ref: ref });
    expect(h.last()[P]!.online).toEqual([]);
    h.s.serverSends({ topic: annTopic, event: "presence_diff", payload: { joins: { desktop: meta("r3") }, leaves: {} }, ref: null, join_ref: ref });
    expect(h.last()[P]!.online).toEqual([ANN]);
  });

  it("withdraws presence when inactive and publishes again when active, without leaving", async () => {
    const h = await connected();
    h.s.acceptJoins();
    h.hub.setActive(false);
    expect(h.s.sent.at(-1)).toMatchObject({ event: "presence", payload: { event: "untrack" } });
    expect(h.last()[P]).toMatchObject({ connection: "live", publishing: false });
    expect(h.s.sent.some((m) => m.event === "phx_leave")).toBe(false);
    h.hub.setActive(true);
    expect(h.s.sent.at(-1)).toMatchObject({ event: "presence", payload: { event: "track" } });
    expect(h.last()[P]!.publishing).toBe(true);
  });

  it("shows Reconnecting when the connection drops, Status unavailable after a while, and recovers", async () => {
    const h = await connected();
    h.s.acceptJoins({ [`realtime:${presenceTopic(P, ANN)}`]: { a: meta("r1") } });
    h.s.onclose?.();
    expect(h.last()[P]).toMatchObject({ connection: "reconnecting", online: [] });
    // The reconnect attempts fail for a while.
    h.advance(1_000);
    h.sockets.at(-1)!.onclose?.();
    h.advance(UNAVAILABLE_AFTER_MS);
    expect(h.last()[P]!.connection).toBe("unavailable");
    h.advance(30_000);
    const fresh = h.sockets.at(-1)!;
    fresh.onopen?.();
    await h.flush();
    fresh.acceptJoins({ [`realtime:${presenceTopic(P, ANN)}`]: { a: meta("r9") } });
    expect(h.last()[P]).toMatchObject({ connection: "live", online: [ANN], publishing: true });
  });

  it("treats an unanswered heartbeat as a lost connection (network loss)", async () => {
    const h = await connected();
    h.s.acceptJoins();
    h.advance(HEARTBEAT_MS);
    const beat = h.s.sent.at(-1)!;
    expect(beat).toMatchObject({ topic: "phoenix", event: "heartbeat" });
    h.s.serverSends({ topic: "phoenix", event: "phx_reply", payload: { status: "ok", response: {} }, ref: beat.ref });
    h.advance(HEARTBEAT_MS);
    expect(h.last()[P]!.connection).toBe("live");
    // No answer to this heartbeat: at the next one the connection is given up and reopened.
    h.advance(HEARTBEAT_MS);
    expect(h.s.closed).toBe(true);
    expect(h.last()[P]!.connection).toBe("reconnecting");
  });

  it("reports refused access instead of a status", async () => {
    const h = await connected();
    const j = h.s.joins()[0]!;
    h.s.serverSends({ topic: j.topic, event: "phx_reply", payload: { status: "error", response: { reason: "Unauthorized: You do not have permissions to read from this Channel topic" } }, ref: j.ref, join_ref: j.join_ref });
    expect(h.last()[P]).toMatchObject({ connection: "unavailable", online: [], problem: "You do not have access to this project's status." });
  });

  it("sends a renewed token to joined channels", async () => {
    const h = await connected();
    h.s.acceptJoins();
    h.setToken("token-2");
    await h.hub.refreshToken();
    const updates = h.s.sent.filter((m) => m.event === "access_token");
    // Two presence channels and the project's briefs channel.
    expect(updates).toHaveLength(3);
    expect(updates[0]!.payload).toEqual({ access_token: "token-2" });
  });

  it("leaves channels on account or project changes, and closes everything on sign-out", async () => {
    const h = await connected();
    h.s.acceptJoins();
    const OTHER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    h.hub.setTargets([{ projectId: P, selfId: OTHER, memberIds: [OTHER] }]);
    expect(h.s.sent.filter((m) => m.event === "phx_leave").map((m) => m.topic).sort()).toEqual([`realtime:${presenceTopic(P, ANN)}`, `realtime:${presenceTopic(P, ME)}`].sort());
    await h.flush();
    expect(h.s.joins().at(-1)!.topic).toBe(`realtime:${presenceTopic(P, OTHER)}`);
    h.hub.setTargets([]);
    expect(h.s.closed).toBe(true);
    expect(h.last()).toEqual({});
  });
});

describe("activity from the system idle time", () => {
  it("goes inactive at exactly 10 minutes without input and active again on input", () => {
    expect(isActive(0)).toBe(true);
    expect(isActive(599)).toBe(true);
    expect(isActive(600)).toBe(false);
    expect(isActive(NaN)).toBe(true);
  });

  it("polls the idle time with a controlled clock", () => {
    let idle = 0;
    const changes: boolean[] = [];
    let pending: (() => void) | null = null;
    const monitor = new ActivityMonitor({
      idleSeconds: () => idle,
      onChange: (a) => changes.push(a),
      setTimer: (fn) => {
        pending = fn;
        return 1;
      },
      clearTimer: () => {
        pending = null;
      },
    });
    monitor.start();
    const tick = (seconds: number) => {
      idle = seconds;
      const fn = pending!;
      fn();
    };
    tick(300);
    tick(599);
    expect(changes).toEqual([]);
    tick(600);
    expect(changes).toEqual([false]);
    tick(900);
    tick(2);
    expect(changes).toEqual([false, true]);
    expect(monitor.isActive()).toBe(true);
    monitor.stop();
    expect(pending).toBeNull();
  });
});

describe("brief changes over the private briefs channel", () => {
  it("joins the project's briefs channel without presence and asks for a re-read on join and on each change", async () => {
    const changed: string[] = [];
    const h = harness();
    // Swap in an onBriefs listener on the same hub instance.
    (h.hub as unknown as { deps: { onBriefs: (p: string) => void } }).deps.onBriefs = (p) => changed.push(p);
    h.hub.setTargets([{ projectId: P, selfId: ME, memberIds: [ME] }]);
    const s = h.sockets[0]!;
    s.onopen?.();
    await h.flush();
    const join = s.joins().find((j) => j.topic === `realtime:teams:${P}:briefs`)!;
    expect(join.payload).toMatchObject({ config: { private: true, presence: { enabled: false } } });
    s.acceptJoins();
    expect(changed).toEqual([P]);
    expect(h.last()[P]!.connection).toBe("live");
    s.serverSends({ topic: join.topic, event: "broadcast", payload: { type: "broadcast", event: "brief_changed", payload: { brief_id: "b" } }, ref: null });
    expect(changed).toEqual([P, P]);
    // Nothing is ever published on the briefs channel.
    expect(s.sent.filter((m) => m.topic === join.topic && m.event !== "phx_join")).toEqual([]);
    // After a reconnect the briefs are read again, recovering missed changes.
    s.onclose?.();
    h.advance(1_000);
    const s2 = h.sockets.at(-1)!;
    s2.onopen?.();
    await h.flush();
    s2.acceptJoins();
    expect(changed).toEqual([P, P, P]);
  });
});

describe("team membership changes", () => {
  it("asks to read the team again when someone joins or leaves", async () => {
    const changed: string[] = [];
    const h = harness();
    (h.hub as unknown as { deps: { onTeamChanged: (p: string) => void } }).deps.onTeamChanged = (p) => changed.push(p);
    h.hub.setTargets([{ projectId: P, selfId: ME, memberIds: [ME] }]);
    const s = h.sockets[0]!;
    s.onopen?.();
    await h.flush();
    s.acceptJoins();
    const topic = `realtime:teams:${P}:briefs`;
    s.serverSends({ topic, event: "broadcast", payload: { type: "broadcast", event: "team_changed", payload: { team_id: "t" } }, ref: null });
    expect(changed).toEqual([P]);
    // A new member then gets their own presence channel as soon as the targets include them.
    h.hub.setTargets([{ projectId: P, selfId: ME, memberIds: [ME, ANN] }]);
    await h.flush();
    expect(s.joins().some((j) => j.topic === `realtime:${presenceTopic(P, ANN)}`)).toBe(true);
  });
});
