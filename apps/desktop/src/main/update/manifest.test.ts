import { describe, expect, it } from "vitest";
import { isUnderFeed, parseManifest, parseUpdateConfig, platformKey } from "./manifest.js";

const FEED = "https://updates.example/app";
const entry = (url: string) => ({ url, signature: "c2ln" });
const manifest = (platforms: unknown, version: unknown = "1.2.3") => JSON.stringify({ version, notes: " Hi ", pub_date: "2026-01-01T00:00:00Z", platforms });

describe("update config", () => {
  it("accepts a valid config and trims the feed URL", () => {
    expect(parseUpdateConfig(JSON.stringify({ channel: "test", feedUrl: `${FEED}/test/`, publicKey: " key " }))).toEqual({
      channel: "test",
      feedUrl: `${FEED}/test`,
      publicKey: "key",
    });
  });

  it("rejects a bad channel, a non-HTTPS feed, and malformed input", () => {
    const ok = { channel: "stable", feedUrl: FEED, publicKey: "" };
    expect(parseUpdateConfig(JSON.stringify(ok))).not.toBeNull();
    expect(parseUpdateConfig(JSON.stringify({ ...ok, channel: "beta" }))).toBeNull();
    expect(parseUpdateConfig(JSON.stringify({ ...ok, feedUrl: "http://updates.example/app" }))).toBeNull();
    expect(parseUpdateConfig(JSON.stringify({ ...ok, publicKey: 1 }))).toBeNull();
    expect(parseUpdateConfig("{")).toBeNull();
    expect(parseUpdateConfig("null")).toBeNull();
  });
});

describe("platform keys", () => {
  it("maps supported platforms and nothing else", () => {
    expect(platformKey("win32", "x64")).toBe("windows-x86_64");
    expect(platformKey("darwin", "arm64")).toBe("darwin-aarch64");
    expect(platformKey("darwin", "x64")).toBe("darwin-x86_64");
    expect(platformKey("win32", "arm64")).toBeNull();
    expect(platformKey("linux", "x64")).toBeNull();
  });
});

describe("update file URLs", () => {
  it("allows only HTTPS URLs below the feed", () => {
    expect(isUnderFeed(`${FEED}/App_1.2.3.exe`, FEED)).toBe(true);
    expect(isUnderFeed(`${FEED}/test/App_1.2.3.exe`, FEED)).toBe(true);
    for (const bad of [
      "http://updates.example/app/a.exe",
      "https://evil.example/app/a.exe",
      "https://updates.example.evil.example/app/a.exe",
      "https://updates.example/other/a.exe",
      "https://updates.example/application/a.exe",
      "https://updates.example/app/../other/a.exe",
      "https://updates.example/app/%2e%2e/other/a.exe",
      "https://user@updates.example/app/a.exe",
      "https://updates.example:8443/app/a.exe",
      "not a url",
    ]) {
      expect(isUnderFeed(bad, FEED), bad).toBe(false);
    }
  });

  it("keeps a stable app off the test channel's parent and a test app inside /test", () => {
    expect(isUnderFeed(`${FEED}/a.exe`, `${FEED}/test`)).toBe(false);
    expect(isUnderFeed(`${FEED}/test/a.exe`, `${FEED}/test`)).toBe(true);
  });
});

describe("latest.json", () => {
  it("parses a valid manifest", () => {
    const parsed = parseManifest(manifest({ "windows-x86_64": entry(`${FEED}/a.exe`) }), FEED);
    expect(parsed).toEqual({
      version: "1.2.3",
      notes: "Hi",
      pubDate: "2026-01-01T00:00:00Z",
      platforms: { "windows-x86_64": entry(`${FEED}/a.exe`) },
    });
  });

  it("rejects malformed manifests", () => {
    expect(() => parseManifest("<html>", FEED)).toThrow(/JSON/);
    expect(() => parseManifest("[]", FEED)).toThrow();
    expect(() => parseManifest(manifest({}, "1.2"), FEED)).toThrow(/version/);
    expect(() => parseManifest(manifest(null), FEED)).toThrow(/platforms/);
    expect(() => parseManifest(manifest({ "windows-x86_64": { url: `${FEED}/a.exe` } }), FEED)).toThrow(/invalid/);
    expect(() => parseManifest(manifest({ "windows-x86_64": { url: `${FEED}/a.exe`, signature: "" } }), FEED)).toThrow(/invalid/);
  });

  it("rejects a manifest that points outside the update site", () => {
    expect(() => parseManifest(manifest({ "windows-x86_64": entry("https://evil.example/a.exe") }), FEED)).toThrow(/outside/);
  });
});
