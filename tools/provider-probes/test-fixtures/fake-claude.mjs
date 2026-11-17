// Fake `claude` for offline tests. It never contacts a provider.
// Usage: node fake-claude.mjs <modes> <claude args...>
// <modes> is a comma list, one mode per probe scenario (reply, write, interrupt). A single mode
// applies to every scenario. "apikey-auth" as the first mode makes `auth status` report an API key.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [modesArg, ...args] = process.argv.slice(2);
const modes = modesArg.split(",");
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (args.includes("--version")) {
  console.log("0.0.0 (Fake Claude)");
} else if (args[0] === "auth" && args[1] === "status") {
  const apiKey = modes[0] === "apikey-auth";
  console.log(JSON.stringify({
    loggedIn: true, authMethod: apiKey ? "apiKey" : "claude.ai", apiProvider: "firstParty", subscriptionType: apiKey ? null : "pro",
  }));
} else {
  runScenario();
}

function runScenario() {
const scenarioIndex = args.includes("--input-format") ? 2 : args.join(" ").includes("probe.txt") ? 1 : 0;
const mode = modes[Math.min(scenarioIndex, modes.length - 1)];
const init = { type: "system", subtype: "init", model: "fake-model", tools: ["Read"], mcp_servers: [], plugins: [], agents: [] };
const success = { type: "result", subtype: "success", is_error: false, result: "OK", num_turns: 1, modelUsage: { "fake-model": { inputTokens: 1, outputTokens: 1 } } };
const interrupted = { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, modelUsage: {} };

switch (mode) {
  case "ok":
    emit(init);
    emit({ type: "assistant", message: { content: [{ type: "text", text: "OK" }] } });
    // In the write scenario, a well-behaved run reports the denied Write, as the real tool did.
    emit(scenarioIndex === 1 ? { ...success, permission_denials: [{ tool_name: "Write" }] } : success);
    process.exitCode = 0;
    break;
  case "write-allowed":
    // Misbehaving run: the write happens and nothing is denied, yet the result is a success.
    fs.writeFileSync(path.join(process.cwd(), "probe.txt"), "hi");
    emit(init);
    emit(success);
    process.exitCode = 0;
    break;
  case "write-no-denial":
    // Success with no reported denial and no file: the denial cannot be confirmed.
    emit(init);
    emit(success);
    process.exitCode = 0;
    break;
  case "error-result":
    emit(init);
    emit({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 1 });
    process.exitCode = 1;
    break;
  case "no-result":
    emit(init);
    process.exitCode = 0;
    break;
  case "exit-3":
    emit(init);
    emit(success);
    process.exitCode = 3;
    break;
  case "crash":
    emit(init);
    process.exitCode = 7;
    break;
  case "hang":
    emit(init);
    setInterval(() => {}, 1000);
    break;
  case "interrupt-ack":
  case "interrupt-no-ack":
  case "interrupt-wrong-id":
  case "fail-before-interrupt": {
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type === "user") {
        emit(init);
        if (mode === "fail-before-interrupt") {
          emit(interrupted);
        } else {
          emit({ type: "stream_event", event: { delta: { type: "text_delta", text: "1" } } });
        }
      } else if (message.type === "control_request") {
        if (mode === "interrupt-ack") emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
        if (mode === "interrupt-wrong-id") emit({ type: "control_response", response: { subtype: "success", request_id: "someone-else" } });
        emit(interrupted);
      }
    });
    lines.on("close", () => { process.exitCode = 1; });
    break;
  }
  default:
    console.error(`unknown fake mode: ${mode}`);
    process.exitCode = 64;
}
}
