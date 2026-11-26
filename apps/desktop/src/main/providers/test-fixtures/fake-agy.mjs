// Fake `agy` (Antigravity CLI) for offline tests of the Gemini adapter. It never contacts Google. It follows the real
// output of agy 1.5.18 sent on 2026-11-26: -p "/usage" --output-format json, `models`, and the stream-json events
// "init", "step_update" (step_type user_input / agent_response, text_delta) and "result".
// FAKE_AUTH: account (default) | signed-out | apikey.  FAKE_PERM: the permission_mode in init (default request-review).
// FAKE_MODE: stream (default) | tool | quota | stall | crash | no-deltas.  FAKE_REPLIES / FAKE_DELAY_MS as for the others.
// FAKE_LOG: file that receives the arguments, stdin, and which environment variables reached the process.
import fs from "node:fs";

const args = process.argv.slice(2);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const auth = process.env.FAKE_AUTH ?? "account";
const log = (extra) => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args, geminiKeyReached: "GEMINI_API_KEY" in process.env, adcReached: Object.keys(process.env).some((k) => k.startsWith("AGY_ADC") || k.startsWith("AGY_LLM_GATEWAY")), googleReached: Object.keys(process.env).some((k) => k.startsWith("GOOGLE_")), cwd: process.cwd(), ...extra })}\n`); };

if (args.includes("--version")) {
  console.log("Antigravity CLI 1.5.18");
} else if (args[0] === "-p" && args[1] === "/usage") {
  log({});
  if (auth === "signed-out") { process.stderr.write('AGY_ERROR: {"short_error":"not signed in: run agy and sign in"}\n'); process.exit(1); }
  if (auth === "apikey") { process.stderr.write("/usage is not available when you connect with a GEMINI_API_KEY: an API key has no account quota\n"); process.exit(2); }
  console.log(JSON.stringify({ conversation_id: "", status: "SUCCESS", response: "x", duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, command: { name: "usage", data: { groups: [
    { name: "Gemini Models", buckets: [
      { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.989983320236206, reset_time: "2026-12-03T20:38:33Z" },
      { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.9899333119392395, reset_time: "2026-11-27T01:38:33Z" } ] },
    { name: "Claude and GPT models", buckets: [{ id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" }, { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" }] } ] } } }));
} else if (args[0] === "models") {
  console.log(JSON.stringify([{ id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" }, { id: "gemini-4-carbon-high", label: "Gemini 4 Carbon (High)" }, { id: "gemini-3-8-flash", label: "Gemini 3.8 Flash" }]));
} else {
  const mode = process.env.FAKE_MODE ?? "stream";
  const printArg = args.find((a) => a.startsWith("--print="));
  const input = printArg ? printArg.slice("--print=".length) : "";
  process.stdin.resume();
  setImmediate(() => {
    log({ input });
    const conversation = "fake-conversation";
    if (mode === "crash") { process.stderr.write("boom\n"); process.exit(3); }
    emit({ event: "init", conversation_id: conversation, init: { cwd: process.cwd(), tools: ["run_command", "write_to_file", "view_file"], permission_mode: process.env.FAKE_PERM ?? "request-review" } });
    emit({ event: "step_update", step_update: { conversation_id: conversation, step_index: 0, state: "DONE", step_type: "user_input" } });
    const usage = { input_tokens: 10489, output_tokens: 33, thinking_tokens: 31, cache_read_tokens: 100, total_tokens: 10522 };
    const delta = (state, text_delta) => emit({ event: "step_update", step_update: { conversation_id: conversation, step_index: 1, state, step_type: "agent_response", text_delta } });
    if (mode === "tool") { emit({ event: "step_update", step_update: { conversation_id: conversation, step_index: 1, state: "ACTIVE", step_type: "run_command" } }); setInterval(() => {}, 1000); return; }
    if (mode === "stall") { delta("ACTIVE", "Starting the answer"); setInterval(() => {}, 1000); return; }
    if (mode === "quota") { process.stderr.write('AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED","message":"You have exhausted your quota on this model."}\n'); emit({ event: "result", result: { conversation_id: conversation, status: "ERROR", response: "", num_turns: 1, usage } }); process.exit(3); }
    let text = "Hej från Gemini";
    if (process.env.FAKE_REPLIES) {
      const replies = JSON.parse(fs.readFileSync(process.env.FAKE_REPLIES, "utf8"));
      const counter = `${process.env.FAKE_REPLIES}.count`;
      const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
      fs.writeFileSync(counter, String(n + 1));
      text = replies[Math.min(n, replies.length - 1)];
    }
    const chunks = text.match(/[\s\S]{1,24}/g) ?? [];
    setTimeout(() => {
      let i = 0;
      const tick = setInterval(() => {
        if (i < chunks.length && mode !== "no-deltas") delta("ACTIVE", chunks[i++]);
        else {
          clearInterval(tick);
          if (mode !== "no-deltas") emit({ event: "step_update", step_update: { conversation_id: conversation, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "\n", duration_seconds: 3.5, usage } });
          emit({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response: `${text}\n`, duration_seconds: 3.6, num_turns: 1, usage } });
          process.exit(0);
        }
      }, 40);
    }, Number(process.env.FAKE_DELAY_MS ?? 0));
  });
}
