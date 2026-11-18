// Who is online, through Supabase Realtime Presence on private channels (protocol vsn 1.0.0).
//
// Each member publishes presence only on their own topic per shared project,
// "teams:<project>:user:<user>", and the database's policies on realtime.messages allow that only
// for the user in the topic (supabase/migrations/*_teams_presence.sql). Readers therefore take a
// person's identity from the topic, never from the payload. A person is online while at least one
// of their sessions has presence on their topic.
//
// This runs in the main process and is free of Electron so it is unit-tested. Presence is only
// about being online: it never touches anyone's work.

export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface PresenceTarget {
  projectId: string;
  selfId: string;
  memberIds: string[];
}

// "live": presence is known. "connecting": first connection. "reconnecting": the connection
// dropped and is being restored. "unavailable": it cannot be restored now, or access was refused.
export type ConnectionState = "connecting" | "live" | "reconnecting" | "unavailable";

export interface ProjectPresence {
  connection: ConnectionState;
  // Only meaningful when connection is "live".
  online: string[];
  // Whether this computer is publishing presence (signed in and not idle).
  publishing: boolean;
  problem: string | null;
}

export type PresenceSnapshot = Record<string, ProjectPresence>;

type Timer = unknown;

export interface PresenceDeps {
  // wss://<ref>.supabase.co/realtime/v1/websocket?apikey=<publishable key>&vsn=1.0.0
  url: string;
  createSocket: (url: string) => SocketLike;
  getToken: () => Promise<string | null>;
  onChange: (snapshot: PresenceSnapshot) => void;
  // A project's briefs may have changed: a "brief_changed" broadcast arrived, or the briefs channel
  // was (re)joined after a connection loss, so missed changes must be read again (phase 3).
  onBriefs?: (projectId: string) => void;
  // Someone joined or left the team: read the team again (new members' status and Managers).
  onTeamChanged?: (projectId: string) => void;
  // A random id per app session; several sessions of one person each publish their own entry.
  sessionKey: string;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  now?: () => number;
}

export const HEARTBEAT_MS = 25_000;
// After this long without a working connection the bridge says "Status unavailable".
export const UNAVAILABLE_AFTER_MS = 45_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

interface Channel {
  topic: string;
  // "presence": one person's topic. "briefs": the project's brief-change broadcasts (listen only).
  kind: "presence" | "briefs";
  projectId: string;
  memberId: string;
  isSelf: boolean;
  joinRef: string | null;
  state: "idle" | "joining" | "joined" | "denied";
  synced: boolean;
  presence: Map<string, unknown[]>;
  tracked: boolean;
  problem: string | null;
}

export const presenceTopic = (projectId: string, userId: string) => `teams:${projectId}:user:${userId}`;
export const briefsTopic = (projectId: string) => `teams:${projectId}:briefs`;

export class PresenceHub {
  private socket: SocketLike | null = null;
  private open = false;
  private channels = new Map<string, Channel>();
  private targets: PresenceTarget[] = [];
  private active = true;
  private ref = 0;
  private pendingHeartbeat: string | null = null;
  private heartbeatTimer: Timer | null = null;
  private reconnectTimer: Timer | null = null;
  private attempts = 0;
  private downSince: number | null = null;
  private everLive = false;
  private stopped = true;
  private token: string | null = null;
  private lastSnapshot = "";
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly now: () => number;

  constructor(private readonly deps: PresenceDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.now = deps.now ?? Date.now;
  }

  // The projects to watch. An empty list (signed out, no shared projects) closes the connection.
  setTargets(targets: PresenceTarget[]): void {
    this.targets = targets.map((t) => ({ ...t, memberIds: [...new Set([...t.memberIds, t.selfId])] }));
    const wanted = new Map<string, Omit<Channel, "joinRef" | "state" | "synced" | "presence" | "tracked" | "problem">>();
    for (const t of this.targets) {
      for (const m of t.memberIds) wanted.set(presenceTopic(t.projectId, m), { topic: presenceTopic(t.projectId, m), kind: "presence", projectId: t.projectId, memberId: m, isSelf: m === t.selfId });
      wanted.set(briefsTopic(t.projectId), { topic: briefsTopic(t.projectId), kind: "briefs", projectId: t.projectId, memberId: "", isSelf: false });
    }
    // Leave channels that are no longer wanted (project removed, account changed).
    for (const [topic, ch] of this.channels) {
      if (!wanted.has(topic)) {
        if (this.open && ch.state === "joined") this.push(topic, "phx_leave", {}, ch.joinRef);
        this.channels.delete(topic);
      }
    }
    for (const [topic, base] of wanted) {
      if (!this.channels.has(topic)) {
        const ch: Channel = { ...base, joinRef: null, state: "idle", synced: false, presence: new Map(), tracked: false, problem: null };
        this.channels.set(topic, ch);
        if (this.open) void this.join(ch);
      }
    }
    if (this.channels.size === 0) this.stop();
    else if (this.stopped) this.start();
    this.changed();
  }

