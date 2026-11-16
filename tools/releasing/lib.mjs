// Shared by the release scripts. The app verifies what these produce in
// apps/desktop/src/main/update/signature.ts and manifest.ts; release.test.mjs checks both ends agree.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import fs from "node:fs";

export const SIGNATURE_DOMAIN = "0rqestra-update-v1";
export const PRODUCT = "0rqestra";
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function releaseFileNames(version) {
  return {
    windows: `${PRODUCT}_${version}_x64-setup.exe`,
    macUpdate: `${PRODUCT}_${version}_universal.zip`,
    macDmg: `${PRODUCT}_${version}_universal.dmg`,
  };
}

export function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// Accepts the PEM text itself or base64 of the PEM text, as a repository secret may hold either.
export function loadPrivateKey(secret, passphrase) {
  const trimmed = (secret ?? "").trim();
  if (!trimmed) throw new Error("UPDATE_SIGNING_PRIVATE_KEY is missing.");
  const pem = trimmed.startsWith("-----BEGIN") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
  const key = createPrivateKey({ key: pem, format: "pem", ...(passphrase ? { passphrase } : {}) });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The update signing key is not an Ed25519 key.");
  return key;
}

export function publicKeyBase64(privateKey) {
  return createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
}

export function signDigest(privateKey, version, sha512Hex) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid version: ${version}`);
  const message = Buffer.from(`${SIGNATURE_DOMAIN}\n${version}\n${sha512Hex.toLowerCase()}\n`, "utf8");
  return sign(null, message, privateKey).toString("base64");
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
