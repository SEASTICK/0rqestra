import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, session, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { isDevToolsShortcut, isSameFileUrl, isTrustedSender, mainWindowOptions, type SenderInfo } from "./security";
import { runSmoke } from "./smoke";
import { registerUpdateIpc, startUpdater } from "./update";
import { createAdapters, registerChatIpc } from "./chat-ipc";
import { registerTeamIpc } from "./team/team-ipc";
import { registerAccountsIpc } from "./accounts/accounts-ipc";
import { handlePreviewScheme, isPreviewUrl, registerPreviewScheme } from "./preview/preview-protocol";
import {
  createSmokeOutcome,
  errorMessage,
  installProcessFailureHandlers,
  parseSmokeTimeout,
} from "./smoke-outcome";

// In smoke mode the verdict and watchdog exist before any asynchronous startup begins.
const smoke = process.argv.includes("--smoke")
  ? createSmokeOutcome({
      timeoutMs: parseSmokeTimeout(process.argv),
      exit: (code) => app.exit(code),
      log: (line) => console.log(line),
    })
  : null;
if (smoke) installProcessFailureHandlers(smoke);

const rendererFile = path.join(__dirname, "..", "renderer", "index.html");
const rendererUrl = pathToFileURL(rendererFile).href;
const preloadFile = path.join(__dirname, "..", "preload", "preload.js");
// Copied next to the renderer by scripts/build-ui.mjs from assets/icon/.
const iconFile = path.join(__dirname, "..", process.platform === "win32" ? "icon.ico" : "icon.png");
const caseInsensitivePaths = process.platform === "win32";
const isRendererUrl = (url: string | undefined) => isSameFileUrl(url, rendererUrl, caseInsensitivePaths);

let mainWindow: BrowserWindow | null = null;

function senderInfo(event: IpcMainEvent | IpcMainInvokeEvent): SenderInfo {
  const frame = event.senderFrame;
  return {
    webContentsId: event.sender.id,
    isMainFrame: frame !== null && frame.frameTreeNodeId === event.sender.mainFrame.frameTreeNodeId,
    frameUrl: frame?.url,
  };
}

function isFromMainWindow(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return (
    mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    isTrustedSender(senderInfo(event), {
      webContentsId: mainWindow.webContents.id,
      rendererUrl,
      caseInsensitivePaths,
    })
  );
}

function onStartupFailure(error: unknown): void {
  if (smoke) {
    smoke.fail("startup", errorMessage(error));
    return;
  }
  console.error("0rqestra failed to start:", error);
  app.exit(1);
}

app.enableSandbox();
registerPreviewScheme();

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isRendererUrl(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // A frame inside the window may only show a project's preview (see preview/products.ts).
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !isPreviewUrl(event.url)) event.preventDefault();
  });
});

ipcMain.handle("app:get-info", (event) => {
  if (!isFromMainWindow(event)) {
    throw new Error("Rejected IPC from an untrusted sender.");
  }
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
  };
});

registerUpdateIpc(isFromMainWindow);
const providerAdapters = createAdapters();
const chatService = registerChatIpc(isFromMainWindow, () => mainWindow, providerAdapters);
registerAccountsIpc(isFromMainWindow, () => mainWindow, providerAdapters, () => chatService.invalidate());
registerTeamIpc(isFromMainWindow, () => mainWindow, providerAdapters);

if (!smoke) {
  app.on("window-all-closed", () => app.quit());
}

function createMainWindow(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  handlePreviewScheme();

  // No File/Edit/View menu bar on Windows and Linux. (macOS needs its system menu; see update/index.ts.)
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  const window = new BrowserWindow(mainWindowOptions(preloadFile, smoke !== null, iconFile));
  mainWindow = window;
  if (process.platform !== "darwin") {
    window.removeMenu();
    // The menu took the developer-tools shortcut with it, and it is still needed to see a problem.
    window.webContents.on("before-input-event", (event, input) => {
      if (isDevToolsShortcut(input)) {
        event.preventDefault();
        window.webContents.toggleDevTools();
      }
    });
  }

  if (smoke) {
    runSmoke({ window, outcome: smoke, rendererFile, isRendererUrl, isTrusted: isFromMainWindow });
    return;
  }

  window.once("ready-to-show", () => window.show());
  window.loadFile(rendererFile).catch(onStartupFailure);
  startUpdater(() => mainWindow);
}

app
  .whenReady()
  .then(createMainWindow)
  .catch(onStartupFailure);
