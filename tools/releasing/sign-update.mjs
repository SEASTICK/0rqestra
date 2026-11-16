#!/usr/bin/env node
// Signs update files in CI and writes <file>.sig next to each.
//   node tools/releasing/sign-update.mjs <X.Y.Z> <file>...
//   node tools/releasing/sign-update.mjs --check      only checks that the key is usable
// Reads UPDATE_SIGNING_PRIVATE_KEY (and optionally UPDATE_SIGNING_PRIVATE_KEY_PASSWORD).
// Refuses to sign when the key does not match the public key built into the app, because the
// installed apps could then never verify the update.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrivateKey, publicKeyBase64, readJson, sha512File, signDigest, VERSION_PATTERN } from "./lib.mjs";

const [version, ...files] = process.argv.slice(2);
const checkOnly = version === "--check" && files.length === 0;
if (!checkOnly && (!VERSION_PATTERN.test(version ?? "") || files.length === 0)) {
  console.error("usage: sign-update.mjs <X.Y.Z> <file>...");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
try {
  const key = loadPrivateKey(process.env.UPDATE_SIGNING_PRIVATE_KEY, process.env.UPDATE_SIGNING_PRIVATE_KEY_PASSWORD);
  const expected = readJson(path.join(root, "apps/desktop/update-config.json")).publicKey;
  if (!expected) throw new Error('apps/desktop/update-config.json has no "publicKey". See docs/release.md.');
  if (publicKeyBase64(key) !== expected) {
    throw new Error("UPDATE_SIGNING_PRIVATE_KEY does not match the public key in apps/desktop/update-config.json.");
  }
  if (checkOnly) console.log("The update signing key matches the public key built into the app.");
  for (const file of files) {
    fs.writeFileSync(`${file}.sig`, `${signDigest(key, version, await sha512File(file))}\n`);
    console.log(`Signed ${path.basename(file)}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
