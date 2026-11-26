import { MAX_MEMORY, MAX_MESSAGE_CHARS, PLAN_NEEDED, wantsTeamWork } from "./providers/history";
import { MAX_PER_MESSAGE, type Attachment } from "./attachments";
import { EFFORT_NAME, MODEL_NAME } from "./providers/process";
import { parseTeamMembers } from "./team/team-service";
import { adapterOf, PROVIDER_IDS, type AdapterSet, type ChatEvent, type ChatHandle, type ChatTurn, type ProviderId, type ProviderStatus, type TeamMember, type Usage } from "./providers/types";

// The chat between the window and the provider tools, free of Electron so it is unit-tested.
// Everything that arrives from the window is validated here before any tool is started.

export const MAX_HISTORY_ITEMS = 200;
export const MAX_RUNNING = 3;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface SendPayload {
  requestId: string;
  projectId: string;
  // "auto": the app picks the tool per message (pickTool).
  provider: ProviderId | "auto";
  model: string | null;
  effort: string | null;
  history: ChatTurn[];
  text: string;
  // Absent for Ask anything (no project); empty for a project whose team has no agents yet.
  team?: TeamMember[] | undefined;
  attachments?: string[];
  memory?: string[];
}

export function parseSend(value: unknown): SendPayload {
  if (!value || typeof value !== "object") throw new Error("Invalid chat request.");
  const v = value as Record<string, unknown>;
  if (typeof v.requestId !== "string" || !REQUEST_ID.test(v.requestId)) throw new Error("Invalid request id.");
  if (typeof v.projectId !== "string" || !PROJECT_ID.test(v.projectId)) throw new Error("Invalid project id.");
  if (!PROVIDER_IDS.includes(v.provider as ProviderId) && v.provider !== AUTO) throw new Error("Unknown provider.");
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
  // No team at all (Ask anything) is not the same as a project whose team has no agents yet.
  const team = v.team === undefined ? undefined : parseTeamMembers(v.team);
  const attachments = v.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > MAX_PER_MESSAGE || !attachments.every((a) => typeof a === "string")) throw new Error("Invalid attachments.");
  const memory = v.memory ?? [];
  if (!Array.isArray(memory) || memory.length > MAX_MEMORY || !memory.every((m) => typeof m === "string" && m.trim() && m.length <= 300)) throw new Error("Invalid project memory.");
  return { requestId: v.requestId, projectId: v.projectId, provider: v.provider as ProviderId | "auto", model, effort, history: turns, text: v.text, ...(team ? { team } : {}), ...(attachments.length ? { attachments: attachments as string[] } : {}), ...(memory.length ? { memory: (memory as string[]).map((m) => m.trim()) } : {}) };
}

export const AUTO = "auto";

// A quick question: short, no work asked for, nothing attached, not answering the Manager's questions.
export function isQuick(text: string, history: ChatTurn[], hasAttachments: boolean): boolean {
  return !hasAttachments && text.trim().length <= 400 && !wantsTeamWork(text, history);
}

// The model "Auto" picks from what the tool offers: for Claude Code, Haiku for quick questions and Sonnet
// otherwise; for Codex, a "mini" model for quick questions when there is one, and its default otherwise.
export function autoModel(provider: ProviderId, payload: { text: string; history: ChatTurn[] }, hasAttachments: boolean, statuses: ProviderStatus[]): string | null {
  const quick = isQuick(payload.text, payload.history, hasAttachments);
  const offered = statuses.find((s) => s.provider === provider)?.models ?? [];
  const has = (id: string) => offered.length === 0 || offered.some((m) => m.id === id);
  if (provider === "claude") {
    const want = quick ? "haiku" : "sonnet";
    return has(want) ? want : null;
  }
  // Gemini (Antigravity CLI): a Flash model for quick questions when the plan offers one (fast, and light on the
  // limits), otherwise the plan's own default model. The names come from `agy models`, so they are matched, not fixed.
  if (provider === "gemini") {
    if (!quick) return null;
    return offered.find((m) => /flash/i.test(m.id) || /flash/i.test(m.label))?.id ?? null;
  }
  const light = offered.find((m) => /mini|nano|fast|lite/i.test(m.id));
  if (quick && light) return light.id;
  return offered.find((m) => m.isDefault)?.id ?? null;
}

