// Fake `gemini` for offline tests of the Gemini adapter. It never contacts Google. It follows the real CLI's
// headless stream-json output (read from @google/gemini-cli 0.71.1 on 2026-11-25): events "init", "message"
// (role user / assistant, delta true), "tool_use", "tool_result", "error" and a final "result" with stats.
// FAKE_MODE: stream (default) | error-result | quota | stall | crash | auth (exit 41 like a signed-out CLI).
// FAKE_INSECURE=1: print the warning the real CLI prints when it does not accept the system settings file.
// FAKE_REPLIES: file with a JSON list of replies, used in turn (FAKE_DELAY_MS waits before the reply).
// FAKE_LOG: file that receives the arguments, the stdin text and the environment facts that matter.
import fs from "node:fs";

const args = process.argv.slice(2);
const emit = (event) => process.stdout.write(`${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`);

if (process.env.FAKE_INSECURE === "1") process.stderr.write("Security Warning: Skipping system settings file '/x/gemini-system.json': Parent directory '/x' is insecure: Directory '/x' is writable by group or others (mode: 40777).\n");

if (args.includes("--version")) {
  console.log("9.9.9");
} else {
  const mode = process.env.FAKE_MODE ?? "stream";
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    const settingsFile = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    let settings = null;
    try { settings = settingsFile ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : null; } catch { /* none */ }
    if (process.env.FAKE_LOG) fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input, settings, geminiKeyReached: "GEMINI_API_KEY" in process.env, googleKeyReached: "GOOGLE_API_KEY" in process.env, genaiReached: Object.keys(process.env).some((k) => k.startsWith("GOOGLE_GENAI_")), cwd: process.cwd() }));
    if (mode === "auth") {
      process.stderr.write("Manual authorization is required but the current session is non-interactive. Please run the Gemini CLI in an interactive terminal to log in, provide a GEMINI_API_KEY, or ensure Application Default Credentials are configured.\n");
      process.exit(41);
    }
    emit({ type: "init", session_id: "fake-session", model: process.env.FAKE_MODEL ?? "auto" });
    emit({ type: "message", role: "user", content: input });
    const delta = (content) => emit({ type: "message", role: "assistant", content, delta: true });
    const stats = { total_tokens: 40, input_tokens: 30, output_tokens: 10, cached: 5, input: 25, duration_ms: 900, tool_calls: 0, models: {} };
    if (mode === "crash") { process.stderr.write("boom\n"); process.exit(3); }
    if (mode === "stall") { delta("Starting the answer"); setInterval(() => {}, 1000); return; }
    if (mode === "quota") { emit({ type: "result", status: "error", error: { type: "Error", message: "You have exhausted your capacity on this model. Quota will reset after 3h." }, stats }); process.exit(1); }
    if (mode === "error-result") { emit({ type: "error", severity: "warning", message: "something odd" }); emit({ type: "result", status: "error", error: { type: "Error", message: "The model failed." }, stats }); process.exit(1); }
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
        if (i < chunks.length) delta(chunks[i++]);
        else { clearInterval(tick); emit({ type: "result", status: "success", stats }); process.exit(0); }
      }, 40);
    }, Number(process.env.FAKE_DELAY_MS ?? 0));
  });
}
