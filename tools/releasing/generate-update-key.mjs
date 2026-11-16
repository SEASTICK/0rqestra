#!/usr/bin/env node
// One-time setup, run by a person: creates the Ed25519 key pair that signs app updates.
//   node tools/releasing/generate-update-key.mjs <private-key-file>
// Set UPDATE_SIGNING_PRIVATE_KEY_PASSWORD to encrypt the private key file with a password.
// Keep the private key outside Git. See docs/release.md.
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";

const [out] = process.argv.slice(2);
if (!out) {
  console.error("usage: generate-update-key.mjs <private-key-file>");
  process.exit(2);
}
if (fs.existsSync(out)) {
  console.error(`Refusing to overwrite ${out}.`);
  process.exit(1);
}
const passphrase = process.env.UPDATE_SIGNING_PRIVATE_KEY_PASSWORD;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({
  format: "pem",
  type: "pkcs8",
  ...(passphrase ? { cipher: "aes-256-cbc", passphrase } : {}),
});
fs.writeFileSync(out, pem, { mode: 0o600, flag: "wx" });
console.log(`Private key written to ${out}${passphrase ? " (password protected)" : ""}.`);
console.log('Public key, for "publicKey" in apps/desktop/update-config.json:');
console.log(publicKey.export({ format: "der", type: "spki" }).toString("base64"));
