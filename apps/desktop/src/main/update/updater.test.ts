import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signedMessage } from "./signature.js";
import { text, Updater, type UpdaterDeps } from "./updater.js";
import { FOCUS_MIN_GAP_MS, SNOOZE_MS } from "./version.js";

const FEED = "https://feed.example/app";
const DOWNLOADS = "https://downloads.example/releases";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const sha512 = (content: string) => createHash("sha512").update(content).digest("hex");
const signatureFor = (version: string, content: string) =>
  sign(null, signedMessage(version, sha512(content)), privateKey).toString("base64");

interface Options {
  current?: string;
  published?: string;
  content?: string; // what the download returns
  signedContent?: string; // what the release signed
  signedVersion?: string;
  platform?: UpdaterDeps["platform"];
  choice?: "restart" | "later";
  manifestError?: boolean;
  downloadError?: boolean;
  installError?: boolean;
  blocked?: string;
}

function setup(options: Options = {}) {
  const published = options.published ?? "0.2.0";
  const content = options.content ?? "installer bytes";
  const log: string[] = [];
  const state = { now: 1_000_000, snooze: null as string | null, choice: options.choice ?? "later", published };
  const deps: UpdaterDeps = {
    currentVersion: options.current ?? "0.1.0",
    config: { channel: "stable", feedUrl: FEED, downloadBase: DOWNLOADS, publicKey: PUBLIC_KEY },
    platform: options.platform === undefined ? "windows-x86_64" : options.platform,
    async fetchText(url) {
      log.push(`fetch ${url}`);
      if (options.manifestError) throw new Error("offline");
      return JSON.stringify({
        version: state.published,
        notes: "- New things",
        platforms: {
          "windows-x86_64": {
            url: `${DOWNLOADS}/v${state.published}/App.exe`,
            signature: signatureFor(options.signedVersion ?? state.published, options.signedContent ?? content),
          },
        },
      });
    },
    async download(url) {
      log.push(`download ${url}`);
      if (options.downloadError) throw new Error("connection reset");
      return { filePath: "/tmp/update.exe", sha512Hex: sha512(content) };
    },
    async discard(filePath) {
      log.push(`discard ${filePath}`);
    },
    async install(filePath) {
      log.push(`install ${filePath}`);
      if (options.installError) throw new Error("disk full");
    },
    ...(options.blocked === undefined ? {} : { beforeInstall: async () => options.blocked ?? null }),
    readSnooze: () => state.snooze,
    writeSnooze(raw) {
      state.snooze = raw;
    },
    now: () => state.now,
    ui: {
      async promptReady(update) {
        log.push(`prompt ${update.version} from ${update.currentVersion}`);
        return state.choice;
      },
      info: (message) => void log.push(`info ${message}`),
      error: (message) => void log.push(`error ${message}`),
    },
  };
  return { updater: new Updater(deps), log, state };
}

