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
const THREAD = "thread-1";
// Approval requests carry threadId and turnId, as the app-server documents.
const approvalParams = (turnId = TURN) => ({ threadId: THREAD, turnId, itemId: "item-1", command: "fake", cwd: "fake" });
const APPROVING = ["approval", "approval-writes", "exit-7-on-close"];
let current = null;
let cwd = null;

const lines = readline.createInterface({ input: process.stdin });
// exit-7-on-close: behaves normally, then exits 7 when the client closes stdin.
lines.on("close", () => process.exit((current ?? mode()) === "exit-7-on-close" ? 7 : 0));
lines.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === undefined) {
    if (message.id === APPROVAL_ID && APPROVING.includes(current)) {
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
    case "model/list":
      send({ id: message.id, result: { data: [{ id: "fake-model", model: "fake-model", isDefault: true }] } });
      break;
    case "account/rateLimits/read":
      send({ id: message.id, result: { rateLimits: null } });
      break;
    case "thread/start":
      current = mode();
      cwd = message.params.cwd;
      fs.writeFileSync(counterFile, String(started() + 1));
      send({ id: message.id, result: { thread: { id: THREAD }, model: message.params.model, modelProvider: "fake", approvalPolicy: message.params.approvalPolicy } });
      break;
    case "turn/start":
      if (current === "crash") process.exit(2);
      send({ id: message.id, result: { turn: { id: TURN } } });
      notify("turn/started", { turn: { id: TURN } });
      if (current === "complete") notify("turn/completed", { turn: { id: TURN, status: "completed" } });
      if (current === "failed") notify("turn/completed", { turn: { id: TURN, status: "failed", error: { message: "fake failure" } } });
      if (APPROVING.includes(current) || current === "approval-wait-interrupt") {
        send({ id: APPROVAL_ID, method: "item/commandExecution/requestApproval", params: approvalParams() });
      }
      if (current === "unrelated-requests") {
        // Server requests that must not count as the declined approval: a user-input request and
        // an approval for another turn. The turn then completes without any approval for it.
        send({ id: 901, method: "item/tool/requestUserInput", params: { threadId: THREAD, turnId: TURN, questions: [] } });
        send({ id: 902, method: "item/commandExecution/requestApproval", params: approvalParams("turn-other") });
        setTimeout(() => notify("turn/completed", { turn: { id: TURN, status: "completed" } }), 100);
      }
      if (current === "spontaneous-interrupt") {
        send({ id: APPROVAL_ID, method: "item/commandExecution/requestApproval", params: approvalParams() });
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
