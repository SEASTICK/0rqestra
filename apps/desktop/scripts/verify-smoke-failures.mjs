// Proves the smoke harness fails closed. Each case copies the built app to a temp directory,
// breaks the copy in one controlled way, runs `electron <copy> --smoke`, and deletes the copy.
// The real build output is never modified. Run after `npm run build`.
//
// Each failure case must exit with code exactly 1, print exactly one "SMOKE FAILED", and be caught
// by one of the handlers it lists. Cases that are inherently racy list every handler that may win.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Most cases must finish on their own, so their time limit is generous: Electron can take several seconds
// to start on a busy CI machine, and a slow start must not look like a failure of the case. Cases that
// are meant to hang use a short limit, because the limit itself is what they test.
const SMOKE_TIMEOUT_MS = 30_000;
const HANG_TIMEOUT_MS = 8_000;
const IN_ACTIONS = process.env.GITHUB_ACTIONS === "true";

const ALL_HANDLERS = [
  "watchdog",
  "startup",
  "uncaught-exception",
  "unhandled-rejection",
  "preload-error",
  "did-fail-load",
  "render-process-gone",
  "unresponsive",
  "window-closed",
  "load-rejected",
  "check-threw",
  "check",
];

function edit(file, transform) {
  return (dir) => {
    const target = path.join(dir, file);
    const before = fs.readFileSync(target, "utf8");
    const after = transform(before);
    if (after === before) throw new Error(`mutation did not apply to ${file}`);
    fs.writeFileSync(target, after);
  };
}

const MAIN = "dist/main/main.js";
const PRELOAD = "dist/preload/preload.js";
const prependToPreload = (code) => edit(PRELOAD, (s) => `${code}\n${s}`);
const suppressDiagnostics = edit(PRELOAD, (s) =>
  s.replace('electron_1.ipcRenderer.send("smoke:diagnostics"', 'false && electron_1.ipcRenderer.send("smoke:diagnostics"'),
);
const afterSandboxSetup = (code) =>
  edit(MAIN, (s) => s.replace("electron_1.app.enableSandbox();", `electron_1.app.enableSandbox();\n${code}`));
const replaceWhenReady = (code) => edit(MAIN, (s) => s.replace(/electron_1\.app\s*\.whenReady\(\)/, code));
const both = (...mutations) => (dir) => mutations.forEach((m) => m(dir));

