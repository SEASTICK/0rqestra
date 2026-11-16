// Codex app-server probes over stdio JSON-RPC.
//
//   node tools/provider-probes/codex-appserver.mjs handshake   -> no model request
//   node tools/provider-probes/codex-appserver.mjs turns       -> up to 3 model requests
//
// Requires WORKTREEAI_CODEX_BIN. The child gets a cleaned environment (no API keys), so it can
// only use the login already stored by the official Codex tool. Turns refuse to run unless
// account/read reports ChatGPT (subscription) auth. Nothing is retried. The sequence stops after
// the first scenario that fails for any reason (spawn error, unexpected exit, timeout, missing
// turn/completed, unexpected turn status, or an exception), and the report is saved after every
// scenario so partial evidence survives.
//
// Not guaranteed by these probes: that Codex cannot delegate to subagents or other tools.
// `approvalsReviewer: "user"` only routes approval requests to this client.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanEnv, modelRequestsUsed, removeDir, reserveModelRequest, saveResult, tempDir, writeHostileFixture,
} from "./lib.mjs";
import { AppServer, classifyCodexTurn, runSequence } from "./runner.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WRITE_PROMPT = "Create a file named probe.txt in the current directory containing the text hi. Use one shell command and nothing else.";

function methodCounts(log) {
  const counts = {};
  for (const entry of log) {
    const key = entry.kind === "notification" ? entry.method : `${entry.kind}:${entry.method ?? ""}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function agentText(server) {
  return server.notifications("item/completed")
    .map((e) => e.params?.item)
    .filter((item) => item?.type === "agentMessage")
    .map((item) => item.text ?? "")
    .join("\n")
    .slice(0, 600);
}

async function accountSummary(server) {
  const account = await server.request("account/read", { refreshToken: false });
  return { type: account?.account?.type ?? null, planType: account?.account?.planType ?? null, requiresOpenaiAuth: account?.requiresOpenaiAuth };
}

export async function handshake({ bin, prefixArgs = [], log = console.log } = {}) {
  const server = new AppServer(bin, [...prefixArgs, "app-server"], cleanEnv());
  const report = { probe: "codex-handshake", ranAt: new Date().toISOString(), platform: process.platform, modelRequests: 0 };
  try {
    const init = await server.initialize();
    report.initialize = { userAgent: init?.userAgent, platformOs: init?.platformOs, codexHome: init?.codexHome };
    report.account = await accountSummary(server);
    const models = await server.request("model/list", {});
    report.models = (models?.data ?? []).map((m) => ({
      id: m.id, model: m.model, isDefault: m.isDefault, hidden: m.hidden,
      efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
    }));
    try {
      const limits = await server.request("account/rateLimits/read", {});
      const snapshot = limits?.rateLimits;
      report.rateLimits = snapshot && {
        primaryUsedPercent: snapshot.primary?.usedPercent, primaryWindowMinutes: snapshot.primary?.windowDurationMins,
        secondaryUsedPercent: snapshot.secondary?.usedPercent, secondaryWindowMinutes: snapshot.secondary?.windowDurationMins,
        planType: snapshot.planType, credits: snapshot.credits,
      };
    } catch (error) {
      report.rateLimits = { error: error.message };
    }
  } catch (error) {
    report.error = error.message;
  } finally {
    report.exit = await server.stop();
    report.stderrTail = server.stderr.slice(-400);
  }
  log(JSON.stringify({ account: report.account, models: report.models?.map((m) => m.id), rateLimits: report.rateLimits, error: report.error }, null, 1));
  log(`saved ${saveResult("codex-handshake", report)}`);
  return report;
}

// `prefixArgs` lets tests run a fake process (for example: node fake-appserver.mjs <mode>).
export async function turns({
  bin, prefixArgs = [], model = "gpt-5.6-luna", turnTimeoutMs = 120_000, approvalTimeoutMs = 90_000,
  unansweredWaitMs = 12_000, log = console.log,
} = {}) {
  const turnParams = (threadId, text) => ({ threadId, effort: "low", input: [{ type: "text", text }] });

  const scenario = (name, expected, approvalPolicy, run) => ({
    name,
    run: async () => {
      const started = Date.now();
      const entry = { name, startedAt: new Date(started).toISOString(), startedMs: started, expectedOutcome: expected };
      const project = tempDir("codex-project");
      let server = null;
      const turn = { turnId: null, interrupt: null };
      try {
        writeHostileFixture(project);
        server = new AppServer(bin, [...prefixArgs, "app-server"], cleanEnv());
        await server.initialize();
        entry.account = await accountSummary(server);
        if (entry.account.type !== "chatgpt") {
          entry.skipped = `Billing mode is not ChatGPT subscription (account.type=${entry.account.type}). No model request sent.`;
          return entry;
        }
        entry.requestNumber = reserveModelRequest("codex", name);
        const thread = await server.request("thread/start", {
          cwd: project, approvalPolicy, approvalsReviewer: "user", sandbox: "read-only", ephemeral: true, model,
        });
        entry.thread = {
          requestedModel: model, model: thread?.model, modelProvider: thread?.modelProvider,
          approvalPolicy: thread?.approvalPolicy, sandbox: thread?.sandbox?.type ?? thread?.sandbox,
        };
        await run({ server, threadId: thread?.thread?.id, entry, turn, turnParams });
      } catch (error) {
        entry.error = error.message;
      } finally {
        entry.durationMs = Date.now() - started;
        if (server) {
          entry.exitedBeforeStop = server.exitedBeforeStop || Boolean(server.exitInfo);
          entry.methodCounts = methodCounts(server.log);
          entry.errors = server.notifications("error").map((e) => e.params);
          entry.turnCompleted = server.notifications("turn/completed").map((e) => ({
            id: e.params?.turn?.id, status: e.params?.turn?.status, error: e.params?.turn?.error, atMs: e.t - started,
          }));
          entry.modelNotifications = server.log
            .filter((e) => e.kind === "notification" && /model/i.test(e.method))
            .map((e) => ({ method: e.method, params: e.params }));
          entry.tokenUsage = server.notifications("thread/tokenUsage/updated").at(-1)?.params?.tokenUsage?.total;
          entry.agentText = agentText(server);
          entry.serverRequests = server.log.filter((e) => e.kind === "serverRequest").map((e) => ({
            method: e.method, command: e.params?.command, cwd: e.params?.cwd, reason: e.params?.reason,
            itemId: e.params?.itemId, atMs: e.t - started,
          }));
          entry.exit = await server.stop();
          entry.stderrTail = server.stderr.slice(-400);
        }
        entry.turnId = turn.turnId;
        entry.interrupt = turn.interrupt;
        entry.probeFileCreated = fs.existsSync(path.join(project, "probe.txt"));
        removeDir(project);
      }
      if (entry.skipped) return entry;
      const classified = classifyCodexTurn({
        error: entry.error, exitedBeforeStop: entry.exitedBeforeStop, exitInfo: entry.exit, turnId: entry.turnId,
        completions: entry.turnCompleted ?? [], errorNotifications: entry.errors ?? [], interrupt: entry.interrupt,
      });
      entry.outcome = classified.outcome;
      entry.outcomeReason = classified.reason;
      if (classified.outcome !== expected) {
        entry.failure = `expected ${expected}, got ${classified.outcome}${classified.reason ? `: ${classified.reason}` : ""}`;
      }
      return entry;
    },
  });

  const completed = (e) => e.kind === "notification" && e.method === "turn/completed";

  const definitions = [
    scenario("basic-reply", "succeeded", "never", async ({ server, threadId, turn, turnParams: params }) => {
      const started = await server.request("turn/start", params(threadId, "Reply with exactly: OK"));
      turn.turnId = started?.turn?.id ?? null;
      await server.waitFor(completed, turnTimeoutMs);
    }),
    scenario("approval-declined", "succeeded", "untrusted", async ({ server, threadId, entry, turn, turnParams: params }) => {
      let answered = 0;
      server.onServerRequest = (message) => {
        answered += 1;
        server.send({ id: message.id, result: { decision: answered === 1 ? "decline" : "cancel" } });
      };
      const started = await server.request("turn/start", params(threadId, WRITE_PROMPT));
      turn.turnId = started?.turn?.id ?? null;
      await server.waitFor(completed, turnTimeoutMs);
      entry.approvalRequestsAnswered = answered;
    }),
    scenario("approval-unanswered-then-interrupt", "cancelled", "untrusted", async ({ server, threadId, entry, turn, turnParams: params }) => {
      const started = await server.request("turn/start", params(threadId, WRITE_PROMPT));
      turn.turnId = started?.turn?.id ?? null;
      const request = await server.waitFor((e) => e.kind === "serverRequest", approvalTimeoutMs);
      if (!request) throw new Error("no approval request arrived before the timeout");
      const before = server.log.length;
      await sleep(unansweredWaitMs);
      entry.eventsWhileUnanswered = methodCounts(server.log.slice(before));
      entry.turnEndedWhileUnanswered = server.notifications("turn/completed").length > 0;
      const interruptAt = Date.now();
      turn.interrupt = { turnId: turn.turnId, acknowledged: false, requestedAtMs: interruptAt - entry.startedMs };
      await server.request("turn/interrupt", { threadId, turnId: turn.turnId });
      turn.interrupt.acknowledged = true;
      const done = await server.waitFor(completed, 20_000);
      entry.msFromInterruptToTurnCompleted = done ? done.t - interruptAt : null;
      entry.requestResolvedNotification = server.notifications("serverRequest/resolved").length;
    }),
  ];

  const report = { probe: "codex-turns", ranAt: new Date().toISOString(), platform: process.platform, usedBefore: modelRequestsUsed("codex") };
  let savedTo = null;
  const state = await runSequence(definitions, (partial) => {
    savedTo = saveResult("codex-turns", { ...report, ...partial, usedAfter: modelRequestsUsed("codex") });
  });
  for (const s of state.scenarios) {
    log(`${s.name}: request#${s.requestNumber ?? "-"} outcome=${s.outcome ?? "-"} ${s.failure ?? s.skipped ?? "ok"}`);
  }
  if (state.stoppedAfter) log(`STOPPED after ${state.stoppedAfter.name}: ${state.stoppedAfter.reason}. Not run: ${state.notRun.join(", ") || "none"}`);
  log(`saved ${savedTo}`);
  return state;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bin = process.env.WORKTREEAI_CODEX_BIN;
  const mode = process.argv[2];
  if (!bin || !["handshake", "turns"].includes(mode)) {
    console.error("Usage: WORKTREEAI_CODEX_BIN=<codex> node codex-appserver.mjs <handshake|turns>");
    process.exit(2);
  }
  if (mode === "handshake") {
    const report = await handshake({ bin });
    process.exit(report.error ? 1 : 0);
  }
  const state = await turns({ bin, model: process.env.WORKTREEAI_CODEX_MODEL });
  process.exit(state.complete ? 0 : 1);
}
