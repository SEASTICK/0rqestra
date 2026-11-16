// Electron-free smoke outcome: one watchdog and one idempotent verdict per process.
// Every outcome prints exactly one "SMOKE PASSED" (exit 0) or "SMOKE FAILED" (exit 1).

export type FailureSource =
  | "watchdog"
  | "startup"
  | "uncaught-exception"
  | "unhandled-rejection"
  | "preload-error"
  | "did-fail-load"
  | "render-process-gone"
  | "unresponsive"
  | "window-closed"
  | "load-rejected"
  | "check-threw"
  | "check";

export interface SmokeOutcome {
  fail(source: FailureSource, message: string): void;
  pass(): void;
  isFinished(): boolean;
}

interface OutcomeDeps {
  timeoutMs: number;
  exit: (code: 0 | 1) => void;
  log: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function parseSmokeTimeout(argv: readonly string[]): number {
  const arg = argv.find((a) => a.startsWith("--smoke-timeout-ms="));
  const value = arg ? Number(arg.split("=")[1]) : DEFAULT_TIMEOUT_MS;
  return Number.isInteger(value) && value >= 1_000 && value <= 120_000 ? value : DEFAULT_TIMEOUT_MS;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSmokeOutcome({ timeoutMs, exit, log }: OutcomeDeps): SmokeOutcome {
  let finished = false;

  const settle = (passed: boolean, line?: string): void => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    if (line) log(line);
    log(passed ? "SMOKE PASSED" : "SMOKE FAILED");
    exit(passed ? 0 : 1);
  };

  const fail = (source: FailureSource, message: string): void => settle(false, `FAIL  [${source}] ${message}`);

  const watchdog = setTimeout(() => fail("watchdog", `timed out after ${timeoutMs} ms`), timeoutMs);

  return { fail, pass: () => settle(true), isFinished: () => finished };
}

export function installProcessFailureHandlers(outcome: SmokeOutcome): void {
  process.on("uncaughtException", (error) => outcome.fail("uncaught-exception", errorMessage(error)));
  process.on("unhandledRejection", (reason) => outcome.fail("unhandled-rejection", errorMessage(reason)));
}
