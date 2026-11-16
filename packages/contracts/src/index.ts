// Foundation-level contract between the engine and provider adapters.
// A later stage extends it (interrupt, capabilities, approvals) per docs/architecture.md §6.

export type ProviderErrorCategory =
  | "task_failure"
  | "rate_limit"
  | "overloaded"
  | "unauthorized"
  | "unknown";

export type ProviderEvent =
  | { type: "started"; sessionRef: string; model: string }
  | { type: "text"; text: string }
  | { type: "completed"; summary: string }
  | { type: "failed"; category: ProviderErrorCategory; message: string };

export interface TaskRequest {
  taskId: string;
  nodeId: string;
  projectPath: string;
  model: string;
  prompt: string;
  sessionRef?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  startTask(request: TaskRequest): AsyncIterable<ProviderEvent>;
}
