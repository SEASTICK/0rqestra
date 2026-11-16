import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "../../apps/desktop/src/main/update/manifest.ts";
import { verifyUpdateSignature } from "../../apps/desktop/src/main/update/signature.ts";
import { buildManifest } from "./build-manifest.mjs";
import { loadPrivateKey, publicKeyBase64, releaseFileNames, sha512File, signDigest } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FEED = "https://raw.githubusercontent.com/OWNER/REPO/update-feed";
const DOWNLOADS = "https://github.com/OWNER/REPO/releases/download";

// Child processes get the real environment (Windows needs it) minus anything that steers the scripts.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of ["UPDATE_SIGNING_PRIVATE_KEY", "UPDATE_SIGNING_PRIVATE_KEY_PASSWORD", "DOWNLOAD_BASE"]) {
    if (!(name in extra)) delete env[name];
  }
  return env;
}

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-test-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function newKey(passphrase) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({
    format: "pem",
    type: "pkcs8",
    ...(passphrase ? { cipher: "aes-256-cbc", passphrase } : {}),
  });
  return { pem, publicKey: publicKeyBase64(privateKey) };
}

// A signed release file set, as the build and publish jobs produce it.
async function releaseSet(version, key) {
  const names = releaseFileNames(version);
  for (const [name, content] of [
    [names.windows, "windows installer"],
    [names.macUpdate, "mac update"],
    [names.macDmg, "mac disk image"],
  ]) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  for (const name of [names.windows, names.macUpdate]) {
    const file = path.join(dir, name);
    fs.writeFileSync(`${file}.sig`, `${signDigest(loadPrivateKey(key.pem), version, await sha512File(file))}\n`);
  }
  return names;
}

describe("update signing, checked against the app's verifier", () => {
  it("a file signed by the release script is accepted by the app", async () => {
    const key = newKey();
    const names = await releaseSet("1.2.3", key);
    const file = path.join(dir, names.windows);
    const signature = fs.readFileSync(`${file}.sig`, "utf8");
    expect(verifyUpdateSignature(key.publicKey, "1.2.3", await sha512File(file), signature)).toBe(true);
  });

  it("the app rejects another version, another file, and another key", async () => {
    const key = newKey();
    const names = await releaseSet("1.2.3", key);
    const file = path.join(dir, names.windows);
    const signature = fs.readFileSync(`${file}.sig`, "utf8");
    const digest = await sha512File(file);
    expect(verifyUpdateSignature(key.publicKey, "1.2.4", digest, signature)).toBe(false);
    expect(verifyUpdateSignature(key.publicKey, "1.2.3", await sha512File(path.join(dir, names.macUpdate)), signature)).toBe(false);
    expect(verifyUpdateSignature(newKey().publicKey, "1.2.3", digest, signature)).toBe(false);
    expect(verifyUpdateSignature("", "1.2.3", digest, signature)).toBe(false);
    expect(verifyUpdateSignature(key.publicKey, "1.2.3", digest, "")).toBe(false);
  });

  it("loads a key given as PEM, as base64 of PEM, or password protected", () => {
    const plain = newKey();
    expect(publicKeyBase64(loadPrivateKey(plain.pem))).toBe(plain.publicKey);
    expect(publicKeyBase64(loadPrivateKey(Buffer.from(plain.pem).toString("base64")))).toBe(plain.publicKey);
    const locked = newKey("secret");
    expect(publicKeyBase64(loadPrivateKey(locked.pem, "secret"))).toBe(locked.publicKey);
    expect(() => loadPrivateKey(locked.pem)).toThrow();
    expect(() => loadPrivateKey("")).toThrow(/missing/);
  });
});

