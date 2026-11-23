import fs from "node:fs";
import type { ChatEvent, ChatHandle, ChatRequest, ProviderAdapter, ProviderId, ProviderStatus, RateLimit } from "./types";

// The last usage windows each tool reported in a reply. Claude Code reports them only while it
// answers, so the window shows the latest values with their time; Codex can also be asked directly.

export class LimitsStore {
  private latest = new Map<ProviderId, { limits: RateLimit[]; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private file: string | null = null;

  // Keeps the last values on disk, so Claude's percentages are still there after a restart (Claude Code
  // reports them only during a reply). A missing or damaged file just means there is nothing yet.
  persistTo(file: string): void {
    this.file = file;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { limits?: unknown; at?: unknown }>;
      for (const id of ["claude", "codex"] as const) {
        const v = saved[id];
        if (v && Array.isArray(v.limits) && typeof v.at === "number" && !this.latest.has(id)) {
          const limits = (v.limits as RateLimit[]).filter((l) => l && typeof l.label === "string" && typeof l.usedPercent === "number" && Number.isFinite(l.usedPercent));
          if (limits.length) this.latest.set(id, { limits, at: v.at });
        }
      }
    } catch {
      /* nothing saved yet */
    }
  }

  record(provider: ProviderId, limits: RateLimit[]): void {
    if (!limits.length) return;
    const old = this.latest.get(provider)?.limits ?? [];
    // A reply can report only the window that limits right now: keep the other window's last value.
    const merged = [...old.filter((o) => !limits.some((l) => l.label === o.label)), ...limits];
    this.latest.set(provider, { limits: merged, at: this.now() });
    if (this.file) {
      try {
        fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.latest)));
      } catch {
        /* the values are still shown for this run */
      }
    }
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
