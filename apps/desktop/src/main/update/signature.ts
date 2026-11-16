import { createPublicKey, verify } from "node:crypto";

// An update file is accepted only with an Ed25519 signature made by the release workflow.
// The signed message binds the version to the file's SHA-512, so a signed file cannot be
// republished under another version number. tools/releasing/sign-update.mjs builds the same message.

export const SIGNATURE_DOMAIN = "0rqestra-update-v1";

export function signedMessage(version: string, sha512Hex: string): Buffer {
  return Buffer.from(`${SIGNATURE_DOMAIN}\n${version}\n${sha512Hex.toLowerCase()}\n`, "utf8");
}

// publicKey: base64 of the DER-encoded SPKI Ed25519 public key. signature: base64 of the 64 raw bytes.
export function verifyUpdateSignature(publicKey: string, version: string, sha512Hex: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    const raw = Buffer.from(signature.trim(), "base64");
    if (raw.length !== 64 || !/^[0-9a-f]{128}$/i.test(sha512Hex)) return false;
    return verify(null, signedMessage(version, sha512Hex), key, raw);
  } catch {
    return false;
  }
}
