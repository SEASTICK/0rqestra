import { MAX_MESSAGE_CHARS } from "./providers/history";
import { EFFORT_NAME, MODEL_NAME } from "./providers/process";
import { parseTeamMembers } from "./team/team-service";
import { PROVIDER_IDS, type ChatEvent, type ChatHandle, type ChatTurn, type ProviderAdapter, type ProviderId, type ProviderStatus, type TeamMember } from "./providers/types";

// The chat between the window and the provider tools, free of Electron so it is unit-tested.
// Everything that arrives from the window is validated here before any tool is started.

export const MAX_HISTORY_ITEMS = 200;
export const MAX_RUNNING = 3;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface SendPayload {
  requestId: string;
  projectId: string;
  provider: ProviderId;
  model: string | null;
  effort: string | null;
  history: ChatTurn[];
  text: string;
  team: TeamMember[];
}

export function parseSend(value: unknown): SendPayload {
  if (!value || typeof value !== "object") throw new Error("Invalid chat request.");
  const v = value as Record<string, unknown>;
  if (typeof v.requestId !== "string" || !REQUEST_ID.test(v.requestId)) throw new Error("Invalid request id.");
  if (typeof v.projectId !== "string" || !PROJECT_ID.test(v.projectId)) throw new Error("Invalid project id.");
  if (!PROVIDER_IDS.includes(v.provider as ProviderId)) throw new Error("Unknown provider.");
  const model = v.model === null || v.model === undefined || v.model === "" ? null : v.model;
  if (model !== null && (typeof model !== "string" || !MODEL_NAME.test(model))) throw new Error("Invalid model.");
  const effort = v.effort === null || v.effort === undefined || v.effort === "" ? null : v.effort;
  if (effort !== null && (typeof effort !== "string" || !EFFORT_NAME.test(effort))) throw new Error("Invalid effort.");
  if (typeof v.text !== "string" || !v.text.trim() || v.text.length > MAX_MESSAGE_CHARS) throw new Error("The message is empty or too long.");
  const history = v.history ?? [];
  if (!Array.isArray(history) || history.length > MAX_HISTORY_ITEMS) throw new Error("Invalid history.");
  const turns: ChatTurn[] = history.map((turn: unknown) => {
    const t = turn as Record<string, unknown> | null;
    if (!t || (t.role !== "user" && t.role !== "assistant") || typeof t.text !== "string" || t.text.length > MAX_MESSAGE_CHARS) {
      throw new Error("Invalid history.");
    }
    return { role: t.role, text: t.text };
  });
  const team = parseTeamMembers(v.team);
  return { requestId: v.requestId, projectId: v.projectId, provider: v.provider as ProviderId, model, effort, history: turns, text: v.text, team };
}

export type Emit = (requestId: string, event: ChatEvent) => void;

export class ChatService {
  private running = new Map<string, { projectId: string; handle: ChatHandle }>();
  private statusCache: { at: number; value: ProviderStatus[] } | null = null;

  constructor(
    private readonly adapters: Record<ProviderId, ProviderAdapter>,
    private readonly cwd: () => string,
    private readonly now: () => number = Date.now,
    // Teams: what teammates are doing in this project right now (null for a solo project).
    private readonly teamNow: (projectId: string) => string | null = () => null,
  ) {}

  async providers(refresh: boolean): Promise<ProviderStatus[]> {
    if (!refresh && this.statusCache && this.now() - this.statusCache.at < 30_000) return this.statusCache.value;
    const value = await Promise.all(PROVIDER_IDS.map((id) => this.adapters[id].status().catch((error: unknown) => ({
      provider: id, name: id, installed: false, version: null, signedIn: false, plan: null, subscription: false, models: [], limits: [],
      problem: error instanceof Error ? error.message : String(error),
    }))));
    this.statusCache = { at: this.now(), value };
    return value;
  }

  // Statuses are read again on the next request (AI accounts saw a change).
  invalidate(): void {
    this.statusCache = null;
  }

  // Starts a reply. Throws (so the window gets the message) when the request is invalid, the same
  // project already has a reply running, or too many replies are running at once.
  start(raw: unknown, emit: Emit): string {
    const payload = parseSend(raw);
    if (this.running.has(payload.requestId)) throw new Error("This request is already running.");
    if ([...this.running.values()].some((r) => r.projectId === payload.projectId)) throw new Error("A reply is already being written in this project. Stop it or wait.");
    if (this.running.size >= MAX_RUNNING) throw new Error("Too many replies are running. Wait for one to finish.");
    const handle = this.adapters[payload.provider].chat({
      provider: payload.provider, model: payload.model, effort: payload.effort, history: payload.history, text: payload.text, cwd: this.cwd(), team: payload.team,
      teamNow: this.teamNowFor(payload.projectId),
    });
    this.running.set(payload.requestId, { projectId: payload.projectId, handle });
    void (async () => {
      try {
        for await (const event of handle.events) emit(payload.requestId, event);
      } catch (error) {
        emit(payload.requestId, { type: "failed", reason: "crashed", message: error instanceof Error ? error.message : String(error), text: "" });
      } finally {
        this.running.delete(payload.requestId);
        // Limits and sign-in can change with every reply; read them fresh next time.
        this.statusCache = null;
      }
    })();
    return payload.requestId;
  }

  private teamNowFor(projectId: string): string | null {
    try {
      return this.teamNow(projectId);
    } catch {
      return null;
    }
  }

  stop(requestId: unknown): boolean {
    if (typeof requestId !== "string") return false;
    const run = this.running.get(requestId);
    if (!run) return false;
    run.handle.stop();
    return true;
  }

  stopAll(): void {
    for (const run of this.running.values()) run.handle.stop();
  }

  get runningCount(): number {
    return this.running.size;
  }
}
