import type { Usage } from "../providers/types";

// Stage 3: every model request a team run makes, with the usage the tool reported for it. One entry
// per request (never per streamed update), kept as numbers only: no prompts, file contents or keys.
// A request without reported usage counts as a call and makes the totals "partial".

export type CallKind = "worker" | "review" | "follow-up";

export interface UsageEntry {
  seq: number;
  taskId: string;
  agentId: string;
  agentName: string;
  role: string;
  tool: string;
  model: string | null;
  kind: CallKind;
  attempt: number;
  outcome: "completed" | "failed" | "cancelled";
  // null: the tool did not report it ("Unavailable").
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

export interface AgentUsage {
  agentId: string;
  agentName: string;
  role: string;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  unavailableCalls: number;
}

export interface UsageTotals {
  calls: number;
  workerCalls: number;
  reviewCalls: number;
  followUpCalls: number;
  retries: number;
  contextRequests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  // Calls whose input or output tokens were not reported; the token totals leave them out.
  unavailableCalls: number;
  partial: boolean;
  byAgent: AgentUsage[];
}

export class UsageLedger {
  private readonly entries = new Map<number, UsageEntry>();
  private next = 1;
  retries = 0;
  contextRequests = 0;

  // A new request gets its number before it is sent, so its usage is recorded exactly once.
  open(): number {
    return this.next++;
  }

  record(seq: number, meta: Omit<UsageEntry, "seq" | "inputTokens" | "cachedInputTokens" | "outputTokens">, usage: Usage | null): UsageEntry | null {
    if (this.entries.has(seq)) return null;
    const entry: UsageEntry = { seq, ...meta, inputTokens: usage?.inputTokens ?? null, cachedInputTokens: usage?.cachedInputTokens ?? null, outputTokens: usage?.outputTokens ?? null };
    this.entries.set(seq, entry);
    return entry;
  }

  all(): UsageEntry[] {
    return [...this.entries.values()];
  }

  totals(): UsageTotals {
    return summarize(this.all(), this.retries, this.contextRequests);
  }
}

export function summarize(entries: UsageEntry[], retries: number, contextRequests: number): UsageTotals {
  const byAgent = new Map<string, AgentUsage>();
  const t: UsageTotals = { calls: 0, workerCalls: 0, reviewCalls: 0, followUpCalls: 0, retries, contextRequests, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, unavailableCalls: 0, partial: false, byAgent: [] };
  for (const e of entries) {
    t.calls += 1;
    if (e.kind === "worker") t.workerCalls += 1;
    else if (e.kind === "review") t.reviewCalls += 1;
    else t.followUpCalls += 1;
    const a = byAgent.get(e.agentId) ?? { agentId: e.agentId, agentName: e.agentName, role: e.role, calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, unavailableCalls: 0 };
    a.calls += 1;
    if (e.inputTokens === null || e.outputTokens === null) {
      t.unavailableCalls += 1;
      a.unavailableCalls += 1;
    }
    t.inputTokens += e.inputTokens ?? 0;
    t.cachedInputTokens += e.cachedInputTokens ?? 0;
    t.outputTokens += e.outputTokens ?? 0;
    a.inputTokens += e.inputTokens ?? 0;
    a.cachedInputTokens += e.cachedInputTokens ?? 0;
    a.outputTokens += e.outputTokens ?? 0;
    byAgent.set(e.agentId, a);
  }
  t.partial = t.unavailableCalls > 0;
  t.byAgent = [...byAgent.values()];
  return t;
}