describe("build-manifest", () => {
  it("writes a manifest the app accepts, with signatures that verify", async () => {
    const key = newKey();
    const names = await releaseSet("0.3.0", key);
    const manifest = buildManifest({ channel: "stable", version: "0.3.0", filesDir: dir, notes: "- Fix", downloadBase: DOWNLOADS });
    const parsed = parseManifest(JSON.stringify(manifest), DOWNLOADS);
    expect(parsed.version).toBe("0.3.0");
    expect(parsed.notes).toBe("- Fix");
    expect(Object.keys(parsed.platforms).sort()).toEqual(["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]);
    expect(parsed.platforms["windows-x86_64"].url).toBe(`${DOWNLOADS}/v0.3.0/${names.windows}`);
    expect(parsed.platforms["darwin-aarch64"]).toEqual(parsed.platforms["darwin-x86_64"]);
    const digest = await sha512File(path.join(dir, names.macUpdate));
    expect(verifyUpdateSignature(key.publicKey, "0.3.0", digest, parsed.platforms["darwin-aarch64"].signature)).toBe(true);
  });

  it("points a test release at its own test-v tag", async () => {
    await releaseSet("0.3.0", newKey());
    const manifest = buildManifest({ channel: "test", version: "0.3.0", filesDir: dir, notes: "", downloadBase: DOWNLOADS });
    expect(manifest.platforms["windows-x86_64"].url.startsWith(`${DOWNLOADS}/test-v0.3.0/`)).toBe(true);
    expect(manifest.notes).toBe("Improvements and fixes.");
    expect(() => parseManifest(JSON.stringify(manifest), DOWNLOADS)).not.toThrow();
  });

  it("refuses an incomplete file set", async () => {
    const names = await releaseSet("0.3.0", newKey());
    fs.rmSync(path.join(dir, `${names.macUpdate}.sig`));
    expect(() => buildManifest({ channel: "stable", version: "0.3.0", filesDir: dir, notes: "", downloadBase: DOWNLOADS })).toThrow(
      /Missing release file/,
    );
  });
});

describe("release scripts", () => {
  // A copy of the two files the scripts edit, so the real ones are never touched.
  function fakeRepo(publicKey) {
    const desktop = path.join(dir, "apps/desktop");
    fs.mkdirSync(desktop, { recursive: true });
    fs.copyFileSync(path.join(here, "../../apps/desktop/package.json"), path.join(desktop, "package.json"));
    fs.writeFileSync(
      path.join(desktop, "update-config.json"),
      JSON.stringify({ channel: "stable", feedUrl: FEED, downloadBase: DOWNLOADS, publicKey }),
    );
    const read = (name) => JSON.parse(fs.readFileSync(path.join(desktop, name), "utf8"));
    return { read };
  }
  const prepare = (...args) =>
    spawnSync(process.execPath, [path.join(here, "prepare-release.mjs"), ...args, dir], { encoding: "utf8", env: childEnv() });

  it("prepare-release sets only the version for stable", () => {
    const repo = fakeRepo("key");
    const before = repo.read("package.json");
    expect(prepare("stable", "0.4.0").status).toBe(0);
    expect(repo.read("package.json")).toEqual({ ...before, version: "0.4.0" });
    expect(repo.read("update-config.json")).toEqual({ channel: "stable", feedUrl: FEED, downloadBase: DOWNLOADS, publicKey: "key" });
  });

  it("prepare-release gives a test build its own name, app id, and update address", () => {
    const repo = fakeRepo("key");
    const before = repo.read("package.json");
    expect(prepare("test", "0.4.1").status).toBe(0);
    const after = repo.read("package.json");
    expect(after.version).toBe("0.4.1");
    expect(after.build.appId).toBe(`${before.build.appId}.updatertest`);
    expect(after.build.productName).toBe(`${before.build.productName} Updater Test`);
    expect(repo.read("update-config.json")).toEqual({ channel: "test", feedUrl: `${FEED}/test`, downloadBase: DOWNLOADS, publicKey: "key" });
  });

  it("prepare-release refuses bad arguments", () => {
    fakeRepo("");
    expect(prepare("beta", "0.4.0").status).toBe(2);
    expect(prepare("stable", "0.4").status).toBe(2);
  });

  it("sign-update refuses a key that does not match the app's public key", () => {
    // The repository's own update-config.json decides; a fresh random key can never match it.
    const result = spawnSync(process.execPath, [path.join(here, "sign-update.mjs"), "--check"], {
      encoding: "utf8",
      env: childEnv({ UPDATE_SIGNING_PRIVATE_KEY: newKey().pem }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/publicKey|does not match/);
  });

  it("generate-update-key writes a usable key and never overwrites one", () => {
    const out = path.join(dir, "update.key");
    const script = path.join(here, "generate-update-key.mjs");
    const stdout = execFileSync(process.execPath, [script, out], { encoding: "utf8", env: childEnv() });
    const printed = stdout.trim().split("\n").at(-1);
    expect(publicKeyBase64(loadPrivateKey(fs.readFileSync(out, "utf8")))).toBe(printed);
    expect(spawnSync(process.execPath, [script, out], { env: childEnv() }).status).toBe(1);
  });
});
