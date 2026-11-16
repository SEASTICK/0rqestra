// Starts Claude Code's own sign-in flow for the probes. The user completes it in the browser;
// this script never sees or stores credentials. It uses a dedicated config directory so the
// user's normal Claude Code and desktop app configuration is left untouched.
//
// Usage: node tools/provider-probes/claude-login.mjs "<path to claude>" [login|status|logout]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { cleanEnv, probeClaudeConfigDir } from "./lib.mjs";

const bin = process.argv[2] ?? process.env.WORKTREEAI_CLAUDE_BIN;
const action = process.argv[3] ?? "login";
if (!bin || !["login", "status", "logout"].includes(action)) {
  console.error('Usage: node claude-login.mjs "<path to claude>" [login|status|logout]');
  process.exit(2);
}

const configDir = probeClaudeConfigDir();
fs.mkdirSync(configDir, { recursive: true });
console.log(`Claude Code ${action} for WorkTreeAI probes (separate config folder).`);
if (action === "login") {
  console.log("Choose your Claude subscription account, not a Console/API account.");
}
const run = spawnSync(bin, ["auth", action], {
  env: cleanEnv({ CLAUDE_CONFIG_DIR: configDir }),
  stdio: "inherit",
});
process.exit(run.status ?? 1);
