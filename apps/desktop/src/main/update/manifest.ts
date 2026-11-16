import { parseVersion } from "./version";

// latest.json as published by the release workflow (tools/releasing/build-manifest.mjs).

export type PlatformKey = "windows-x86_64" | "darwin-aarch64" | "darwin-x86_64";

export interface PlatformEntry {
  url: string;
  signature: string;
}

export interface UpdateManifest {
  version: string;
  notes: string;
  pubDate: string | null;
  platforms: Partial<Record<string, PlatformEntry>>;
}

export interface UpdateConfig {
  channel: "stable" | "test";
  // Where latest.json is read from.
  feedUrl: string;
  // Update files must be below this address (the repository's release downloads).
  downloadBase: string;
  publicKey: string;
}

export function parseUpdateConfig(raw: string): UpdateConfig | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { channel, feedUrl, downloadBase, publicKey } = value as Record<string, unknown>;
  if (channel !== "stable" && channel !== "test") return null;
  if (typeof feedUrl !== "string" || typeof downloadBase !== "string" || typeof publicKey !== "string") return null;
  for (const url of [feedUrl, downloadBase]) {
    if (!URL.canParse(url) || new URL(url).protocol !== "https:") return null;
  }
  const trim = (url: string) => url.replace(/\/+$/, "");
  return { channel, feedUrl: trim(feedUrl), downloadBase: trim(downloadBase), publicKey: publicKey.trim() };
}

export function platformKey(platform: string, arch: string): PlatformKey | null {
  if (platform === "win32" && arch === "x64") return "windows-x86_64";
  if (platform === "darwin" && arch === "arm64") return "darwin-aarch64";
  if (platform === "darwin" && arch === "x64") return "darwin-x86_64";
  return null;
}

// Update files are only ever fetched over HTTPS from below the configured download address.
export function isUnderBase(url: string, feedUrl: string): boolean {
  if (!URL.canParse(url)) return false;
  const candidate = new URL(url);
  const feed = new URL(`${feedUrl}/`);
  return (
    candidate.protocol === "https:" &&
    candidate.host === feed.host &&
    candidate.username === "" &&
    candidate.password === "" &&
    candidate.pathname.startsWith(feed.pathname) &&
    !decodeURIComponentSafe(candidate.pathname).includes("..")
  );
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return "..";
  }
}

export function parseManifest(raw: string, downloadBase: string): UpdateManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("latest.json is not valid JSON");
  }
  if (typeof value !== "object" || value === null) throw new Error("latest.json is not an object");
  const { version, notes, pub_date: pubDate, platforms } = value as Record<string, unknown>;
  if (typeof version !== "string" || !parseVersion(version)) throw new Error("latest.json has no valid version");
  if (typeof platforms !== "object" || platforms === null) throw new Error("latest.json has no platforms");

  const entries: Record<string, PlatformEntry> = {};
  for (const [key, entry] of Object.entries(platforms as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) throw new Error(`latest.json platform ${key} is invalid`);
    const { url, signature } = entry as Record<string, unknown>;
    if (typeof url !== "string" || typeof signature !== "string" || signature === "") {
      throw new Error(`latest.json platform ${key} is invalid`);
    }
    if (!isUnderBase(url, downloadBase)) throw new Error(`latest.json platform ${key} points outside the release downloads`);
    entries[key] = { url, signature };
  }
  return {
    version,
    notes: typeof notes === "string" ? notes.trim() : "",
    pubDate: typeof pubDate === "string" ? pubDate : null,
    platforms: entries,
  };
}
