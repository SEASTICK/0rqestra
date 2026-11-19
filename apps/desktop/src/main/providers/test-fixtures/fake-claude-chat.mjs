// Fake `claude` for offline tests of the chat adapter. It never contacts a provider.
// FAKE_AUTH: subscription (default) | apikey | signed-out.  FAKE_MODE: stream | no-deltas | error |
// crash | slow | stubborn.  FAKE_REPLIES: file with a JSON list of replies, used in turn instead of
// "Hej där!" (for trying the window by hand); FAKE_DELAY_MS: wait before the reply starts.  FAKE_LOG: file that receives the arguments, the prompt, and whether an
// API key reached the process.
import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (data) => { if (process.env.FAKE_LOG) fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(data)); };

if (args.includes("--version")) {
  console.log("9.9.9 (Claude Code)");
} else if (args[0] === "auth" && args[1] === "status") {
  const auth = process.env.FAKE_AUTH ?? "subscription";
  console.log(JSON.stringify(auth === "signed-out" ? { loggedIn: false, authMethod: "none" }
    : { loggedIn: true, authMethod: auth === "apikey" ? "apiKey" : "claude.ai", apiProvider: "firstParty", subscriptionType: auth === "apikey" ? null : "max" }));
} else {
  const mode = process.env.FAKE_MODE ?? "stream";
  const lines = readline.createInterface({ input: process.stdin });
  let timer = null;
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "control_request" && message.request?.subtype === "interrupt") {
      if (mode === "stubborn") return;
      clearInterval(timer);
      emit({ type: "control_response", response: { request_id: message.request_id, subtype: "success" } });
      emit({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1 });
      process.exit(0);
    }
    if (message.type !== "user") return;
    log({ args, prompt: message.message.content, apiKeyReached: "ANTHROPIC_API_KEY" in process.env, openaiKeyReached: "OPENAI_API_KEY" in process.env });
    emit({ type: "system", subtype: "init", model: "claude-test-model", tools: [] });
    const delta = (text) => emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    if (mode === "stream") {
      // The usage windows, as newer versions send them, then the limiting one as older versions do.
      emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", windows: { five_hour: { utilization: 0.28, resetsAt: 1795050000 }, seven_day: { utilization: 0.4, resetsAt: 1795500000 } } } });
      emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.31, resetsAt: 1795050000 } });
      const finish = (text) => {
        emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
        emit({ type: "result", subtype: "success", is_error: false, result: text, modelUsage: { m: { inputTokens: 12, outputTokens: 3 } } });
        process.exit(0);
      };
      if (process.env.FAKE_REPLIES) {
        const replies = JSON.parse(fs.readFileSync(process.env.FAKE_REPLIES, "utf8"));
        const counter = `${process.env.FAKE_REPLIES}.count`;
        const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
        fs.writeFileSync(counter, String(n + 1));
        const text = replies[Math.min(n, replies.length - 1)];
        const chunks = text.match(/[\s\S]{1,24}/g) ?? [];
        setTimeout(() => {
          let i = 0;
          const tick = setInterval(() => {
            if (i < chunks.length) delta(chunks[i++]);
            else { clearInterval(tick); finish(text); }
          }, 60);
        }, Number(process.env.FAKE_DELAY_MS ?? 0));
        return;
      }
      delta("Hej");
      delta(" där!");
      finish("Hej där!");
    } else if (mode === "no-deltas") {
      emit({ type: "assistant", message: { content: [{ type: "text", text: "Full answer" }] } });
      emit({ type: "result", subtype: "success", is_error: false, result: "Full answer" });
      process.exit(0);
    } else if (mode === "error") {
      emit({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached" });
      process.exit(1);
    } else if (mode === "crash") {
      process.stderr.write("boom\n");
      process.exit(3);
    } else {
      let n = 0;
      timer = setInterval(() => delta(`${++n} `), 20);
    }
  });
}