  // Whether this person is active on this computer. Inactive withdraws their presence everywhere
  // (they show offline) but keeps watching their teammates.
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    for (const ch of this.channels.values()) this.syncTrack(ch);
    this.changed();
  }

  // Sends a renewed access token to every joined channel, so they stay authorized.
  async refreshToken(): Promise<void> {
    const token = await this.deps.getToken();
    if (!token) return this.setTargets([]);
    if (token === this.token) return;
    this.token = token;
    for (const ch of this.channels.values()) if (ch.state === "joined") this.push(ch.topic, "access_token", { access_token: token }, ch.joinRef);
  }

  // Reconnects right away (for example after the computer wakes up).
  nudge(): void {
    if (this.stopped || this.open) return;
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  snapshot(): PresenceSnapshot {
    const out: PresenceSnapshot = {};
    const unavailable = this.downSince !== null && this.now() - this.downSince >= UNAVAILABLE_AFTER_MS;
    for (const t of this.targets) {
      const chans = [...this.channels.values()].filter((c) => c.projectId === t.projectId);
      const denied = chans.find((c) => c.state === "denied");
      let connection: ConnectionState;
      if (denied) connection = "unavailable";
      else if (this.open && chans.length > 0 && chans.every((c) => c.state === "joined" && c.synced)) connection = "live";
      else if (unavailable) connection = "unavailable";
      else connection = this.everLive ? "reconnecting" : "connecting";
      out[t.projectId] = {
        connection,
        online: connection === "live" ? chans.filter((c) => c.kind === "presence" && [...c.presence.values()].some((metas) => metas.length > 0)).map((c) => c.memberId) : [],
        publishing: this.active && this.open && chans.some((c) => c.isSelf && c.tracked),
        problem: denied?.problem ?? (connection === "unavailable" ? "The connection to the Teams server is down." : null),
      };
    }
    return out;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    if (this.heartbeatTimer) this.clearTimer(this.heartbeatTimer);
    this.reconnectTimer = this.heartbeatTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.open = false;
    this.pendingHeartbeat = null;
    for (const ch of this.channels.values()) this.reset(ch);
    if (socket) {
      socket.onclose = socket.onmessage = socket.onerror = socket.onopen = null;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  }

  // ---- Connection ---------------------------------------------------------------------------

  private start(): void {
    this.stopped = false;
    this.downSince = null;
    this.everLive = false;
    this.attempts = 0;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: SocketLike;
    try {
      socket = this.deps.createSocket(this.deps.url);
    } catch {
      return this.lost();
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.open = true;
      this.attempts = 0;
      this.scheduleHeartbeat();
      for (const ch of this.channels.values()) void this.join(ch);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.lost();
    };
    socket.onerror = () => {
      /* onclose follows */
    };
  }

  // The socket closed or stopped answering: show "Reconnecting" and try again with backoff.
  private lost(): void {
    if (this.heartbeatTimer) this.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.open = false;
    this.pendingHeartbeat = null;
    if (socket) {
      socket.onclose = socket.onmessage = socket.onerror = socket.onopen = null;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
    for (const ch of this.channels.values()) this.reset(ch);
    if (this.downSince === null) this.downSince = this.now();
    this.changed();
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)]!;
    this.attempts += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.changed();
      this.connect();
    }, delay);
    // Re-evaluate "unavailable" when its time comes, even if nothing else happens.
    this.setTimer(() => this.changed(), UNAVAILABLE_AFTER_MS + 50);
  }

  private reset(ch: Channel): void {
    if (ch.state !== "denied") ch.state = "idle";
    ch.synced = false;
    ch.joinRef = null;
    ch.tracked = false;
    ch.presence.clear();
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = this.setTimer(() => {
      this.heartbeatTimer = null;
      if (!this.open) return;
      // The previous heartbeat was never answered: the connection is dead (network loss).
      if (this.pendingHeartbeat) return this.lost();
      this.pendingHeartbeat = this.push("phoenix", "heartbeat", {}, null);
      this.scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  private push(topic: string, event: string, payload: unknown, joinRef: string | null): string {
    const ref = String(++this.ref);
    try {
      this.socket?.send(JSON.stringify({ topic: topic === "phoenix" ? "phoenix" : `realtime:${topic}`, event, payload, ref, join_ref: joinRef }));
    } catch {
      /* the close handler deals with it */
    }
    return ref;
  }

  private async join(ch: Channel): Promise<void> {
    if (ch.state === "denied" || ch.state === "joining") return;
    ch.state = "joining";
    const token = await this.deps.getToken();
    if (!this.open || !this.channels.has(ch.topic)) {
      ch.state = "idle";
      return;
    }
    if (!token) return this.setTargets([]);
    this.token = token;
    const ref = String(++this.ref);
    ch.joinRef = ref;
    try {
      this.socket?.send(
        JSON.stringify({
          topic: `realtime:${ch.topic}`,
          event: "phx_join",
          payload: {
            config: { broadcast: { self: false, ack: false }, presence: ch.kind === "presence" ? { enabled: true, key: this.deps.sessionKey } : { enabled: false }, postgres_changes: [], private: true },
            access_token: token,
          },
          ref,
          join_ref: ref,
        }),
      );
    } catch {
      /* close handler */
    }
  }

  private markLiveIfReady(): void {
    if (this.open && [...this.channels.values()].every((c) => c.state === "joined" && c.synced)) {
      this.everLive = true;
      this.downSince = null;
    }
  }

  private syncTrack(ch: Channel): void {
    if (ch.kind !== "presence" || !ch.isSelf || !this.open || ch.state !== "joined") return;
    if (this.active && !ch.tracked) {
      this.push(ch.topic, "presence", { type: "presence", event: "track", payload: { session: this.deps.sessionKey } }, ch.joinRef);
      ch.tracked = true;
    } else if (!this.active && ch.tracked) {
      this.push(ch.topic, "presence", { type: "presence", event: "untrack" }, ch.joinRef);
      ch.tracked = false;
    }
  }

  private receive(raw: unknown): void {
    let msg: { topic?: unknown; event?: unknown; payload?: unknown; ref?: unknown; join_ref?: unknown };
    try {
      msg = JSON.parse(String(raw)) as typeof msg;
    } catch {
      return;
    }
    if (msg.topic === "phoenix") {
      if (msg.event === "phx_reply" && msg.ref === this.pendingHeartbeat) this.pendingHeartbeat = null;
      return;
    }
    const topic = typeof msg.topic === "string" && msg.topic.startsWith("realtime:") ? msg.topic.slice("realtime:".length) : null;
    const ch = topic ? this.channels.get(topic) : undefined;
    if (!ch) return;
    // Ignore messages from an earlier join of this channel.
    if (msg.join_ref !== undefined && msg.join_ref !== null && ch.joinRef !== null && msg.join_ref !== ch.joinRef) return;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    switch (msg.event) {
      case "phx_reply": {
        if (msg.ref !== ch.joinRef || ch.state !== "joining") return;
        if (payload.status === "ok") {
          ch.state = "joined";
          ch.problem = null;
          if (ch.kind === "briefs") {
            // No presence on this channel: joined means synced. Read the briefs again now, which
            // also recovers anything missed while disconnected.
            ch.synced = true;
            this.markLiveIfReady();
            this.deps.onBriefs?.(ch.projectId);
          }
          this.syncTrack(ch);
        } else {
          const response = (payload.response ?? {}) as Record<string, unknown>;
          const reason = typeof response.reason === "string" ? response.reason : "The Teams server refused the connection.";
          ch.state = "denied";
          ch.problem = /unauthori[sz]ed|permission/i.test(reason) ? "You do not have access to this project's status." : reason;
        }
        break;
      }
      case "presence_state":
        if (ch.kind !== "presence") return;
        ch.presence.clear();
        for (const [key, value] of Object.entries(payload)) ch.presence.set(key, metasOf(value));
        ch.synced = true;
        this.markLiveIfReady();
        break;
      case "broadcast":
        if (ch.kind === "briefs" && (payload.event === "brief_changed" || payload.event === "reservation_changed")) this.deps.onBriefs?.(ch.projectId);
        if (ch.kind === "briefs" && payload.event === "team_changed") this.deps.onTeamChanged?.(ch.projectId);
        return;
      case "presence_diff": {
        if (ch.kind !== "presence") return;
        const joins = (payload.joins ?? {}) as Record<string, unknown>;
        const leaves = (payload.leaves ?? {}) as Record<string, unknown>;
        for (const [key, value] of Object.entries(leaves)) {
          const gone = new Set(metasOf(value).map(refOf));
          const left = (ch.presence.get(key) ?? []).filter((m) => !gone.has(refOf(m)));
          if (left.length) ch.presence.set(key, left);
          else ch.presence.delete(key);
        }
        for (const [key, value] of Object.entries(joins)) {
          const existing = ch.presence.get(key) ?? [];
          const refs = new Set(existing.map(refOf));
          ch.presence.set(key, [...existing, ...metasOf(value).filter((m) => !refs.has(refOf(m)))]);
        }
        break;
      }
      case "phx_close":
      case "phx_error":
        // The server closed this channel (for example an expired token): join it again.
        this.reset(ch);
        if (this.open) this.setTimer(() => void this.join(ch), 1_000);
        break;
      case "system":
        if (payload.status === "error") {
          this.reset(ch);
          if (this.open) this.setTimer(() => void this.join(ch), 1_000);
        }
        break;
      default:
        return;
    }
    this.changed();
  }

  private changed(): void {
    const snap = this.snapshot();
    const key = JSON.stringify(snap);
    if (key === this.lastSnapshot) return;
    this.lastSnapshot = key;
    this.deps.onChange(snap);
  }
}

function metasOf(value: unknown): unknown[] {
  const metas = (value as { metas?: unknown } | null)?.metas;
  return Array.isArray(metas) ? metas : [];
}

function refOf(meta: unknown): string {
  const r = (meta as { phx_ref?: unknown } | null)?.phx_ref;
  return typeof r === "string" ? r : JSON.stringify(meta);
}