// Which tool answers when the user chose "Auto": code and errors go to Codex, a very long text to Gemini, a PDF to
// Claude (Gemini reads text only here), a quick everyday question in Ask anything to Gemini (fast, and it spares the Claude and
// ChatGPT plans), and writing, studying, planning and design to Claude. In a project the Manager hands work
// to a team with its own markup, so there Gemini is not chosen unless it is the only tool. Only connected
// tools are chosen.
const WRITING_WORDS = /\b(write|rewrite|draft|essay|email|mail|letter|summari[sz]e|translate|plan|design|story|poem|improve|edit|skriv|skriva|skriv om|mejl|brev|uppsats|sammanfatta|översätt|planera|designa|berättelse|dikt|förbättra)\b/i;
export const LONG_TEXT_CHARS = 12_000;
const CODE_WORDS = /```|\b(code|coding|bug|bugs|debug|error|exception|stack ?trace|function|script|regex|sql|api|compile|refactor|unit tests?|typescript|javascript|python|java|rust|golang|c\+\+|html|css|kod|koda|kodar|bugg|buggar|felmeddelande|funktion|skript|programmera|programmering)\b/i;
export function pickTool(text: string, attachments: { kind: string }[], ready: ProviderId[], inProject = false, history: ChatTurn[] = []): { provider: ProviderId; reason: string } {
  const has = (p: ProviderId) => ready.includes(p);
  if (!ready.length) return { provider: "claude", reason: "no tool reported as ready" };
  if (ready.length === 1) return { provider: ready[0]!, reason: "the only connected tool" };
  const gemini = has("gemini") && !inProject;
  if (attachments.some((a) => a.kind === "pdf") && has("claude")) return { provider: "claude", reason: "reads the attached PDF" };
  // Gemini takes text only here: nothing with a picture or a PDF goes to it.
  const textOnly = !attachments.some((a) => a.kind !== "text");
  if (gemini && textOnly && text.length > LONG_TEXT_CHARS) return { provider: "gemini", reason: "a very long text" };
  if (CODE_WORDS.test(text) && has("codex")) return { provider: "codex", reason: "code" };
  if (gemini && textOnly && !WRITING_WORDS.test(text) && !CODE_WORDS.test(text) && isQuick(text, history, attachments.length > 0)) return { provider: "gemini", reason: "a quick question" };
  if (has("claude")) return { provider: "claude", reason: "writing, explaining and planning" };
  return { provider: ready.find((p) => p !== "gemini" || !inProject) ?? ready[0]!, reason: "the best connected tool" };
}

export type Emit = (requestId: string, event: ChatEvent) => void;

export class ChatService {
  private running = new Map<string, { projectId: string; handle: ChatHandle }>();
  private statusCache: { at: number; value: ProviderStatus[] } | null = null;

  constructor(
    private readonly adapters: AdapterSet,
    private readonly cwd: () => string,
    private readonly now: () => number = Date.now,
    // Teams: what teammates are doing in this project right now (null for a solo project).
    private readonly teamNow: (projectId: string) => string | null = () => null,
    // Files the user attached (main/attachments.ts), by id.
    private readonly attachmentFor: (id: string) => Attachment | null = () => null,
  ) {}

  async providers(refresh: boolean): Promise<ProviderStatus[]> {
    if (!refresh && this.statusCache && this.now() - this.statusCache.at < 30_000) return this.statusCache.value;
    const value = await Promise.all(PROVIDER_IDS.map((id) => adapterOf(this.adapters, id).status().catch((error: unknown) => ({
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
    const attachments = (payload.attachments ?? []).map((id) => {
      const found = this.attachmentFor(id);
      if (!found) throw new Error("An attached file is no longer available. Attach it again.");
      return found;
    });
    // "Auto" as the tool: the message decides which connected tool answers (pickTool), and then its model.
    const ready = (this.statusCache?.value ?? []).filter((s) => s.installed && s.subscription).map((s) => s.provider);
    const routed = payload.provider === AUTO ? pickTool(payload.text, attachments, ready, Boolean(payload.team), payload.history) : null;
    const provider: ProviderId = routed ? routed.provider : (payload.provider as ProviderId);
    // "Auto" as the model: a quick question gets a light, fast model; work, files and longer questions a stronger one.
    const model = payload.model === AUTO || routed ? autoModel(provider, payload, attachments.length > 0, this.statusCache?.value ?? []) : payload.model;
    if (routed) emit(payload.requestId, { type: "routed", provider, model, reason: routed.reason });
    const request = {
      provider, model, effort: routed ? null : payload.effort, history: payload.history, text: payload.text, cwd: this.cwd(), ...(payload.team ? { team: payload.team } : {}),
      teamNow: this.teamNowFor(payload.projectId),
      ...(attachments.length ? { attachments } : {}),
      ...(payload.memory?.length ? { memory: payload.memory } : {}),
    };
    const first = adapterOf(this.adapters, provider).chat(request);
    // stop() reaches whichever request is current (the second one, when the Manager asks to plan).
    const current = { handle: first };
    const handle: ChatHandle = { events: first.events, stop: () => current.handle.stop() };
    this.running.set(payload.requestId, { projectId: payload.projectId, handle });
    void (async () => {
      try {
        const answer = await relayUntilPlanNeeded(first, (event) => emit(payload.requestId, event));
        if (answer) {
          // The light prompt was not enough: ask again with the planning instructions. The window
          // never sees the marker; it gets the second reply, with both calls' usage added up.
          // Planning needs the stronger model when "Auto" chose a light one for what looked like a quick question.
          const planModel = payload.model === AUTO || routed ? autoModel(provider, { text: payload.text, history: payload.history }, true, this.statusCache?.value ?? []) : request.model;
          const second = adapterOf(this.adapters, provider).chat({ ...request, model: planModel, planMode: true });
          current.handle = second;
          for await (const event of second.events) emit(payload.requestId, event.type === "completed" ? { ...event, usage: addUsage(answer.usage, event.usage) } : event);
        }
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

// Passes a reply's events on, except when the whole reply is the "plan needed" marker: then nothing
// of it is shown, and its completed event is returned so the caller can ask again. Text that could
// still turn out to be the marker is held back until it is clear.
export async function relayUntilPlanNeeded(handle: ChatHandle, emit: (event: ChatEvent) => void): Promise<Extract<ChatEvent, { type: "completed" }> | null> {
  let held: ChatEvent[] = [];
  let text = "";
  let open = true;
  for await (const event of handle.events) {
    if (event.type === "completed" && event.text.trim() === PLAN_NEEDED) return event;
    if (open && event.type === "delta") {
      text += event.text;
      if (PLAN_NEEDED.startsWith(text.trimStart())) {
        held.push(event);
        continue;
      }
      open = false;
      for (const h of held) emit(h);
      held = [];
    }
    if (open && event.type === "started") {
      held.push(event);
      continue;
    }
    if (open && event.type !== "delta") {
      open = false;
      for (const h of held) emit(h);
      held = [];
    }
    emit(event);
  }
  return null;
}

export function addUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (!a || !b) return b ?? null;
  const sum = (x: number | null | undefined, y: number | null | undefined) => (x == null || y == null ? null : x + y);
  return { inputTokens: sum(a.inputTokens, b.inputTokens), outputTokens: sum(a.outputTokens, b.outputTokens), cachedInputTokens: sum(a.cachedInputTokens ?? 0, b.cachedInputTokens ?? 0) };
}
