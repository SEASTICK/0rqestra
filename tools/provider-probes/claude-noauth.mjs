// Claude Code probes that CANNOT reach a model: every run uses an empty, temporary config
// directory (no credentials) and a cleaned environment (no API keys). Zero model requests.
//
// Usage: WORKTREEAI_CLAUDE_BIN=<path to claude> node tools/provider-probes/claude-noauth.mjs
import { spawnSync } from "node:child_process";
import { cleanEnv, markers, removeDir, saveResult, tempDir, writeHostileFixture } from "./lib.mjs";

const bin = process.env.WORKTREEAI_CLAUDE_BIN;
if (!bin) {
  console.error("Set WORKTREEAI_CLAUDE_BIN to the claude executable.");
  process.exit(2);
}

const PROMPT = "Reply with exactly: OK";
const STREAM = ["--output-format", "stream-json", "--verbose", "--max-turns", "1", "--no-session-persistence"];
const PROFILE_A = [
  "--safe-mode",
  "--setting-sources", "user",
  "--settings", JSON.stringify({ disableAllHooks: true, switchModelsOnFlag: false }),
  "--strict-mcp-config",
  "--tools", "Read",
  "--disallowedTools", "Agent", "mcp__*",
  "--permission-mode", "default",
  "--permission-prompts", "none",
];

const cases = [
  { name: "auth-status", fixture: "empty", args: ["auth", "status"], raw: true },
  { name: "nologin-json", fixture: "empty", args: ["-p", PROMPT, "--output-format", "json", "--max-turns", "1", "--no-session-persistence"] },
  { name: "control-no-suppression", fixture: "hostile", args: ["-p", PROMPT, ...STREAM] },
  { name: "only-setting-sources-user", fixture: "hostile", args: ["-p", PROMPT, "--setting-sources", "user", ...STREAM] },
  { name: "only-safe-mode", fixture: "hostile", args: ["-p", PROMPT, "--safe-mode", ...STREAM] },
  { name: "only-strict-mcp-config", fixture: "hostile", args: ["-p", PROMPT, "--strict-mcp-config", ...STREAM] },
  { name: "profile-a", fixture: "hostile", args: ["-p", PROMPT, ...PROFILE_A, ...STREAM] },
];

function parseLines(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ type: "unparsed", text: line.slice(0, 300) });
    }
  }
  return events;
}

function summarize(events) {
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const result = events.find((e) => e.type === "result") ?? (events.length === 1 && events[0].type !== "unparsed" ? events[0] : undefined);
  return {
    eventTypes: events.map((e) => (e.subtype ? `${e.type}/${e.subtype}` : e.type)),
    init: init && {
      model: init.model,
      permissionMode: init.permissionMode,
      apiKeySource: init.apiKeySource,
      tools: init.tools,
      mcp_servers: init.mcp_servers,
      agents: init.agents,
      plugins: init.plugins,
      slashCommandCount: Array.isArray(init.slash_commands) ? init.slash_commands.length : undefined,
      skills: init.skills,
      capabilities: init.capabilities,
    },
    hookEvents: events.filter((e) => e.type === "system" && String(e.subtype).startsWith("hook")).map((e) => ({
      subtype: e.subtype, hook_event: e.hook_event, hook_name: e.hook_name,
    })),
    result: result && {
      type: result.type, subtype: result.subtype, is_error: result.is_error,
      result: typeof result.result === "string" ? result.result.slice(0, 300) : result.result,
      num_turns: result.num_turns, total_cost_usd: result.total_cost_usd,
      modelUsageKeys: result.modelUsage ? Object.keys(result.modelUsage) : undefined,
    },
  };
}

const version = spawnSync(bin, ["--version"], { encoding: "utf8", env: cleanEnv(), timeout: 30_000 });
const report = {
  probe: "claude-noauth",
  ranAt: new Date().toISOString(),
  platform: process.platform,
  claudeVersion: (version.stdout ?? "").trim(),
  modelRequestsPossible: false,
  why: "Empty temporary CLAUDE_CONFIG_DIR (no credentials) and a cleaned environment (no API keys).",
  cases: [],
};

for (const testCase of cases) {
  const configDir = tempDir("claude-config");
  const projectDir = tempDir("claude-project");
  try {
    if (testCase.fixture === "hostile") writeHostileFixture(projectDir);
    const started = Date.now();
    const run = spawnSync(bin, testCase.args, {
      cwd: projectDir,
      encoding: "utf8",
      env: cleanEnv({ CLAUDE_CONFIG_DIR: configDir }),
      input: "",
      timeout: 90_000,
      windowsHide: true,
    });
    const entry = {
      name: testCase.name,
      args: testCase.args,
      exitCode: run.status,
      signal: run.signal,
      timedOut: run.error?.code === "ETIMEDOUT",
      durationMs: Date.now() - started,
      stderr: (run.stderr ?? "").slice(0, 600),
      markers: testCase.fixture === "hostile" ? markers(projectDir) : undefined,
    };
    if (testCase.raw) entry.stdout = (run.stdout ?? "").slice(0, 800);
    else Object.assign(entry, summarize(parseLines(run.stdout ?? "")));
    report.cases.push(entry);
    console.log(`${testCase.name}: exit=${run.status} markers=${JSON.stringify(entry.markers ?? {})}`);
  } finally {
    removeDir(configDir);
    removeDir(projectDir);
  }
}

console.log(`saved ${saveResult("claude-noauth", report)}`);