const cases = [
  { name: "unmodified copy", expectPass: true, mutate: () => {} },

  // Main-process startup, before or during window creation.
  { name: "app never becomes ready", expect: ["watchdog"], mutate: replaceWhenReady("new Promise(() => {})") },
  {
    name: "app readiness rejects",
    expect: ["startup"],
    mutate: replaceWhenReady('Promise.reject(new Error("injected whenReady rejection"))'),
  },
  {
    name: "permission setup throws",
    expect: ["startup"],
    mutate: edit(MAIN, (s) =>
      s.replace(
        "electron_1.session.defaultSession.setPermissionRequestHandler(",
        '(() => { throw new Error("injected permission setup failure"); })(), electron_1.session.defaultSession.setPermissionRequestHandler(',
      ),
    ),
  },
  {
    name: "BrowserWindow construction throws",
    expect: ["startup"],
    mutate: edit(MAIN, (s) =>
      s.replace(
        "new electron_1.BrowserWindow(",
        '(() => { throw new Error("injected BrowserWindow failure"); })() ?? new electron_1.BrowserWindow(',
      ),
    ),
  },
  {
    name: "uncaught exception during startup",
    expect: ["uncaught-exception"],
    mutate: afterSandboxSetup('setTimeout(() => { throw new Error("injected uncaught exception"); }, 0);'),
  },
  {
    name: "unhandled rejection during startup",
    expect: ["unhandled-rejection"],
    mutate: afterSandboxSetup('Promise.reject(new Error("injected unhandled rejection"));'),
  },

  // Renderer and page.
  { name: "preload throws", expect: ["preload-error"], mutate: prependToPreload('throw new Error("broken preload");') },
  {
    name: "renderer crashes at preload start (racy)",
    expect: ["load-rejected", "render-process-gone", "did-fail-load"],
    mutate: prependToPreload("process.crash();"),
  },
  {
    name: "renderer crashes while checks wait",
    expect: ["render-process-gone"],
    mutate: both(suppressDiagnostics, prependToPreload('window.addEventListener("load", () => setTimeout(() => process.crash(), 100));')),
  },
  { name: "renderer hangs (racy)", expect: ["watchdog", "unresponsive"], mutate: prependToPreload("process.hang();") },
  {
    name: "window closes itself early (racy)",
    expect: ["did-fail-load", "window-closed", "load-rejected"],
    mutate: prependToPreload("setTimeout(() => window.close(), 0);"),
  },
  {
    name: "window closes while checks wait",
    expect: ["window-closed"],
    mutate: both(suppressDiagnostics, prependToPreload('window.addEventListener("load", () => setTimeout(() => window.close(), 100));')),
  },
  {
    name: "renderer page missing",
    expect: ["did-fail-load", "load-rejected"],
    mutate: (dir) => fs.rmSync(path.join(dir, "dist/renderer/index.html")),
  },

  // Security checks.
  {
    name: "preload exposes an extra API",
    expect: ["check"],
    mutate: edit(PRELOAD, (s) => s.replace("getAppInfo:", "runCommand: () => undefined, getAppInfo:")),
  },
  {
    name: "preload API throws during a check",
    expect: ["check-threw"],
    mutate: edit(PRELOAD, (s) =>
      s.replace(
        'getAppInfo: () => electron_1.ipcRenderer.invoke("app:get-info")',
        'getAppInfo: () => { throw new Error("injected API failure"); }',
      ),
    ),
  },
  {
    name: "sandbox disabled",
    expect: ["check"],
    mutate: both(
      edit("dist/main/security.js", (s) => s.replace("sandbox: true", "sandbox: false")),
      edit(MAIN, (s) => s.replace("electron_1.app.enableSandbox();", "")),
    ),
  },
  {
    name: "context isolation disabled",
    expect: ["preload-error"],
    mutate: edit("dist/main/security.js", (s) => s.replace("contextIsolation: true", "contextIsolation: false")),
  },
  {
    name: "popup guard removed",
    expect: ["check"],
    mutate: edit(MAIN, (s) => s.replace(/contents\.setWindowOpenHandler\([^;]*;/, "")),
  },
  {
    name: "navigation guard removed",
    expect: ["did-fail-load", "check"],
    mutate: edit(MAIN, (s) => s.replace(/if \(!isRendererUrl\(url\)\)\s*event\.preventDefault\(\);/, "")),
  },
];

const exercised = new Set();
let allAsExpected = true;
const flaky = [];

function runCase(testCase) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orqestra-smoke-"));
  try {
    fs.cpSync(path.join(appDir, "dist"), path.join(dir, "dist"), { recursive: true });
    fs.copyFileSync(path.join(appDir, "package.json"), path.join(dir, "package.json"));
    testCase.mutate(dir);
    const limit = !testCase.expectPass && testCase.expect.includes("watchdog") ? HANG_TIMEOUT_MS : SMOKE_TIMEOUT_MS;
    const run = spawnSync(electronPath, [dir, "--smoke", `--smoke-timeout-ms=${limit}`], {
      encoding: "utf8",
      timeout: limit + 20_000,
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const verdicts = output.match(/SMOKE (PASSED|FAILED)/g) ?? [];
    const reason = output.split(/\r?\n/).find((l) => l.startsWith("FAIL")) ?? "";
    const handler = /^FAIL\s+\[([a-z-]+)\]/.exec(reason)?.[1] ?? null;

    let ok;
    if (testCase.expectPass) {
      ok = run.status === 0 && verdicts.length === 1 && verdicts[0] === "SMOKE PASSED";
    } else {
      ok =
        run.status === 1 &&
        verdicts.length === 1 &&
        verdicts[0] === "SMOKE FAILED" &&
        handler !== null &&
        testCase.expect.includes(handler);
    }
    const expected = testCase.expectPass ? "pass" : testCase.expect.join("|");
    const line = `${ok ? "OK  " : "BAD "} ${testCase.name}: exit=${run.status} verdicts=${verdicts.length} handler=${handler ?? "-"} expected=${expected} ${reason}`;
    // What the tool printed, for a case that did not behave as expected (the CI log is not always readable).
    const detail = ok ? "" : output.split(/\r?\n/).filter(Boolean).slice(-12).join(" | ").slice(0, 900);
    return { ok, line, handler, detail };
  } catch (error) {
    return { ok: false, line: `BAD  ${testCase.name}: harness error ${error.message}`, handler: null, detail: "" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// GitHub shows these as annotations on the run, readable without signing in to see the full log.
const annotate = (level, title, message) => {
  if (IN_ACTIONS) console.log(`::${level} title=${title}::${message.replace(/[\r\n%]/g, " ")}`);
};

for (const testCase of cases) {
  let result = runCase(testCase);
  console.log(result.line);
  if (!result.ok) {
    console.log(`     output: ${result.detail}`);
    annotate("warning", `Smoke case failed once: ${testCase.name}`, `${result.line} ${result.detail}`);
    // One more try. A machine that was too busy gets a second chance; a real defect fails twice. A case that
    // only passes the second time is reported, not hidden.
    const retry = runCase(testCase);
    console.log(`RETRY ${retry.line}`);
    if (retry.ok) {
      flaky.push(testCase.name);
      result = retry;
    } else {
      console.log(`     output: ${retry.detail}`);
      annotate("error", `Smoke case failed twice: ${testCase.name}`, `${retry.line} ${retry.detail}`);
      result = retry;
    }
  }
  allAsExpected &&= result.ok;
  if (!testCase.expectPass && result.handler) exercised.add(result.handler);
}

const notExercised = ALL_HANDLERS.filter((h) => !exercised.has(h));
console.log(`Handlers exercised: ${[...exercised].sort().join(", ")}`);
console.log(`Handlers not exercised: ${notExercised.join(", ") || "none"}`);
if (flaky.length) console.log(`Passed only on the second try: ${flaky.join(", ")}`);
console.log(allAsExpected ? "ALL FAILURE CASES BEHAVED AS EXPECTED" : "SOME CASES DID NOT BEHAVE AS EXPECTED");
process.exit(allAsExpected ? 0 : 1);
