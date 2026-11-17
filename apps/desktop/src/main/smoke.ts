import { ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { errorMessage, type SmokeOutcome } from "./smoke-outcome";

// Runtime self-check of the renderer security boundary, run by `npm run smoke` and in CI.

interface SmokeOptions {
  window: BrowserWindow;
  outcome: SmokeOutcome;
  rendererFile: string;
  isRendererUrl: (url: string) => boolean;
  isTrusted: (event: IpcMainEvent) => boolean;
}

interface PreloadDiagnostics {
  sandboxed: unknown;
  contextIsolated: unknown;
}

export function runSmoke({ window, outcome, rendererFile, isRendererUrl, isTrusted }: SmokeOptions): void {
  const contents = window.webContents;

  contents.on("preload-error", (_event, _path, error) => outcome.fail("preload-error", error.message));
  contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame) outcome.fail("did-fail-load", `${code} ${description}`);
  });
  contents.on("render-process-gone", (_event, details) => outcome.fail("render-process-gone", details.reason));
  window.on("unresponsive", () => outcome.fail("unresponsive", "window became unresponsive"));
  window.on("closed", () => outcome.fail("window-closed", "window closed before checks finished"));

  const diagnostics = new Promise<PreloadDiagnostics>((resolve) => {
    ipcMain.on("smoke:diagnostics", (event, payload: PreloadDiagnostics) => {
      if (isTrusted(event)) resolve(payload);
    });
  });

  contents.once("did-finish-load", () => {
    runChecks(window, isRendererUrl, diagnostics).then(
      (failed) => (failed === 0 ? outcome.pass() : outcome.fail("check", `${failed} check(s) failed`)),
      (error: unknown) => outcome.fail("check-threw", errorMessage(error)),
    );
  });

  window.loadFile(rendererFile).catch((error: unknown) => outcome.fail("load-rejected", errorMessage(error)));
}

// Returns the number of failed checks.
async function runChecks(
  window: BrowserWindow,
  isRendererUrl: (url: string) => boolean,
  diagnostics: Promise<PreloadDiagnostics>,
): Promise<number> {
  const contents = window.webContents;
  let failed = 0;
  const record = (name: string, passed: boolean, detail: unknown) => {
    if (!passed) failed += 1;
    console.log(`${passed ? "PASS" : "FAIL  [check]"}  ${name}  ${JSON.stringify(detail)}`);
  };

  const diag = await diagnostics;
  record(
    "preload reports an OS-sandboxed renderer and an isolated context",
    diag.sandboxed === true && diag.contextIsolated === true,
    diag,
  );

  const globalsSeen = (await contents.executeJavaScript(
    "({ require: typeof require, process: typeof process, api: Object.keys(window.worktreeai ?? {}) })",
  )) as { require: string; process: string; api: string[] };
  record(
    "page has no Node.js globals and only the narrow preload API",
    globalsSeen.require === "undefined" &&
      globalsSeen.process === "undefined" &&
      JSON.stringify(globalsSeen.api) === JSON.stringify(["getAppInfo", "updates"]),
    globalsSeen,
  );

  const info = (await contents.executeJavaScript("window.worktreeai.getAppInfo()")) as {
    electronVersion?: string;
  };
  record("sender-validated IPC round trip works", info.electronVersion === process.versions.electron, info);

  const popupBlocked = (await contents.executeJavaScript(
    "window.open('https://example.invalid/') === null",
  )) as boolean;
  record("window.open is denied", popupBlocked, popupBlocked);

  await contents.executeJavaScript("location.href = 'https://example.invalid/'; 0");
  await new Promise((resolve) => setTimeout(resolve, 500));
  record("navigation away from the app page is blocked", isRendererUrl(contents.getURL()), contents.getURL());

  return failed;
}
