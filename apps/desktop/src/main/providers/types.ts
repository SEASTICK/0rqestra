// What the chat needs from a provider tool, independent of which tool it is. The first adapters
// drive the user's own subscription tools (Claude Code, Codex); API-key adapters can be added
// behind the same interface later (docs/backend-plan.md, phase 7).

export type ProviderId = "claude" | "codex";
export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex"];

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ChatRequest {
  provider: ProviderId;
  model: string | null;
  effort: string | null;
  history: ChatTurn[];
  text: string;
  cwd: string;
  // Team runs send their own full prompt; the chat's Manager preamble and history are not added.
  raw?: boolean;
  // The agents in the tree, so the Manager can plan work for them.
  team?: TeamMember[];
}

export interface TeamMember {
  name: string;
  role: string;
  // True when the agent runs on Claude Code or Codex; an agent without a tool cannot work yet.
  ready: boolean;
}

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface RateLimit {
  label: string;
  usedPercent: number;
  windowMinutes: number | null;
  // When the window starts over (Unix seconds), when the tool says so.
  resetsAt?: number | null;
}

export type FailureReason =
  | "not_installed"
  | "not_signed_in"
  | "not_subscription"
  | "usage_limit"
  | "timeout"
  | "provider_error"
  | "crashed";

export type ChatEvent =
  | { type: "started"; model: string | null }
  | { type: "delta"; text: string }
  | { type: "completed"; text: string; usage: Usage | null; limits: RateLimit[] }
  | { type: "cancelled"; text: string }
  | { type: "failed"; reason: FailureReason; message: string; text: string };

export interface ModelOption {
  id: string;
  label: string;
  efforts: string[];
  isDefault: boolean;
}

export interface ProviderStatus {
  provider: ProviderId;
  name: string;
  installed: boolean;
  version: string | null;
  signedIn: boolean;
  plan: string | null;
  // True only when the tool is signed in with a subscription. A chat is never started otherwise,
  // so 0rqestra can never cause pay-per-use API billing by accident.
  subscription: boolean;
  models: ModelOption[];
  limits: RateLimit[];
  // When `limits` were last read (milliseconds). Claude Code reports them only during a reply, so they
  // can be from earlier; null or absent when they were read just now.
  limitsAt?: number | null;
  problem: string | null;
  // How the tool is signed in: a subscription, an API key (never used by 0rqestra), or something else
  // (a cloud provider, a token from the environment). Null when signed out or unknown.
  authMethod?: AuthMethod | null;
  // Where the tool was found, for AI accounts. Never a choice the window can make.
  binaryPath?: string | null;
  source?: string | null;
  // True when the tool is installed but its version or sign-in state could not be read.
  checkFailed?: boolean;
}

export type AuthMethod = "subscription" | "api_key" | "other";

export interface ChatHandle {
  events: AsyncIterable<ChatEvent>;
  stop(): void;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  status(): Promise<ProviderStatus>;
  chat(request: ChatRequest): ChatHandle;
}

// A small push-based async queue: adapters push events as they arrive, the caller iterates.
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  get isEnded(): boolean {
    return this.ended;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
