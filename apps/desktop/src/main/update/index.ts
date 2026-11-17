import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  app,
  dialog,
  ipcMain,
  Menu,
  session,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import { extractWithDitto, macBundlePath, startWindowsInstaller, swapMacBundle } from "./install";
import { parseUpdateConfig, platformKey } from "./manifest";
import { text, Updater, type UpdateSnapshot, type UpdaterUi } from "./updater";
import { CHECK_INTERVAL_MS } from "./version";

// Electron wiring for the updater: network, files, dialogs, menu, and timers. See docs/release.md.

const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function download(
  url: string,
  directory: string,
  onProgress?: (fraction: number | null) => void,
): Promise<{ filePath: string; sha512Hex: string }> {
  await fsp.rm(directory, { recursive: true, force: true });
  await fsp.mkdir(directory, { recursive: true });
  const name = path.basename(decodeURIComponent(new URL(url).pathname)).replace(/[^A-Za-z0-9._-]/g, "_");
  const filePath = path.join(directory, name);

  // Release downloads redirect to GitHub's file storage. What arrives is trusted only after its
  // signature has been verified.
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
  const hash = createHash("sha512");
  let received = 0;
  const total = Number(response.headers.get("content-length")) || 0;
  onProgress?.(total ? 0 : null);
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        received += chunk.length;
        if (received > MAX_UPDATE_BYTES) throw new Error("update file is larger than expected");
        hash.update(chunk);
        onProgress?.(total ? received / total : null);
        yield chunk;
      }
    },
    fs.createWriteStream(filePath),
  );
  return { filePath, sha512Hex: hash.digest("hex") };
}

// ---- The window's update dialog ------------------------------------------------------------
//
// The renderer subscribes over IPC (update:subscribe) and then shows version, notes, progress,
// errors, "Restart now", and "Later" in its own dialog (src/ui/UpdateDialog.jsx). Until it has
// subscribed (or if the page is reloading) the native dialogs below are used instead.
// Messages to the renderer: { enabled, snapshot, open?, prompt?, notice? }.

interface UpdateMessage {
  enabled: boolean;
  snapshot: UpdateSnapshot | null;
  open?: boolean;
  prompt?: boolean;
  notice?: { kind: "info" | "error"; message: string; detail: string };
}

class RendererBridge {
  subscribed = false;
  private answer: ((choice: "restart" | "later") => void) | null = null;
  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  private window(): BrowserWindow | null {
    const window = this.getWindow();
    return window && !window.isDestroyed() ? window : null;
  }

  get active(): boolean {
    return this.subscribed && this.window() !== null;
  }

  send(message: UpdateMessage): void {
    this.window()?.webContents.send("update:state", message);
  }

  progress(snapshot: UpdateSnapshot): void {
    const window = this.window();
    if (!window) return;
    if (snapshot.status === "downloading") window.setProgressBar(snapshot.progress ?? 2); // 2 = indeterminate
    else window.setProgressBar(-1);
  }

  ask(): Promise<"restart" | "later"> {
    this.answer?.("later");
    return new Promise((resolve) => {
      this.answer = resolve;
    });
  }

  respond(choice: "restart" | "later"): boolean {
    const answer = this.answer;
    this.answer = null;
    answer?.(choice);
    return answer !== null;
  }

  // The page went away (reload or close): an open question counts as "Later".
  reset(): void {
    this.subscribed = false;
    this.respond("later");
  }
}

// Saves project state and refuses while work is active. The page registers
// window.__orqestraPrepareUpdate (src/ui/App.jsx); it writes the projects to storage and returns
// { saved: true, blocked: null | "what must finish first" }. No answer means no install.
async function prepareInstall(getWindow: () => BrowserWindow | null): Promise<string | null> {
  const window = getWindow();
  if (window && !window.isDestroyed()) {
    const result = (await window.webContents.executeJavaScript(
      "typeof window.__orqestraPrepareUpdate === 'function' ? window.__orqestraPrepareUpdate() : null",
    )) as { saved?: boolean; blocked?: string | null } | null;
    if (!result || result.saved !== true) throw new Error("the window did not confirm that projects were saved");
    if (result.blocked) return result.blocked;
  }
  await session.defaultSession.flushStorageData();
  return null;
}

