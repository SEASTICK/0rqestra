// Process handling, outcome classification, and stop-on-failure sequencing for the probes.
// Nothing here knows about a real provider, so all of it is tested offline with fake processes.
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (reason) => ({ outcome: "failed", reason });

// Runs a process that prints JSON lines. Never rejects: spawn errors, timeouts, and driver
// errors are returned as fields so the caller can record them as evidence.
export function runStreamProcess(bin, args, { cwd, env, timeoutMs = 120_000, drive } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const events = [];
    const run = { events, stderr: "", started, code: null, signal: null, spawnError: null, driveError: null, timedOut: false };
    let buffer = "";
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.durationMs = Date.now() - started;
      resolve(run);
    };

    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      run.spawnError = error.message;
      finish();
      return;
    }
    timer = setTimeout(() => {
      run.timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      run.spawnError = error.message;
      finish();
    });
    child.stdin.on("error", () => {});
    child.stderr.on("data", (data) => { run.stderr = (run.stderr + data).slice(-800); });
    child.stdout.on("data", (data) => {
      buffer += data;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          events.push({ ...JSON.parse(line), _t: Date.now() });
        } catch {
          events.push({ type: "unparsed", text: line.slice(0, 200), _t: Date.now() });
        }
      }
    });
    child.on("exit", (code, signal) => {
      run.code = code;
      run.signal = signal;
    });
    child.on("close", finish);

    Promise.resolve()
      .then(() => (drive ? drive(child, events, started) : child.stdin.end()))
      .catch((error) => {
        run.driveError = error.message;
        child.kill();
      });
  });
}

// Classifies one `claude -p --output-format stream-json` run.
//
// "cancelled" is returned only when OUR interrupt is acknowledged and the turn then ends: a
// control_response with the same request_id and subtype "success", followed by a result with
// subtype "error_during_execution", and then a process exit with code 1 and no signal (the
// exit observed for an interrupted run, C12). Any other error result is an independent failure,
// and any other final exit stops the sequence even when the cancellation itself was correlated.
export const CLAUDE_CANCELLED_EXIT_CODE = 1;
export function classifyClaudeRun(run, interrupt = null) {
  if (run.spawnError) return fail(`spawn error: ${run.spawnError}`);
  if (run.driveError) return fail(`driver error: ${run.driveError}`);
  if (run.timedOut) return fail("timed out");
  const result = run.events.find((event) => event.type === "result");
  if (!result) return fail(`missing result (exit code ${run.code}, signal ${run.signal})`);

  if (interrupt?.sent) {
    const ack = run.events.find(
      (event) => event.type === "control_response" && event.response?.request_id === interrupt.requestId,
    );
    const acknowledged = ack?.response?.subtype === "success";
    const resultAfterAck = acknowledged && run.events.indexOf(result) > run.events.indexOf(ack);
    if (resultAfterAck && result.subtype === "error_during_execution") {
      if (run.code !== CLAUDE_CANCELLED_EXIT_CODE || run.signal) {
        return fail(`correlated cancellation, but abnormal process exit: code ${run.code}, signal ${run.signal} (expected code ${CLAUDE_CANCELLED_EXIT_CODE})`);
      }
      return { outcome: "cancelled", reason: "interrupt acknowledged, then the turn ended" };
    }
    if (result.is_error) {
      return fail(
        acknowledged
          ? `result error not attributable to the interrupt: ${result.subtype}`
          : `result error without a correlated interrupt acknowledgement: ${result.subtype}`,
      );
    }
  }

  if (result.is_error) return fail(`result error: ${result.subtype}`);
  if (run.code !== 0 || run.signal) return fail(`unexpected exit code ${run.code} (signal ${run.signal})`);
  return { outcome: "succeeded" };
}

