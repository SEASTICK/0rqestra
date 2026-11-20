import type { ChatEvent, ChatHandle, ChatRequest, ProviderAdapter, ProviderId, ProviderStatus, RateLimit } from "./types";

// The last usage windows each tool reported in a reply. Claude Code reports them only while it
// answers, so the window shows the latest values with their time; Codex can also be asked directly.

export class LimitsStore {
  private latest = new Map<ProviderId, { limits: RateLimit[]; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  record(provider: ProviderId, limits: RateLimit[]): void {
    if (limits.length) this.latest.set(provider, { limits, at: this.now() });
  }

  get(provider: ProviderId): { limits: RateLimit[]; at: number } | null {
    return this.latest.get(provider) ?? null;
  }

  // Statuses with the newest limits: what the tool reported in its status check when it has some,
  // otherwise the last ones seen in a reply, with their time.
  merge(statuses: ProviderStatus[]): ProviderStatus[] {
    return statuses.map((status) => {
      const seen = this.latest.get(status.provider);
      if (status.limits.length || !seen) return { ...status, limitsAt: null };
      return { ...status, limits: seen.limits, limitsAt: seen.at };
    });
  }
}

// Makes an adapter tell the store about the limits in each completed reply (chat, planning and team runs).
export function recordLimits<T extends ProviderAdapter>(adapter: T, store: LimitsStore): T {
  const chat = adapter.chat.bind(adapter);
  adapter.chat = (request: ChatRequest): ChatHandle => {
    const handle = chat(request);
    async function* events(): AsyncGenerator<ChatEvent> {
      for await (const event of handle.events) {
        if (event.type === "completed") store.record(adapter.id, event.limits);
        yield event;
      }
    }
    return { events: events(), stop: () => handle.stop() };
  };
  return adapter;
}
