// Fake `gh` for offline tests of github.ts. It never contacts GitHub. FAKE_GH: signed-in (default) | signed-out | none-found | fail-clone (FAKE_GH_FILE: a file whose text is the mode, to change it while running).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_GH_FILE && fs.existsSync(process.env.FAKE_GH_FILE) ? fs.readFileSync(process.env.FAKE_GH_FILE, "utf8").trim() : (process.env.FAKE_GH ?? "signed-in");
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args, cwd: process.cwd(), tokenReached: Boolean(process.env.GH_TOKEN || process.env.ELECTRON_RUN_AS_NODE), prompt: process.env.GH_PROMPT_DISABLED })}\n`);
const [a, b] = args;
if (a === "--version") {
  console.log("gh version 2.89.0 (2026-03-26)\nhttps://github.com/cli/cli/releases/tag/v2.89.0");
} else if (a === "auth" && b === "status") {
  if (mode === "signed-out") { process.stderr.write("You are not logged into any GitHub hosts. To log in, run: gh auth login\n"); process.exit(1); }
  console.log("github.com\n  ✓ Logged in to github.com account philip-s (keyring)\n  - Active account: true\n  - Git operations protocol: https");
} else if (a === "api") {
  if (mode === "signed-out") { process.stderr.write("gh: To use GitHub CLI, please run: gh auth login\n"); process.exit(4); }
  if (mode === "none-found") process.exit(0);
  const rows = [
    { full_name: "SEASTICK/0rqestra", description: "Ett team av AI-agenter", private: false, pushed_at: "2026-11-25T10:00:00Z", fork: false, archived: false },
    { full_name: "SEASTICK/quantbot", description: null, private: true, pushed_at: "2026-10-01T10:00:00Z", fork: false, archived: false },
    { full_name: "school-org/lab", description: "x".repeat(300), private: true, pushed_at: null, fork: true, archived: true },
    { full_name: "bad name/with space", description: "refused", private: false },
  ];
  for (const r of rows) console.log(JSON.stringify(r));
  console.log("not json");
} else if (a === "repo" && b === "clone") {
  if (mode === "fail-clone") { process.stderr.write("fatal: could not read Username for 'https://github.com'\n"); process.exit(1); }
  const [repo, dest] = [args[2], args[3]];
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("git", ["init", "-q", dest]);
  fs.writeFileSync(path.join(dest, "README.md"), `# ${repo}\n`);
  execFileSync("git", ["-C", dest, "remote", "add", "origin", `https://github.com/${repo}.git`]);
} else if (a === "repo" && b === "view") {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    console.log(url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""));
  } catch { process.stderr.write("no git remotes found\n"); process.exit(1); }
} else {
  process.stderr.write(`unknown command ${args.join(" ")}\n`);
  process.exit(2);
}