// Minimal JSON-RPC client for `codex app-server` over stdio.
export class AppServer {
  constructor(bin, args, env) {
    this.nextId = 1;
    this.pending = new Map();
    this.log = [];
    this.stderr = "";
    this.onServerRequest = null;
    this.exitInfo = null;
    this.stopRequested = false;
    this.exitedBeforeStop = false;
    this.spawnError = null;

    this.child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.exit = new Promise((resolve) => {
      const done = (info) => {
        if (this.exitInfo) return;
        this.exitInfo = info;
        this.exitedBeforeStop = !this.stopRequested;
        for (const [, settle] of this.pending) settle({ error: { message: `app-server exited before responding (${JSON.stringify(info)})` } });
        this.pending.clear();
        resolve(info);
      };
      this.child.on("error", (error) => {
        this.spawnError = error.message;
        done({ code: null, signal: null, spawnError: error.message });
      });
      this.child.on("close", (code, signal) => done({ code, signal }));
    });
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", (data) => { this.stderr = (this.stderr + data).slice(-2000); });
    let buffer = "";
    this.child.stdout.on("data", (data) => {
      buffer += data;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.handle(line);
      }
    });
  }

  handle(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log.push({ t: Date.now(), kind: "unparsed", text: line.slice(0, 200) });
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      this.log.push({ t: Date.now(), kind: "response", id: message.id, error: message.error });
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    } else if (message.id !== undefined) {
      this.log.push({ t: Date.now(), kind: "serverRequest", id: message.id, method: message.method, params: message.params });
      this.onServerRequest?.(message);
    } else {
      this.log.push({ t: Date.now(), kind: "notification", method: message.method, params: message.params });
    }
  }

  send(message) {
    if (!this.exitInfo) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 30_000) {
    if (this.exitInfo) return Promise.reject(new Error(`${method} not sent: app-server already exited`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method} failed: ${JSON.stringify(message.error).slice(0, 300)}`));
        else resolve(message.result);
      });
      this.send({ method, id, params });
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: { name: "orqestra_probe", title: "0rqestra probe", version: "0.0.0" },
    });
    this.send({ method: "initialized", params: {} });
    return result;
  }

  notifications(method) {
    return this.log.filter((entry) => entry.kind === "notification" && entry.method === method);
  }

  // Resolves with the matching log entry, or null on timeout or when the process exits first.
  async waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.log.find(predicate);
      if (found) return found;
      if (this.exitInfo) return this.log.find(predicate) ?? null;
      await sleep(50);
    }
    return null;
  }

  // Closes stdin and waits for the process to exit by itself. If it does not within 5 s it is
  // killed, and the returned exit info says so (forcedKill), which counts as an abnormal shutdown.
  async stop() {
    this.stopRequested = true;
    if (!this.exitInfo) this.child.stdin.end();
    const exited = await Promise.race([this.exit, sleep(5_000).then(() => null)]);
    if (exited) return exited;
    this.child.kill();
    return { ...(await this.exit), forcedKill: true };
  }
}

// A normal app-server shutdown: it exited by itself after stdin closed, with code 0 and no signal.
// Returns null when normal, otherwise a reason.
export function abnormalShutdown(exitInfo) {
  if (!exitInfo) return "no exit recorded";
  if (exitInfo.spawnError) return `spawn error: ${exitInfo.spawnError}`;
  if (exitInfo.forcedKill) return "did not exit after stdin closed and was killed";
  if (exitInfo.code !== 0 || exitInfo.signal) return `exit code ${exitInfo.code}, signal ${exitInfo.signal}`;
  return null;
}

// Classifies one Codex turn from what the client recorded.
//
// "cancelled" requires OUR turn/interrupt to have been acknowledged for this turn and a
// turn/completed with status "interrupted" for the same turn id, arriving after our request. An interrupted or failed turn
// without that correlation is a failure. Every outcome, cancellation included, also requires a
// normal app-server shutdown afterwards (abnormalShutdown).
export function classifyCodexTurn({ error, exitedBeforeStop, exitInfo, turnId, completions = [], errorNotifications = [], interrupt = null }) {
  if (error) return fail(`scenario error: ${error}`);
  if (exitedBeforeStop) return fail(`app-server exited unexpectedly (${JSON.stringify(exitInfo)})`);
  const shutdown = abnormalShutdown(exitInfo);
  if (shutdown) return fail(`abnormal app-server shutdown: ${shutdown}`);
  if (!turnId) return fail("no turn id: turn/start did not return a turn");
  const completion = completions.find((entry) => entry.id === turnId);
  if (!completion) return fail("missing turn/completed for this turn");
  const fatal = errorNotifications.find((entry) => entry?.willRetry === false);
  if (completion.status === "interrupted") {
    const ours = interrupt?.acknowledged && interrupt.turnId === turnId;
    if (!ours) return fail("turn interrupted without a correlated turn/interrupt acknowledgement");
    if (!(completion.atMs >= interrupt.requestedAtMs)) return fail("turn was interrupted before our turn/interrupt was sent");
    return { outcome: "cancelled", reason: "turn/interrupt acknowledged, then the turn ended as interrupted" };
  }
  if (completion.status !== "completed") return fail(`turn ended with status ${completion.status}`);
  if (fatal) return fail(`error notification: ${JSON.stringify(fatal).slice(0, 200)}`);
  return { outcome: "succeeded" };
}

// Runs scenarios in order and stops after the first one that failed, was skipped, or threw.
// `persist` is called after EVERY scenario, so partial evidence exists before anything stops.
export async function runSequence(definitions, persist) {
  const scenarios = [];
  for (const [index, definition] of definitions.entries()) {
    let entry;
    try {
      entry = await definition.run();
    } catch (error) {
      entry = { failure: `scenario error: ${error.message}` };
    }
    entry.name ??= definition.name;
    scenarios.push(entry);
    const reason = entry.failure ?? entry.skipped ?? null;
    const state = {
      scenarios,
      complete: !reason && index === definitions.length - 1,
      stoppedAfter: reason ? { name: entry.name, reason } : null,
      notRun: reason ? definitions.slice(index + 1).map((d) => d.name) : [],
    };
    await persist(state);
    if (reason) return state;
  }
  return { scenarios, complete: true, stoppedAfter: null, notRun: [] };
}
