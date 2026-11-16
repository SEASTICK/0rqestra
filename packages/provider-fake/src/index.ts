import type { ProviderAdapter, ProviderEvent, TaskRequest } from "@0rqestra/contracts";

export type FakeScript = readonly ProviderEvent[] | ((request: TaskRequest) => readonly ProviderEvent[]);

// Deterministic adapter for tests: replays scripted events and records every launch.
export class FakeProvider implements ProviderAdapter {
  readonly id = "fake";
  readonly launches: TaskRequest[] = [];

  constructor(private readonly script: FakeScript) {}

  async *startTask(request: TaskRequest): AsyncIterable<ProviderEvent> {
    this.launches.push({ ...request });
    const events = typeof this.script === "function" ? this.script(request) : this.script;
    for (const event of events) {
      yield event;
    }
  }
}
