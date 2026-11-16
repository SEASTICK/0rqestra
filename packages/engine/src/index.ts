import type {
  ProviderAdapter,
  ProviderErrorCategory,
  ProviderEvent,
  TaskRequest,
} from "@0rqestra/contracts";

export type TaskResult =
  | { status: "succeeded"; summary: string; events: ProviderEvent[] }
  | {
      status: "failed";
      category: ProviderErrorCategory | "no_terminal_event";
      message: string;
      events: ProviderEvent[];
    };

// Foundation-level single-task runner. Routing, retries, and the task state machine come in a later stage.
export async function runTask(adapter: ProviderAdapter, request: TaskRequest): Promise<TaskResult> {
  const events: ProviderEvent[] = [];
  for await (const event of adapter.startTask(request)) {
    events.push(event);
    if (event.type === "completed") {
      return { status: "succeeded", summary: event.summary, events };
    }
    if (event.type === "failed") {
      return { status: "failed", category: event.category, message: event.message, events };
    }
  }
  return {
    status: "failed",
    category: "no_terminal_event",
    message: "Provider stream ended without a completed or failed event.",
    events,
  };
}
