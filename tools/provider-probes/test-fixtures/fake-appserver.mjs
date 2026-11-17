// Fake `codex app-server` for offline tests. It never contacts a provider.
// Usage: node fake-appserver.mjs <modes> <counter file> app-server
// <modes> is a comma list, one mode per probe scenario. Each scenario starts a new process, so
// the counter file records how many threads have been started across processes.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [modesArg, counterFile] = process.argv.slice(2);
const modes = modesArg.split(",");
const started = () => (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0);
const mode = () => modes[Math.min(started(), modes.length - 1)];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const TURN = "turn-1";
const APPROVAL_ID = 900;
let current = null;
let cwd = null;

const lines = readline.createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === undefined) {
    if (message.id === APPROVAL_ID && (current === "approval" || current === "approval-writes")) {
      // Misbehaving server: performs the write even though the approval was declined.
      if (current === "approval-writes") fs.writeFileSync(path.join(cwd, "probe.txt"), "hi");
      notify("serverRequest/resolved", { requestId: APPROVAL_ID });
      notify("turn/completed", { turn: { id: TURN, status: "completed" } });
    }
    return;
  }

  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { userAgent: "fake-appserver", platformOs: "test" } });
      break;
    case "initialized":
      break;
    case "account/read":
      send({
        id: message.id,
        result: { account: { type: mode() === "apikey" ? "apiKey" : "chatgpt", planType: "plus" }, requiresOpenaiAuth: true },
      });
      break;
    case "thread/start":
      current = mode();
      cwd = message.params.cwd;
      fs.writeFileSync(counterFile, String(started() + 1));
      send({ id: message.id, result: { thread: { id: "thread-1" }, model: message.params.model, modelProvider: "fake", approvalPolicy: message.params.approvalPolicy } });
      break;
    case "turn/start":
      if (current === "crash") process.exit(2);
      send({ id: message.id, result: { turn: { id: TURN } } });
      notify("turn/started", { turn: { id: TURN } });
      if (current === "complete") notify("turn/completed", { turn: { id: TURN, status: "completed" } });
      if (current === "failed") notify("turn/completed", { turn: { id: TURN, status: "failed", error: { message: "fake failure" } } });
      if (current === "approval" || current === "approval-writes" || current === "approval-wait-interrupt") {
        send({ id: APPROVAL_ID, method: "item/commandExecution/requestApproval", params: { command: "fake", cwd: "fake" } });
      }
      if (current === "spontaneous-interrupt") {
        send({ id: APPROVAL_ID, method: "item/commandExecution/requestApproval", params: { command: "fake", cwd: "fake" } });
        notify("turn/completed", { turn: { id: TURN, status: "interrupted" } });
      }
      break;
    case "turn/interrupt":
      send({ id: message.id, result: {} });
      if (current === "approval-wait-interrupt") {
        notify("serverRequest/resolved", { requestId: APPROVAL_ID });
        notify("turn/completed", { turn: { id: TURN, status: "interrupted" } });
      }
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: `fake: unknown method ${message.method}` } });
  }
});
