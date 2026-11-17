import { describe, expect, it } from "vitest";
import { ChatService, MAX_RUNNING, parseSend } from "./chat-service.js";
import { EventQueue, type ChatEvent, type ChatRequest, type ProviderAdapter, type ProviderId, type ProviderStatus } from "./providers/types.js";

const valid = { requestId: "req-00001", projectId: "p1", provider: "claude", model: "opus", effort: null, history: [{ role: "user", text: "hi" }], text: "Hej" };

describe("parseSend", () => {
  it("accepts a valid request and normalises empty model and effort", () => {
    expect(parseSend(valid)).toEqual({ ...valid, history: [{ role: "user", text: "hi" }], team: [] });
    expect(parseSend({ ...valid, team: [{ name: " Code builder ", role: "Builder", ready: true }] }).team).toEqual([{ name: "Code builder", role: "Builder", ready: true }]);
    expect(parseSend({ ...valid, model: "", effort: undefined })).toMatchObject({ model: null, effort: null });
  });

  it("rejects anything that could become an argument or a path, or is malformed", () => {
    for (const bad of [
      null, "x", { ...valid, requestId: "short" }, { ...valid, requestId: "../../etc/x" }, { ...valid, projectId: "a b" },
      { ...valid, provider: "bash" }, { ...valid, model: "opus; rm -rf" }, { ...valid, model: "--dangerously-skip-permissions" },
      { ...valid, effort: "HIGH!" }, { ...valid, text: "   " }, { ...valid, text: "x".repeat(20_001) },
      { ...valid, history: "nope" }, { ...valid, team: [{ name: "x", role: "Builder; rm" }] }, { ...valid, team: "x" }, { ...valid, history: [{ role: "system", text: "x" }] }, { ...valid, history: Array(201).fill({ role: "user", text: "x" }) },
    ]) {
      expect(() => parseSend(bad), JSON.stringify(bad)?.slice(0, 60)).toThrow();
    }
  });
});

class FakeAdapter implements ProviderAdapter {
  requests: ChatRequest[] = [];
  queues: EventQueue<ChatEvent>[] = [];
  stopped = 0;
  statusCalls = 0;
  constructor(readonly id: ProviderId) {}
  async status(): Promise<ProviderStatus> {
    this.statusCalls += 1;
    return { provider: this.id, name: this.id, installed: true, version: "1", signedIn: true, plan: "plus", subscription: true, models: [], limits: [], problem: null };
  }
  chat(request: ChatRequest) {
    this.requests.push(request);
    const queue = new EventQueue<ChatEvent>();
    this.queues.push(queue);
    return { events: queue, stop: () => { this.stopped += 1; queue.push({ type: "cancelled", text: "" }); queue.end(); } };
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const claude = new FakeAdapter("claude");
  const codex = new FakeAdapter("codex");
  let now = 0;
  const service = new ChatService({ claude, codex }, () => "/tmp/chat", () => now);
  const emitted: [string, ChatEvent][] = [];
  const emit = (id: string, event: ChatEvent) => void emitted.push([id, event]);
  return { claude, codex, service, emitted, emit, advance: (ms: number) => (now += ms) };
}

describe("ChatService", () => {
  it("passes a validated request to the right tool, in the chat folder, and forwards its events", async () => {
    const { claude, codex, service, emitted, emit } = setup();
    service.start(valid, emit);
    expect(codex.requests).toEqual([]);
    expect(claude.requests[0]).toMatchObject({ model: "opus", text: "Hej", cwd: "/tmp/chat" });
    claude.queues[0]!.push({ type: "delta", text: "Hi" });
    claude.queues[0]!.push({ type: "completed", text: "Hi", usage: null, limits: [] });
    claude.queues[0]!.end();
    await tick();
    expect(emitted.map(([id, e]) => [id, e.type])).toEqual([["req-00001", "delta"], ["req-00001", "completed"]]);
    expect(service.runningCount).toBe(0);
  });

  it("allows one reply per project and a few at once", async () => {
    const { service, emit } = setup();
    service.start(valid, emit);
    expect(() => service.start({ ...valid, requestId: "req-00002" }, emit)).toThrow(/already being written/);
    expect(() => service.start(valid, emit)).toThrow(/already running/);
    for (let i = 2; i <= MAX_RUNNING; i += 1) service.start({ ...valid, requestId: `req-0000${i}`, projectId: `p${i}` }, emit);
    expect(() => service.start({ ...valid, requestId: "req-00099", projectId: "p99" }, emit)).toThrow(/Too many/);
  });

  it("stops a running reply and ignores unknown ids", async () => {
    const { claude, service, emitted, emit } = setup();
    service.start(valid, emit);
    expect(service.stop("unknown-id")).toBe(false);
    expect(service.stop(42)).toBe(false);
    expect(service.stop("req-00001")).toBe(true);
    await tick();
    expect(claude.stopped).toBe(1);
    expect(emitted.at(-1)?.[1].type).toBe("cancelled");
    expect(service.runningCount).toBe(0);
  });

  it("caches the tool status for 30 seconds unless asked to refresh", async () => {
    const { claude, service, advance } = setup();
    await service.providers(false);
    await service.providers(false);
    expect(claude.statusCalls).toBe(1);
    await service.providers(true);
    expect(claude.statusCalls).toBe(2);
    advance(30_001);
    await service.providers(false);
    expect(claude.statusCalls).toBe(3);
  });
});
