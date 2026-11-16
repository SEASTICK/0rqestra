import { describe, expect, it } from "vitest";
import type { TaskRequest } from "@worktreeai/contracts";
import { FakeProvider } from "@worktreeai/provider-fake";
import { runTask } from "./index.js";

const request: TaskRequest = {
  taskId: "task-1",
  nodeId: "builder-1",
  projectPath: "/fixtures/p1",
  model: "fake-model",
  prompt: "Add input validation to the signup form",
};

describe("runTask with the fake provider", () => {
  it("returns succeeded with all events in order when the provider completes", async () => {
    const provider = new FakeProvider([
      { type: "started", sessionRef: "s-1", model: "fake-model" },
      { type: "text", text: "working" },
      { type: "completed", summary: "done" },
    ]);

    const result = await runTask(provider, request);

    expect(result.status).toBe("succeeded");
    expect(result.events.map((e) => e.type)).toEqual(["started", "text", "completed"]);
    expect(provider.launches).toEqual([request]);
  });

  it("returns the provider's error category when the provider fails", async () => {
    const provider = new FakeProvider([
      { type: "started", sessionRef: "s-2", model: "fake-model" },
      { type: "failed", category: "rate_limit", message: "limit reached" },
    ]);

    const result = await runTask(provider, request);

    expect(result).toMatchObject({ status: "failed", category: "rate_limit" });
  });

  it("treats a stream that ends without a terminal event as failed", async () => {
    const provider = new FakeProvider([{ type: "started", sessionRef: "s-3", model: "fake-model" }]);

    const result = await runTask(provider, request);

    expect(result).toMatchObject({ status: "failed", category: "no_terminal_event" });
  });
});
