// Authenticated Claude Code probes: up to 3 model requests on the user's Claude subscription.
//
// Usage: WORKTREEAI_CLAUDE_BIN=<path to claude> node tools/provider-probes/claude-auth.mjs
//
// Each scenario first confirms subscription auth with `claude auth status`, then reserves one
// request in the ledger. Nothing is retried. The sequence stops after the first scenario that
// fails for any reason (spawn error, timeout, missing result, unexpected exit, error result, or
// an exception), and the report is saved after every scenario so partial evidence survives.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanEnv, markers, modelRequestsUsed, probeClaudeConfigDir, removeDir, reserveModelRequest, saveResult,
  tempDir, writeHostileFixture,
} from "./lib.mjs";
import { classifyClaudeRun, runSequence, runStreamProcess } from "./runner.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const INTERRUPT_REQUEST_ID = "probe-interrupt-1";

const profileA = (tools, model) => [
  "--safe-mode",
  "--setting-sources", "user",
  "--settings", JSON.stringify({ disableAllHooks: true, switchModelsOnFlag: false }),
  "--strict-mcp-config",
  "--tools", tools,
  "--disallowedTools", "Agent", "mcp__*",
  "--permission-mode", "default",
  "--permission-prompts", "none",
  "--model", model,
  "--output-format", "stream-json", "--verbose",
  "--no-session-persistence",
];

const isSubscription = (s) => s.loggedIn === true && s.authMethod === "claude.ai" && s.apiProvider === "firstParty";

function summarize(events, started) {
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const result = events.find((e) => e.type === "result");
  const blocks = events.filter((e) => e.type === "assistant").flatMap((e) => e.message?.content ?? []);
  const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const typeCounts = {};
  for (const e of events) {
    const key = e.subtype ? `${e.type}/${e.subtype}` : e.type;
    typeCounts[key] = (typeCounts[key] ?? 0) + 1;
  }
  return {
    typeCounts,
    init: init && {
      model: init.model, permissionMode: init.permissionMode, apiKeySource: init.apiKeySource,
      tools: init.tools, mcp_servers: init.mcp_servers, agents: init.agents,
      plugins: (init.plugins ?? []).map((p) => p.source ?? p.name),
    },
    hookEvents: events.filter((e) => e.type === "system" && String(e.subtype).startsWith("hook")).length,
    apiRetries: events.filter((e) => e.type === "system" && e.subtype === "api_retry").map((e) => ({ attempt: e.attempt, error: e.error })),
    toolUses: blocks.filter((block) => block.type === "tool_use").map((block) => block.name),
    controlResponses: events.filter((e) => e.type === "control_response").map((e) => ({
      request_id: e.response?.request_id, subtype: e.response?.subtype, atMs: e._t - started,
    })),
    assistantText: text.slice(0, 400),
    assistantTextLength: text.length,
    result: result && {
      subtype: result.subtype, is_error: result.is_error, num_turns: result.num_turns,
      result: typeof result.result === "string" ? result.result.slice(0, 300) : result.result,
      total_cost_usd: result.total_cost_usd,
      modelUsage: result.modelUsage && Object.fromEntries(
        Object.entries(result.modelUsage).map(([model, usage]) => [model, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }]),
      ),
      permission_denials: (result.permission_denials ?? []).map((d) => ({ tool_name: d.tool_name })),
      atMs: result._t - started,
    },
  };
}

