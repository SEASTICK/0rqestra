// Fake `codex app-server` for offline tests of the chat adapter. It never contacts a provider.
// FAKE_AUTH: chatgpt (default) | apikey | none.  FAKE_MODE: stream | final-only | approval | slow |
// usage-limit | crash.  FAKE_LOG: file that receives thread/turn parameters and approval answers.
import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const record = {};
const log = () => { if (process.env.FAKE_LOG) fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(record)); };

if (args.includes("--version")) {
  console.log("codex-cli 9.9.9");
  process.exit(0);
}
const mode = process.env.FAKE_MODE ?? "stream";
const auth = process.env.FAKE_AUTH ?? "chatgpt";
let timer = null;
const lines = readline.createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) {
    record.approvalAnswer = m.result ?? m.error;
    log();
    finishTurn("completed", "Done after approval.");
    return;
  }
  const reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case "initialize": return reply({ userAgent: "fake" });
    case "initialized": return undefined;
    case "account/read": return reply({ account: auth === "none" ? null : { type: auth === "apikey" ? "apiKey" : "chatgpt", planType: "plus" } });
    case "model/list": return reply({ data: [
      { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
      { id: "secret-model", hidden: true },
    ] });
    case "account/rateLimits/read": return reply({ rateLimits: { primary: { usedPercent: 18, windowDurationMins: 300 }, secondary: { usedPercent: 3, windowDurationMins: 10080 } } });
    case "thread/start":
      record.thread = m.params;
      record.apiKeyReached = "OPENAI_API_KEY" in process.env;
      log();
      return reply({ thread: { id: "th-1" }, model: m.params.model ?? "gpt-6.1-sol" });
    case "turn/start":
      record.turn = m.params;
      log();
      reply({ turn: { id: "tu-1" } });
      return startTurn();
    case "turn/interrupt":
      clearInterval(timer);
      reply({});
      return finishTurn("interrupted", null);
    default:
      return send({ id: m.id, error: { code: -32601, message: "unknown" } });
  }
});

function finishTurn(status, text, error) {
  if (text) notify("item/completed", { item: { type: "agentMessage", text } });
  notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 100, outputTokens: 7 } } });
  notify("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 19, windowDurationMins: 300 } } });
  notify("turn/completed", { turn: { id: "tu-1", status, ...(error ? { error } : {}) } });
}

function startTurn() {
  if (mode === "stream") {
    notify("item/agentMessage/delta", { delta: "Hello" });
    notify("item/agentMessage/delta", { delta: " world" });
    finishTurn("completed", "Hello world");
  } else if (mode === "final-only") {
    finishTurn("completed", "Only the final text");
  } else if (mode === "approval") {
    send({ id: 900, method: "item/commandExecution/requestApproval", params: { threadId: "th-1", turnId: "tu-1", command: "rm -rf /" } });
  } else if (mode === "usage-limit") {
    finishTurn("failed", null, { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" });
  } else if (mode === "crash") {
    process.exit(2);
  } else {
    let n = 0;
    timer = setInterval(() => notify("item/agentMessage/delta", { delta: `${++n} ` }), 20);
  }
}