function createUi(getWindow: () => BrowserWindow | null, bridge?: RendererBridge): UpdaterUi {
  const show = (options: Electron.MessageBoxOptions) => {
    const window = getWindow();
    return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  };
  const native: UpdaterUi = {
    async promptReady({ version, currentVersion, notes }) {
      // "Later" is the default and the Escape choice, so a stray Enter never restarts the app.
      const { response } = await show({
        type: "info",
        title: "Update",
        message: `A new version is available: v${version}`,
        detail: `You are running v${currentVersion}. ${text.ready}${notes ? `\n\nWhat's new:\n${notes}` : ""}`,
        buttons: ["Restart now", "Later"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      return response === 0 ? "restart" : "later";
    },
    info(message) {
      void show({ type: "info", title: "Update", message, buttons: ["OK"] });
    },
    error(message, detail) {
      void show({ type: "warning", title: "Update", message, detail, buttons: ["Close"] });
    },
  };
  if (!bridge) return native;
  return {
    promptReady(update) {
      if (!bridge.active) return native.promptReady(update);
      const answer = bridge.ask();
      bridge.send({ enabled: true, snapshot: null, prompt: true, open: true });
      return answer;
    },
    info(message) {
      if (bridge.active) bridge.send({ enabled: true, snapshot: null, open: true, notice: { kind: "info", message, detail: "" } });
      else native.info(message);
    },
    error(message, detail) {
      if (bridge.active) bridge.send({ enabled: true, snapshot: null, open: true, notice: { kind: "error", message, detail } });
      else native.error(message, detail);
    },
  };
}

let active: { updater: Updater; bridge: RendererBridge } | null = null;

// Registers the update IPC channels. Called once from main.ts for every app start, so the page
// gets a clear "updates are off" answer in development as well.
export function registerUpdateIpc(isTrusted: (event: IpcMainInvokeEvent) => boolean): void {
  const guard = (event: IpcMainInvokeEvent) => {
    if (!isTrusted(event)) throw new Error("Rejected IPC from an untrusted sender.");
  };
  ipcMain.handle("update:subscribe", (event): UpdateMessage => {
    guard(event);
    if (!active) return { enabled: false, snapshot: null };
    active.bridge.subscribed = true;
    return { enabled: true, snapshot: active.updater.snapshot() };
  });
  ipcMain.handle("update:check", (event) => {
    guard(event);
    if (!active) return false;
    active.bridge.send({ enabled: true, snapshot: active.updater.snapshot(), open: true });
    void active.updater.check(false).catch((error: unknown) => console.error("Update check failed:", error));
    return true;
  });
  ipcMain.handle("update:respond", (event, choice: unknown) => {
    guard(event);
    if (!active) return false;
    return active.bridge.respond(choice === "restart" ? "restart" : "later");
  });
}

function installMenu(checkNow: () => void): void {
  const checkItem: MenuItemConstructorOptions = { label: "Check for Updates…", click: checkNow };
  const template: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              checkItem,
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ]
      : [{ role: "fileMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }, { label: "Help", submenu: [checkItem] }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Starts update checks for an installed app. Does nothing in development, in smoke mode (never
// called there), or when no update key has been built in.
export function startUpdater(getWindow: () => BrowserWindow | null): Updater | null {
  if (!app.isPackaged) return null;
  let config;
  try {
    config = parseUpdateConfig(fs.readFileSync(path.join(app.getAppPath(), "update-config.json"), "utf8"));
  } catch {
    config = null;
  }
  if (!config || config.publicKey === "") {
    console.warn("Updates are disabled: update-config.json has no public key.");
    return null;
  }

  const stateDir = path.join(app.getPath("userData"), "updates");
  const snoozeFile = path.join(app.getPath("userData"), "update-snooze.json");
  const bridge = new RendererBridge(getWindow);
  const updater = new Updater({
    currentVersion: app.getVersion(),
    config,
    platform: platformKey(process.platform, process.arch),
    fetchText,
    download: (url, onProgress) => download(url, stateDir, onProgress),
    discard: (filePath) => fsp.rm(filePath, { force: true }),
    beforeInstall: () => prepareInstall(getWindow),
    async install(filePath) {
      if (process.platform === "darwin") {
        await swapMacBundle(macBundlePath(process.execPath), filePath, extractWithDitto);
        app.relaunch();
      } else {
        startWindowsInstaller(filePath, process.execPath);
      }
      app.quit();
    },
    readSnooze() {
      try {
        return fs.readFileSync(snoozeFile, "utf8");
      } catch {
        return null;
      }
    },
    writeSnooze(raw) {
      try {
        fs.writeFileSync(snoozeFile, raw);
      } catch {
        // Not being able to remember "Later" only means asking again sooner.
      }
    },
    now: () => Date.now(),
    ui: createUi(getWindow, bridge),
    onState(snapshot) {
      bridge.progress(snapshot);
      bridge.send({ enabled: true, snapshot });
    },
  });
  active = { updater, bridge };
  // A reload or a new page has to subscribe again before the in-window dialog is used.
  app.on("browser-window-created", (_event, window) => {
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) bridge.reset();
    });
  });
  const current = getWindow();
  current?.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) bridge.reset();
  });

  const silentCheck = () => void updater.check(true).catch((error: unknown) => console.error("Update check failed:", error));
  installMenu(() => {
    bridge.send({ enabled: true, snapshot: updater.snapshot(), open: true });
    void updater.check(false).catch((error: unknown) => console.error("Update check failed:", error));
  });
  setTimeout(silentCheck, 2500);
  setInterval(silentCheck, CHECK_INTERVAL_MS).unref();
  app.on("browser-window-focus", () => void updater.checkOnFocus().catch(() => undefined));
  return updater;
}