// `prefixArgs` lets tests run a fake process (for example: node fake-claude.mjs <mode>).
export async function main({
  bin, prefixArgs = [], model = "claude-haiku-5-5", configDir = probeClaudeConfigDir(), timeoutMs = 120_000,
  firstDeltaTimeoutMs = 60_000, log = console.log,
} = {}) {
  const env = cleanEnv({ CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_MAX_RETRIES: "0" });
  const claude = (args, options) => runStreamProcess(bin, [...prefixArgs, ...args], { env, timeoutMs, ...options });

  function authStatus() {
    const run = spawnSync(bin, [...prefixArgs, "auth", "status"], { env, encoding: "utf8", timeout: 30_000 });
    try {
      const status = JSON.parse(run.stdout);
      return {
        loggedIn: status.loggedIn, authMethod: status.authMethod, apiProvider: status.apiProvider,
        subscriptionType: status.subscriptionType,
      };
    } catch {
      return { loggedIn: false, unreadable: true, spawnError: run.error?.message };
    }
  }

  // Wraps one scenario: billing check, budget reservation, run, classification.
  const scenario = (name, expected, build) => ({
    name,
    run: async () => {
      const entry = { name, startedAt: new Date().toISOString(), expectedOutcome: expected };
      entry.auth = authStatus();
      if (!isSubscription(entry.auth)) {
        entry.skipped = "Not a Claude.ai subscription login. No model request sent.";
        return entry;
      }
      const project = tempDir("claude-project");
      try {
        writeHostileFixture(project);
        entry.requestNumber = reserveModelRequest("claude", name);
        const { args, drive, interrupt } = build(project);
        const run = await claude(args, { cwd: project, drive });
        entry.args = args;
        entry.exitCode = run.code;
        entry.signal = run.signal;
        entry.timedOut = run.timedOut;
        entry.spawnError = run.spawnError;
        entry.driveError = run.driveError;
        entry.durationMs = run.durationMs;
        entry.stderr = run.stderr.slice(0, 400);
        Object.assign(entry, summarize(run.events, run.started));
        entry.interrupt = interrupt;
        entry.markers = markers(project);
        entry.probeFileCreated = fs.existsSync(path.join(project, "probe.txt"));
        const classified = classifyClaudeRun(run, interrupt);
        entry.outcome = classified.outcome;
        entry.outcomeReason = classified.reason;
        if (classified.outcome !== expected) {
          entry.failure = `expected ${expected}, got ${classified.outcome}${classified.reason ? `: ${classified.reason}` : ""}`;
        }
      } catch (error) {
        entry.failure = `scenario error: ${error.message}`;
      } finally {
        removeDir(project);
      }
      return entry;
    },
  });

  const definitions = [
    scenario("profile-a-reply", "succeeded", () => ({
      args: ["-p", "Reply with exactly: OK", ...profileA("Read", model), "--max-turns", "1"],
    })),
    scenario("write-denied", "succeeded", () => ({
      args: [
        "-p",
        "Use the Write tool to create a file named probe.txt containing the text hi. Then reply with one short sentence saying whether it worked.",
        ...profileA("Read,Write", model), "--max-turns", "3",
      ],
    })),
    scenario("interrupt-via-stream-json", "cancelled", () => {
      const interrupt = { requestId: INTERRUPT_REQUEST_ID, sent: false };
      return {
        interrupt,
        args: ["-p", "--input-format", "stream-json", "--include-partial-messages", ...profileA("", model), "--max-turns", "1"],
        drive: async (child, events, started) => {
          child.stdin.write(`${JSON.stringify({
            type: "user",
            message: { role: "user", content: "Count from 1 to 400, one number per line, with no other text." },
          })}\n`);
          const hasResult = () => events.some((e) => e.type === "result");
          const hasDelta = () => events.some((e) => e.type === "stream_event" && e.event?.delta?.type === "text_delta");
          const deadline = Date.now() + firstDeltaTimeoutMs;
          while (Date.now() < deadline && !hasDelta() && !hasResult() && child.exitCode === null) await sleep(25);
          interrupt.firstTextDeltaMs = Date.now() - started;
          if (hasDelta() && !hasResult() && child.exitCode === null) {
            interrupt.sent = true;
            interrupt.sentMs = Date.now() - started;
            child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: INTERRUPT_REQUEST_ID, request: { subtype: "interrupt" } })}\n`);
            const wait = Date.now() + 20_000;
            while (Date.now() < wait && !hasResult() && child.exitCode === null) await sleep(25);
          }
          child.stdin.end();
        },
      };
    }),
  ];

  const version = spawnSync(bin, [...prefixArgs, "--version"], { env, encoding: "utf8", timeout: 30_000 });
  const report = {
    probe: "claude-auth", ranAt: new Date().toISOString(), platform: process.platform,
    claudeVersion: (version.stdout ?? "").trim(), requestedModel: model,
    usedBefore: modelRequestsUsed("claude"),
  };
  let savedTo = null;
  const state = await runSequence(definitions, (partial) => {
    savedTo = saveResult("claude-auth", { ...report, ...partial, usedAfter: modelRequestsUsed("claude") });
  });
  for (const s of state.scenarios) {
    log(`${s.name}: request#${s.requestNumber ?? "-"} outcome=${s.outcome ?? "-"} ${s.failure ?? s.skipped ?? "ok"}`);
  }
  if (state.stoppedAfter) log(`STOPPED after ${state.stoppedAfter.name}: ${state.stoppedAfter.reason}. Not run: ${state.notRun.join(", ") || "none"}`);
  log(`saved ${savedTo}`);
  return state;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bin = process.env.WORKTREEAI_CLAUDE_BIN;
  if (!bin) {
    console.error("Set WORKTREEAI_CLAUDE_BIN to the claude executable.");
    process.exit(2);
  }
  const state = await main({ bin, model: process.env.WORKTREEAI_CLAUDE_MODEL });
  process.exit(state.complete ? 0 : 1);
}
