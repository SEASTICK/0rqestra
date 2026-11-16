import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSmokeOutcome, parseSmokeTimeout } from "./smoke-outcome.js";

describe("smoke outcome", () => {
  let exit: ReturnType<typeof vi.fn<(code: 0 | 1) => void>>;
  let lines: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    exit = vi.fn<(code: 0 | 1) => void>();
    lines = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const create = (timeoutMs = 20_000) => createSmokeOutcome({ timeoutMs, exit, log: (l) => lines.push(l) });

  it("reports exactly one failure and exits 1, even when failed repeatedly", () => {
    const outcome = create();
    outcome.fail("startup", "first");
    outcome.fail("check", "second");
    outcome.pass();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toEqual(["FAIL  [startup] first", "SMOKE FAILED"]);
  });

  it("reports exactly one pass and ignores later failures", () => {
    const outcome = create();
    outcome.pass();
    outcome.fail("watchdog", "late");

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(lines).toEqual(["SMOKE PASSED"]);
  });

  it("fails through the watchdog when nothing settles in time", () => {
    create(5_000);
    vi.advanceTimersByTime(4_999);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toEqual(["FAIL  [watchdog] timed out after 5000 ms", "SMOKE FAILED"]);
  });

  it("cancels the watchdog once a verdict is reached", () => {
    create(5_000).pass();
    vi.advanceTimersByTime(10_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe("parseSmokeTimeout", () => {
  it("defaults to 20 seconds", () => {
    expect(parseSmokeTimeout([])).toBe(20_000);
  });

  it("accepts a bounded override and rejects out-of-range or invalid values", () => {
    expect(parseSmokeTimeout(["--smoke-timeout-ms=8000"])).toBe(8_000);
    expect(parseSmokeTimeout(["--smoke-timeout-ms=500"])).toBe(20_000);
    expect(parseSmokeTimeout(["--smoke-timeout-ms=999999"])).toBe(20_000);
    expect(parseSmokeTimeout(["--smoke-timeout-ms=abc"])).toBe(20_000);
  });
});
