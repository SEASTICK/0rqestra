import type { FailureReason, ProviderId } from "../providers/types";

// Why a task stopped, in a form the run card can act on: a short explanation, what the app saw, and
// enough detail (provider, agent, teammate, findings, needs) for the one action that helps next.

export type ReasonKind =
  | "signed_out" // the agent's tool is not installed or not signed in with a subscription
  | "usage_limit" // the subscription's usage limit is reached
  | "agent_missing" // no agent in the tree has the task's role
  | "model_unavailable" // the tool refused the agent's model
  | "reservation" // a teammate's reservation covers a file this task writes
  | "review_rejected" // the reviewer (or the app's own checks) did not approve the last attempt
  | "needs_context" // the task needs something from the Manager or the user
  | "limit" // the run's request limit was reached
  | "dependency" // an earlier task it needs did not finish
  | "unknown";

export interface ReservationConflict { name: string; task: string; branch: string | null; overlaps: { yours: string; theirs: string }[] }

export interface TaskReason {
  kind: ReasonKind;
  // One sentence for the card.
  title: string;
  // What the app observed (the underlying error), for "Technical details".
  detail: string;
  provider?: ProviderId;
  agentId?: string;
  agentName?: string;
  role?: string;
  model?: string | null;
  conflicts?: ReservationConflict[];
  findings?: string[];
  reviewer?: string;
  needs?: string[];
  // The task this one waits for (dependency).
  after?: string[];
  // Usage limit: when it resets (seconds since the epoch), only if the provider reported it.
  resetsAt?: number | null;
  // Usage limit: a configured backup agent that can continue from the checkpoint (when 0rqestra asks first).
  backup?: { id: string; name: string; tool: ProviderId };
}

// A failed request to an agent's tool, with the tool's own reason (providers/types FailureReason).
export class ProviderFailure extends Error {
  constructor(message: string, readonly reason: FailureReason, readonly provider: ProviderId, readonly agentId: string, readonly agentName: string, readonly model: string | null, readonly resetsAt: number | null = null) {
    super(message);
  }
}

export const TOOL_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini" };
const MODEL_REFUSED = /model/i;
const MODEL_WORDS = /(not found|not available|unavailable|invalid|does not exist|unknown|not supported|unsupported|no access|not allowed|access to)/i;

export function providerReason(error: ProviderFailure): TaskReason {
  const tool = TOOL_NAME[error.provider] ?? error.provider;
  const base = { provider: error.provider, agentId: error.agentId, agentName: error.agentName, model: error.model, detail: error.message };
  switch (error.reason) {
    case "not_installed":
      return { ...base, kind: "signed_out", title: `${tool} is not installed on this computer, so ${error.agentName} could not work.` };
    case "not_signed_in":
      return { ...base, kind: "signed_out", title: `${tool} is signed out, so ${error.agentName} could not work.` };
    case "not_subscription":
      return { ...base, kind: "signed_out", title: `${tool} is not signed in with a subscription, so nothing was sent for ${error.agentName}.` };
    case "usage_limit":
      return { ...base, kind: "usage_limit", title: `The usage limit of your ${tool} plan is reached, so ${error.agentName} stopped.`, ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}) };
    default:
      if (MODEL_REFUSED.test(error.message) && MODEL_WORDS.test(error.message)) {
        return { ...base, kind: "model_unavailable", title: `${tool} refused ${error.model ? `the model ${error.model}` : "the agent's model"} for ${error.agentName}.` };
      }
      return { ...base, kind: "unknown", title: `${tool} did not finish ${error.agentName}'s request (${error.reason.replace(/_/g, " ")}).` };
  }
}

// Provider problems that the same agent cannot get past by asking again.
export function isStuck(error: unknown): error is ProviderFailure {
  return error instanceof ProviderFailure && ["not_installed", "not_signed_in", "not_subscription", "usage_limit"].includes(error.reason);
}
