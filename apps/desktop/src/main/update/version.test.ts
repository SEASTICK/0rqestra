import { describe, expect, it } from "vitest";
import { FOCUS_MIN_GAP_MS, isNewerVersion, parseSnooze, parseVersion, shouldCheckOnFocus, shouldPrompt } from "./version.js";

describe("version comparison", () => {
  it("parses only plain X.Y.Z", () => {
    expect(parseVersion("1.20.3")).toEqual([1, 20, 3]);
    for (const bad of ["1.2", "v1.2.3", "1.2.3-beta", "1.2.3.4", "", "a.b.c", " 1.2.3"]) {
      expect(parseVersion(bad)).toBeNull();
    }
  });

  it("offers only a strictly newer version, comparing numerically", () => {
    expect(isNewerVersion("0.1.1", "0.1.0")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.0.9", "0.1.0")).toBe(false);
    expect(isNewerVersion("latest", "0.1.0")).toBe(false);
    expect(isNewerVersion("9.9.9", "dev")).toBe(false);
  });
});

describe("snooze and focus checks", () => {
  it("does not ask about the snoozed version until the snooze ends", () => {
    const snooze = { version: "0.2.0", untilUnixMs: 1000 };
    expect(shouldPrompt("0.2.0", snooze, 999)).toBe(false);
    expect(shouldPrompt("0.2.0", snooze, 1000)).toBe(true);
    expect(shouldPrompt("0.3.0", snooze, 999)).toBe(true);
    expect(shouldPrompt("0.2.0", null, 0)).toBe(true);
  });

  it("treats a damaged snooze file as no snooze", () => {
    expect(parseSnooze(null)).toBeNull();
    expect(parseSnooze("not json")).toBeNull();
    expect(parseSnooze('{"version":1}')).toBeNull();
    expect(parseSnooze("null")).toBeNull();
    expect(parseSnooze('{"version":"0.2.0","untilUnixMs":5}')).toEqual({ version: "0.2.0", untilUnixMs: 5 });
  });

  it("checks on focus at most once per gap", () => {
    expect(shouldCheckOnFocus(null, 0)).toBe(true);
    expect(shouldCheckOnFocus(0, FOCUS_MIN_GAP_MS - 1)).toBe(false);
    expect(shouldCheckOnFocus(0, FOCUS_MIN_GAP_MS)).toBe(true);
  });
});