describe("Updater", () => {
  it("downloads, verifies, and asks before installing a newer version", async () => {
    const { updater, log } = setup({ choice: "restart" });
    await updater.check(true);
    expect(log).toEqual([
      `fetch ${FEED}/latest.json`,
      `download ${DOWNLOADS}/v0.2.0/App.exe`,
      "prompt 0.2.0 from 0.1.0",
      "install /tmp/update.exe",
    ]);
    expect(updater.status).toBe("installing");
  });

  it("does not install when the user chooses Later, and stays quiet for a day", async () => {
    const { updater, log, state } = setup();
    await updater.check(true);
    expect(log.filter((line) => line.startsWith("install"))).toEqual([]);
    expect(JSON.parse(state.snooze ?? "")).toEqual({ version: "0.2.0", untilUnixMs: state.now + SNOOZE_MS });
    expect(updater.status).toBe("ready");

    log.length = 0;
    await updater.check(true);
    expect(log).toEqual([]); // already downloaded: no network, no prompt while snoozed

    await updater.check(false);
    expect(log).toEqual(["prompt 0.2.0 from 0.1.0"]); // asking by hand always shows it
  });

  it("does not prompt on a silent check for a version snoozed in an earlier session", async () => {
    const { updater, log, state } = setup();
    state.snooze = JSON.stringify({ version: "0.2.0", untilUnixMs: state.now + 1 });
    await updater.check(true);
    expect(log.some((line) => line.startsWith("prompt"))).toBe(false);
    expect(updater.status).toBe("ready");
  });

  it("offers nothing for the same or an older version", async () => {
    for (const published of ["0.1.0", "0.0.9"]) {
      const { updater, log } = setup({ published });
      await updater.check(true);
      expect(log).toEqual([`fetch ${FEED}/latest.json`]);
      expect(updater.status).toBe("current");
    }
  });

  it("says so when asked by hand and already current", async () => {
    const { updater, log } = setup({ published: "0.1.0" });
    await updater.check(false);
    expect(log.at(-1)).toBe(`info ${text.upToDate}`);
  });

  it("never offers a file whose content does not match the signature", async () => {
    const { updater, log } = setup({ content: "tampered bytes", signedContent: "installer bytes", choice: "restart" });
    await updater.check(false);
    expect(log).toContain("discard /tmp/update.exe");
    expect(log).toContain(`error ${text.signature}`);
    expect(log.some((line) => line.startsWith("prompt") || line.startsWith("install"))).toBe(false);
    expect(updater.status).toBe("error");
  });

  it("never offers an old signed file republished under a newer version number", async () => {
    const { updater, log } = setup({ published: "0.9.0", signedVersion: "0.0.5", choice: "restart" });
    await updater.check(true);
    expect(log).toContain("discard /tmp/update.exe");
    expect(log.some((line) => line.startsWith("prompt") || line.startsWith("install"))).toBe(false);
  });

  it("records errors of silent checks without showing them", async () => {
    for (const options of [{ manifestError: true }, { downloadError: true }, { content: "x", signedContent: "y" }]) {
      const { updater, log } = setup(options);
      await updater.check(true);
      expect(log.some((line) => line.startsWith("error") || line.startsWith("prompt"))).toBe(false);
      expect(updater.diagnostics?.result).toBe("error");
    }
  });

  it("shows network errors when asked by hand", async () => {
    const offline = setup({ manifestError: true });
    await offline.updater.check(false);
    expect(offline.log.at(-1)).toBe(`error ${text.networkCheck}`);
    expect(offline.updater.diagnostics?.detail).toBe("offline");

    const interrupted = setup({ downloadError: true });
    await interrupted.updater.check(false);
    expect(interrupted.log.at(-1)).toBe(`error ${text.networkDownload}`);
  });

  it("reports a missing file for this platform without downloading", async () => {
    const { updater, log } = setup({ platform: "darwin-aarch64" });
    await updater.check(false);
    expect(log).toEqual([`fetch ${FEED}/latest.json`, `error ${text.platform}`]);
  });

  it("keeps the download and reports when installing fails or is blocked", async () => {
    const failing = setup({ choice: "restart", installError: true });
    await failing.updater.check(true);
    expect(failing.log.at(-1)).toBe(`error ${text.install}`);
    expect(failing.updater.status).toBe("ready");

    const blocked = setup({ choice: "restart", blocked: "A task is running." });
    await blocked.updater.check(true);
    expect(blocked.log.at(-1)).toBe("error A task is running.");
    expect(blocked.log.some((line) => line.startsWith("install"))).toBe(false);
  });

  it("checks on focus only after the minimum gap", async () => {
    const { updater, log, state } = setup({ published: "0.1.0" });
    await updater.checkOnFocus();
    expect(log.length).toBe(1);
    state.now += FOCUS_MIN_GAP_MS - 1;
    await updater.checkOnFocus();
    expect(log.length).toBe(1);
    state.now += 1;
    await updater.checkOnFocus();
    expect(log.length).toBe(2);
  });

  it("ignores a second check while one is running", async () => {
    const { updater, log } = setup({ published: "0.1.0" });
    await Promise.all([updater.check(true), updater.check(true)]);
    expect(log.length).toBe(1);
  });
});

describe("Updater and the download address", () => {
  it("refuses a manifest whose file is not among the release downloads", async () => {
    const { updater, log } = setup();
    const deps = (updater as unknown as { deps: UpdaterDeps }).deps;
    deps.fetchText = async () =>
      JSON.stringify({ version: "0.2.0", platforms: { "windows-x86_64": { url: `${FEED}/App.exe`, signature: "c2ln" } } });
    await updater.check(false);
    expect(log).toEqual([`error ${text.networkCheck}`]);
    expect(updater.diagnostics?.detail).toMatch(/outside the release downloads/);
  });
});
