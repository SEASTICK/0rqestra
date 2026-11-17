// Offline tests for the probe runners. Every process started here is a local Node script from
// test-fixtures/. No provider binary is run and no model request is possible.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main as claudeMain } from "./claude-auth.mjs";
import { handshake as codexHandshake, isCorrelatedApproval, turns as codexTurns } from "./codex-appserver.mjs";
import { abnormalShutdown, classifyClaudeRun, classifyCodexTurn, runSequence, runStreamProcess } from "./runner.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-fixtures");
const fakeClaude = path.join(fixtures, "fake-claude.mjs");
const fakeAppServer = path.join(fixtures, "fake-appserver.mjs");
const node = process.execPath;
const quiet = () => {};

let outDir;
beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "orqestra-probe-test-"));
  process.env.ORQESTRA_PROBE_OUT = outDir;
});
afterEach(() => {
  delete process.env.ORQESTRA_PROBE_OUT;
  fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const saved = (name) => JSON.parse(fs.readFileSync(path.join(outDir, `${name}.json`), "utf8"));
const ledger = () => {
  const file = path.join(outDir, "request-ledger.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
};

describe("runStreamProcess with classifyClaudeRun (fake process)", () => {
  const run = (mode, options) => runStreamProcess(node, [fakeClaude, mode, "-p", "x"], options);

  it("classifies a normal run as succeeded", async () => {
    expect(classifyClaudeRun(await run("ok"))).toEqual({ outcome: "succeeded" });
  });

  it("fails on an error result", async () => {
    expect(classifyClaudeRun(await run("error-result"))).toMatchObject({ outcome: "failed", reason: "result error: error_max_turns" });
  });

  it("fails when the process exits without a result", async () => {
    expect(classifyClaudeRun(await run("no-result")).reason).toMatch(/^missing result/);
    expect(classifyClaudeRun(await run("crash")).reason).toMatch(/^missing result \(exit code 7/);
  });

  it("fails on an unexpected exit code even when a success result was printed", async () => {
    expect(classifyClaudeRun(await run("exit-3")).reason).toMatch(/^unexpected exit code 3/);
  });

  it("fails on a timeout and kills the process", async () => {
    const result = await run("hang", { timeoutMs: 400 });
    expect(result.timedOut).toBe(true);
    expect(classifyClaudeRun(result)).toEqual({ outcome: "failed", reason: "timed out" });
  });

  it("fails on a spawn error without throwing", async () => {
    const result = await runStreamProcess(path.join(outDir, "no-such-binary"), ["-p", "x"]);
    expect(result.spawnError).toBeTruthy();
    expect(classifyClaudeRun(result).reason).toMatch(/^spawn error/);
  });

  it("fails when the driver throws", async () => {
    const result = await run("hang", { drive: () => { throw new Error("driver broke"); } });
    expect(classifyClaudeRun(result)).toEqual({ outcome: "failed", reason: "driver error: driver broke" });
  });
});

describe("classifyClaudeRun interrupt correlation", () => {
  const base = { spawnError: null, driveError: null, timedOut: false, code: 1, signal: null };
  const ack = (id) => ({ type: "control_response", response: { subtype: "success", request_id: id } });
  const errorResult = { type: "result", subtype: "error_during_execution", is_error: true };
  const interrupt = { requestId: "r1", sent: true };

  it("is cancelled only when our interrupt is acknowledged and the result follows", () => {
    expect(classifyClaudeRun({ ...base, events: [ack("r1"), errorResult] }, interrupt).outcome).toBe("cancelled");
  });

  it("is a failure when no acknowledgement arrives", () => {
    expect(classifyClaudeRun({ ...base, events: [errorResult] }, interrupt).reason).toMatch(/without a correlated interrupt acknowledgement/);
  });

  it("is a failure when the acknowledgement is for a different request", () => {
    expect(classifyClaudeRun({ ...base, events: [ack("other"), errorResult] }, interrupt).outcome).toBe("failed");
  });

  it("is a failure when the error result came before the acknowledgement", () => {
    expect(classifyClaudeRun({ ...base, events: [errorResult, ack("r1")] }, interrupt).reason).toMatch(/not attributable to the interrupt/);
  });

  it("is a failure when the same error happens and no interrupt was sent", () => {
    expect(classifyClaudeRun({ ...base, events: [errorResult] }, { requestId: "r1", sent: false })).toEqual({
      outcome: "failed", reason: "result error: error_during_execution",
    });
  });

  it("fails a correlated cancellation when the process then exits abnormally", () => {
    const run = (extra) => classifyClaudeRun({ ...base, ...extra, events: [ack("r1"), errorResult] }, interrupt);
    expect(run({ code: 7 }).reason).toMatch(/correlated cancellation, but abnormal process exit: code 7/);
    expect(run({ code: 0 }).outcome).toBe("failed");
    expect(run({ code: null, signal: "SIGKILL" }).reason).toMatch(/signal SIGKILL/);
  });

  it("fails a success result when the process was ended by a signal", () => {
    const success = { type: "result", subtype: "success", is_error: false };
    expect(classifyClaudeRun({ ...base, code: 0, signal: "SIGTERM", events: [success] }).outcome).toBe("failed");
  });

  it("keeps an independent failure even after an acknowledged interrupt", () => {
    const other = { type: "result", subtype: "error_max_turns", is_error: true };
    expect(classifyClaudeRun({ ...base, events: [ack("r1"), other] }, interrupt).reason).toMatch(/not attributable to the interrupt: error_max_turns/);
  });
});

describe("classifyCodexTurn", () => {
  const turnId = "t1";
  const done = (status, atMs = 50) => [{ id: turnId, status, atMs }];
  const clean = { code: 0, signal: null };

  it("succeeds on a completed turn", () => {
    expect(classifyCodexTurn({ exitInfo: clean, turnId, completions: done("completed") })).toEqual({ outcome: "succeeded" });
  });

  it("fails on scenario errors, unexpected exits, and missing completions", () => {
    expect(classifyCodexTurn({ error: "turn/start timed out", turnId }).reason).toMatch(/^scenario error/);
    expect(classifyCodexTurn({ exitedBeforeStop: true, exitInfo: { code: 2 }, turnId, completions: done("completed") }).reason).toMatch(/exited unexpectedly/);
    expect(classifyCodexTurn({ exitInfo: clean, turnId, completions: [] }).reason).toBe("missing turn/completed for this turn");
    expect(classifyCodexTurn({ exitInfo: clean, turnId, completions: [{ id: "other", status: "completed" }] }).outcome).toBe("failed");
    expect(classifyCodexTurn({ exitInfo: clean, turnId: null }).reason).toMatch(/^no turn id/);
  });

  it("fails on a failed turn and on a fatal error notification", () => {
    expect(classifyCodexTurn({ exitInfo: clean, turnId, completions: done("failed") }).reason).toBe("turn ended with status failed");
    expect(classifyCodexTurn({ exitInfo: clean, turnId, completions: done("completed"), errorNotifications: [{ willRetry: false }] }).outcome).toBe("failed");
    expect(classifyCodexTurn({ exitInfo: clean, turnId, completions: done("completed"), errorNotifications: [{ willRetry: true }] }).outcome).toBe("succeeded");
  });

  it("is cancelled only for our acknowledged interrupt, for this turn, before the completion", () => {
    const interrupt = { turnId, acknowledged: true, requestedAtMs: 40 };
    expect(classifyCodexTurn({ exitInfo: clean, turnId, completions: done("interrupted", 50), interrupt }).outcome).toBe("cancelled");
    expect(classifyCodexTurn({ exitInfo: clean, turnId, completions: done("interrupted", 50) }).reason).toMatch(/without a correlated/);
    expect(classifyCodexTurn({ exitInfo: clean, turnId, completions: done("interrupted", 50), interrupt: { ...interrupt, acknowledged: false } }).outcome).toBe("failed");
    expect(classifyCodexTurn({ exitInfo: clean, turnId, completions: done("interrupted", 50), interrupt: { ...interrupt, turnId: "other" } }).outcome).toBe("failed");
    expect(classifyCodexTurn({ exitInfo: clean, turnId, completions: done("interrupted", 30), interrupt }).reason).toMatch(/before our turn\/interrupt was sent/);
  });
});

describe("app-server shutdown and approval correlation", () => {
  it("accepts only a self-initiated exit with code 0 and no signal", () => {
    expect(abnormalShutdown({ code: 0, signal: null })).toBeNull();
    expect(abnormalShutdown({ code: 7, signal: null })).toMatch(/exit code 7/);
    expect(abnormalShutdown({ code: null, signal: "SIGTERM" })).toMatch(/signal SIGTERM/);
    expect(abnormalShutdown({ code: 0, signal: null, forcedKill: true })).toMatch(/was killed/);
    expect(abnormalShutdown({ code: null, signal: null, spawnError: "ENOENT" })).toMatch(/spawn error/);
    expect(abnormalShutdown(null)).toMatch(/no exit recorded/);
  });

  it("fails every Codex outcome, cancellation included, on an abnormal shutdown", () => {
    const completions = [{ id: "t1", status: "interrupted", atMs: 50 }];
    const interrupt = { turnId: "t1", acknowledged: true, requestedAtMs: 40 };
    expect(classifyCodexTurn({ turnId: "t1", completions, interrupt, exitInfo: { code: 7, signal: null } }).reason)
      .toMatch(/abnormal app-server shutdown: exit code 7/);
  });

  it("counts only supported approvals for the active thread and turn", () => {
    const approval = (method, params) => ({ method, params });
    const own = { threadId: "th", turnId: "tu", itemId: "i" };
    expect(isCorrelatedApproval(approval("item/commandExecution/requestApproval", own), "th", "tu")).toBe(true);
    expect(isCorrelatedApproval(approval("item/fileChange/requestApproval", own), "th", "tu")).toBe(true);
    expect(isCorrelatedApproval(approval("item/tool/requestUserInput", own), "th", "tu")).toBe(false);
    expect(isCorrelatedApproval(approval("item/commandExecution/requestApproval", { ...own, turnId: "other" }), "th", "tu")).toBe(false);
    expect(isCorrelatedApproval(approval("item/commandExecution/requestApproval", { ...own, threadId: "other" }), "th", "tu")).toBe(false);
    expect(isCorrelatedApproval(approval("item/commandExecution/requestApproval", own), "th", null)).toBe(false);
  });
});

describe("runSequence", () => {
  const ok = (name) => ({ name, run: async () => ({ name }) });

  it("runs everything when nothing fails and persists after each scenario", async () => {
    const snapshots = [];
    const state = await runSequence([ok("a"), ok("b")], (partial) => snapshots.push(partial.scenarios.length));
    expect(state).toMatchObject({ complete: true, stoppedAfter: null, notRun: [] });
    expect(snapshots).toEqual([1, 2]);
  });

  it("stops after a failure and does not run later scenarios", async () => {
    let thirdRan = false;
    const persisted = [];
    const state = await runSequence(
      [ok("a"), { name: "b", run: async () => ({ failure: "boom" }) }, { name: "c", run: async () => { thirdRan = true; return {}; } }],
      (partial) => persisted.push(structuredClone(partial)),
    );
    expect(thirdRan).toBe(false);
    expect(state.stoppedAfter).toEqual({ name: "b", reason: "boom" });
    expect(state.notRun).toEqual(["c"]);
    expect(persisted.at(-1).scenarios.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("stops after a skipped scenario and after a thrown error", async () => {
    const skipped = await runSequence([{ name: "a", run: async () => ({ skipped: "not subscription" }) }, ok("b")], quiet);
    expect(skipped.notRun).toEqual(["b"]);
    const thrown = await runSequence([{ name: "a", run: async () => { throw new Error("exploded"); } }, ok("b")], quiet);
    expect(thrown.stoppedAfter).toEqual({ name: "a", reason: "scenario error: exploded" });
  });
});

describe("Claude probe runner end to end (fake process)", () => {
  const runProbe = (modes) => claudeMain({
    bin: node, prefixArgs: [fakeClaude, modes], configDir: path.join(outDir, "config"), timeoutMs: 5_000,
    firstDeltaTimeoutMs: 2_000, log: quiet,
  });

  it("completes all three scenarios, classifying the interrupt as cancelled", async () => {
    const state = await runProbe("ok,ok,interrupt-ack");
    expect(state.complete).toBe(true);
    expect(state.scenarios.map((s) => s.outcome)).toEqual(["succeeded", "succeeded", "cancelled"]);
    expect(ledger().claude).toHaveLength(3);
  });

  it("stops after a failed scenario, saves partial evidence, and spends no further requests", async () => {
    const state = await runProbe("ok,error-result,interrupt-ack");
    expect(state.stoppedAfter.name).toBe("write-denied");
    expect(state.notRun).toEqual(["interrupt-via-stream-json"]);
    const report = saved("claude-auth");
    expect(report.scenarios.map((s) => s.name)).toEqual(["profile-a-reply", "write-denied"]);
    expect(report.complete).toBe(false);
    expect(ledger().claude).toHaveLength(2);
  });

  it.each([
    ["no-result", /missing result/],
    ["exit-3", /unexpected exit code 3/],
    ["crash", /missing result/],
  ])("stops at the first scenario on %s", async (mode, reason) => {
    const state = await runProbe(mode);
    expect(state.stoppedAfter.name).toBe("profile-a-reply");
    expect(state.stoppedAfter.reason).toMatch(reason);
    expect(state.notRun).toEqual(["write-denied", "interrupt-via-stream-json"]);
    expect(saved("claude-auth").scenarios).toHaveLength(1);
  });

  it("stops on a timeout", async () => {
    const state = await claudeMain({
      bin: node, prefixArgs: [fakeClaude, "hang"], configDir: path.join(outDir, "config"), timeoutMs: 500, log: quiet,
    });
    expect(state.stoppedAfter.reason).toMatch(/timed out/);
  });

  it.each([
    ["ok,ok,interrupt-no-ack", /without a correlated interrupt acknowledgement/],
    ["ok,ok,interrupt-wrong-id", /without a correlated interrupt acknowledgement/],
    ["ok,ok,fail-before-interrupt", /result error: error_during_execution/],
  ])("does not treat %s as a cancellation", async (modes, reason) => {
    const state = await runProbe(modes);
    expect(state.complete).toBe(false);
    expect(state.stoppedAfter.name).toBe("interrupt-via-stream-json");
    expect(state.stoppedAfter.reason).toMatch(reason);
  });

  it.each([
    ["ok,write-allowed,interrupt-ack", /probe\.txt was created/],
    ["ok,write-no-denial,interrupt-ack", /no Write permission denial/],
  ])("does not accept %s as a denied write", async (modes, reason) => {
    const state = await runProbe(modes);
    expect(state.complete).toBe(false);
    expect(state.stoppedAfter.name).toBe("write-denied");
    expect(state.stoppedAfter.reason).toMatch(reason);
    expect(state.notRun).toEqual(["interrupt-via-stream-json"]);
    expect(ledger().claude).toHaveLength(2);
  });

  it("stops on exit 7 after an otherwise valid interrupt acknowledgement and result", async () => {
    const state = await runProbe("ok,ok,interrupt-ack-exit-7");
    expect(state.complete).toBe(false);
    expect(state.stoppedAfter.name).toBe("interrupt-via-stream-json");
    expect(state.stoppedAfter.reason).toMatch(/correlated cancellation, but abnormal process exit: code 7/);
    const report = saved("claude-auth");
    expect(report.complete).toBe(false);
    expect(report.stoppedAfter.name).toBe("interrupt-via-stream-json");
    expect(report.scenarios.at(-1).controlResponses).toEqual([expect.objectContaining({ request_id: "probe-interrupt-1", subtype: "success" })]);
    expect(report.scenarios.at(-1).exitCode).toBe(7);
  });

  it("sends nothing and reserves nothing when the login is not a subscription", async () => {
    const state = await runProbe("apikey-auth");
    expect(state.stoppedAfter).toEqual({ name: "profile-a-reply", reason: "Not a Claude.ai subscription login. No model request sent." });
    expect(ledger().claude).toBeUndefined();
  });

  it("stops when the binary cannot be started", async () => {
    const state = await claudeMain({ bin: path.join(outDir, "no-such-binary"), configDir: path.join(outDir, "config"), log: quiet });
    expect(state.complete).toBe(false);
    expect(state.scenarios).toHaveLength(1);
    expect(ledger().claude).toBeUndefined();
  });
});

describe("Codex probe runner end to end (fake process)", () => {
  const runProbe = (modes, options = {}) => codexTurns({
    bin: node, prefixArgs: [fakeAppServer, modes, path.join(outDir, "threads-started")],
    turnTimeoutMs: 2_000, approvalTimeoutMs: 2_000, unansweredWaitMs: 100, log: quiet, ...options,
  });

  it("completes all three scenarios, classifying the interrupt as cancelled", async () => {
    const state = await runProbe("complete,approval,approval-wait-interrupt");
    expect(state.complete).toBe(true);
    expect(state.scenarios.map((s) => s.outcome)).toEqual(["succeeded", "succeeded", "cancelled"]);
    expect(ledger().codex).toHaveLength(3);
  });

  it("stops after an unexpected app-server exit, saves partial evidence, and spends no further requests", async () => {
    const state = await runProbe("complete,crash,approval-wait-interrupt");
    expect(state.stoppedAfter.name).toBe("approval-declined");
    expect(state.notRun).toEqual(["approval-unanswered-then-interrupt"]);
    const report = saved("codex-turns");
    expect(report.scenarios.map((s) => s.name)).toEqual(["basic-reply", "approval-declined"]);
    expect(ledger().codex).toHaveLength(2);
  });

  it("stops when turn/completed never arrives", async () => {
    const state = await runProbe("silent", { turnTimeoutMs: 300 });
    expect(state.stoppedAfter).toMatchObject({ name: "basic-reply" });
    expect(state.stoppedAfter.reason).toMatch(/missing turn\/completed/);
    expect(state.notRun).toHaveLength(2);
  });

  it("stops on a failed turn", async () => {
    const state = await runProbe("failed");
    expect(state.stoppedAfter.reason).toMatch(/turn ended with status failed/);
  });

  it("does not treat an interruption that preceded our request as a cancellation", async () => {
    const state = await runProbe("complete,approval,spontaneous-interrupt");
    expect(state.complete).toBe(false);
    expect(state.stoppedAfter.name).toBe("approval-unanswered-then-interrupt");
    expect(state.stoppedAfter.reason).toMatch(/before our turn\/interrupt was sent/);
  });

  it.each([
    ["complete,complete,approval-wait-interrupt", /no supported approval request for this turn was declined/],
    ["complete,approval-writes,approval-wait-interrupt", /probe\.txt was created/],
  ])("does not accept %s as a declined approval", async (modes, reason) => {
    const state = await runProbe(modes);
    expect(state.complete).toBe(false);
    expect(state.stoppedAfter.name).toBe("approval-declined");
    expect(state.stoppedAfter.reason).toMatch(reason);
    expect(state.notRun).toEqual(["approval-unanswered-then-interrupt"]);
    expect(ledger().codex).toHaveLength(2);
  });

  it("does not let requestUserInput or a wrong-turn approval satisfy approval-declined", async () => {
    const state = await runProbe("complete,unrelated-requests,approval-wait-interrupt");
    expect(state.complete).toBe(false);
    expect(state.stoppedAfter.name).toBe("approval-declined");
    expect(state.stoppedAfter.reason).toMatch(/no supported approval request for this turn was declined/);
    expect(state.notRun).toEqual(["approval-unanswered-then-interrupt"]);
    const scenario = saved("codex-turns").scenarios.at(-1);
    expect(scenario.approvalRequestsAnswered).toBe(0);
    expect(scenario.unrelatedServerRequests).toBe(2);
    expect(scenario.serverRequestResponses).toEqual([
      expect.objectContaining({ method: "item/tool/requestUserInput", correlated: false, error: "unsupported server request" }),
      expect.objectContaining({ method: "item/commandExecution/requestApproval", turnId: "turn-other", correlated: false, decision: "cancel" }),
    ]);
  });

  it("records the decline for the correlated approval", async () => {
    const state = await runProbe("complete,approval,approval-wait-interrupt");
    expect(state.complete).toBe(true);
    expect(state.scenarios[1].serverRequestResponses).toEqual([
      expect.objectContaining({ method: "item/commandExecution/requestApproval", turnId: "turn-1", correlated: true, decision: "decline" }),
    ]);
  });

  it("stops when the app-server exits 7 after stdin closes, and saves the report", async () => {
    const state = await runProbe("complete,exit-7-on-close,approval-wait-interrupt");
    expect(state.complete).toBe(false);
    expect(state.stoppedAfter.name).toBe("approval-declined");
    expect(state.stoppedAfter.reason).toMatch(/abnormal app-server shutdown: exit code 7/);
    expect(state.notRun).toEqual(["approval-unanswered-then-interrupt"]);
    const report = saved("codex-turns");
    expect(report.stoppedAfter.name).toBe("approval-declined");
    expect(report.scenarios.at(-1).exit).toMatchObject({ code: 7 });
  });

  it("passes the handshake on a normal shutdown", async () => {
    const report = await codexHandshake({ bin: node, prefixArgs: [fakeAppServer, "complete", path.join(outDir, "threads-started")], log: quiet });
    expect(report.error).toBeUndefined();
    expect(report.exit).toEqual({ code: 0, signal: null });
  });

  it("fails the handshake when the app-server exits 7 after stdin closes", async () => {
    const report = await codexHandshake({ bin: node, prefixArgs: [fakeAppServer, "exit-7-on-close", path.join(outDir, "threads-started")], log: quiet });
    expect(report.error).toMatch(/abnormal app-server shutdown: exit code 7/);
  });

  it("sends nothing and reserves nothing when the account is not a ChatGPT subscription", async () => {
    const state = await runProbe("apikey");
    expect(state.stoppedAfter.reason).toMatch(/not ChatGPT subscription/);
    expect(ledger().codex).toBeUndefined();
  });

  it("stops when the binary cannot be started", async () => {
    const state = await codexTurns({ bin: path.join(outDir, "no-such-binary"), log: quiet });
    expect(state.complete).toBe(false);
    expect(state.scenarios).toHaveLength(1);
    expect(ledger().codex).toBeUndefined();
  });
});
