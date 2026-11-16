// Version comparison and the "Later" snooze. No Electron imports, so everything here is unit-tested.

export type Version = readonly [number, number, number];

export function parseVersion(text: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every(Number.isSafeInteger) ? parts : null;
}

// Only a strictly newer version is ever offered. Anything unparseable is not newer.
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

export const SNOOZE_MS = 24 * 60 * 60 * 1000;
export const CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const FOCUS_MIN_GAP_MS = 10 * 60 * 1000;

export interface Snooze {
  version: string;
  untilUnixMs: number;
}

export function parseSnooze(raw: string | null): Snooze | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Snooze> | null;
    if (value && typeof value.version === "string" && typeof value.untilUnixMs === "number") {
      return { version: value.version, untilUnixMs: value.untilUnixMs };
    }
  } catch {
    // A damaged file means no snooze.
  }
  return null;
}

// "Later" hides the prompt for the same version for a day. A different version asks again.
export function shouldPrompt(version: string, snooze: Snooze | null, now: number): boolean {
  return !(snooze && snooze.version === version && now < snooze.untilUnixMs);
}

export function shouldCheckOnFocus(lastCheckedAt: number | null, now: number): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= FOCUS_MIN_GAP_MS;
}
