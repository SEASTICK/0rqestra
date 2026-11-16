// Copies sanitized probe results from out/ (git-ignored) into docs/evidence for review.
// Usage: node tools/provider-probes/export-evidence.mjs <YYYY-MM-DD>
import fs from "node:fs";
import path from "node:path";
import { here, outDir, sanitize } from "./lib.mjs";

const date = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
  console.error("Usage: node export-evidence.mjs <YYYY-MM-DD>");
  process.exit(2);
}

const target = path.join(here, "..", "..", "docs", "evidence", "provider-runtime", date);
fs.mkdirSync(target, { recursive: true });
for (const name of ["claude-noauth.json", "claude-auth.json", "codex-handshake.json", "codex-turns.json", "request-ledger.json"]) {
  const source = path.join(outDir(), name);
  if (!fs.existsSync(source)) continue;
  const data = sanitize(JSON.parse(fs.readFileSync(source, "utf8")));
  fs.writeFileSync(path.join(target, name), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`exported ${name}`);
}
