import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app, dialog, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { extractWithDitto, macBundlePath, startWindowsInstaller, swapMacBundle } from "./install";
import { parseUpdateConfig, platformKey } from "./manifest";
import { text, Updater, type UpdaterUi } from "./updater";
import { CHECK_INTERVAL_MS } from "./version";

// Electron wiring for the updater: network, files, dialogs, menu, and timers. See docs/release.md.

const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function download(url: string, directory: string): Promise<{ filePath: string; sha512Hex: string }> {
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
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        received += chunk.length;
        if (received > MAX_UPDATE_BYTES) throw new Error("update file is larger than expected");
        hash.update(chunk);
        yield chunk;
      }
    },
    fs.createWriteStream(filePath),
  );
  return { filePath, sha512Hex: hash.digest("hex") };
}

function createUi(getWindow: () => BrowserWindow | null): UpdaterUi {
  const show = (options: Electron.MessageBoxOptions) => {
    const window = getWindow();
    return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  };
  return {
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
  const updater = new Updater({
    currentVersion: app.getVersion(),
    config,
    platform: platformKey(process.platform, process.arch),
    fetchText,
    download: (url) => download(url, stateDir),
    discard: (filePath) => fsp.rm(filePath, { force: true }),
    async install(filePath) {
      if (process.platform === "darwin") {
        await swapMacBundle(macBundlePath(process.execPath), filePath, extractWithDitto);
        app.relaunch();
      } else {
        startWindowsInstaller(filePath);
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
    ui: createUi(getWindow),
  });

  const silentCheck = () => void updater.check(true).catch((error: unknown) => console.error("Update check failed:", error));
  installMenu(() => void updater.check(false).catch((error: unknown) => console.error("Update check failed:", error)));
  setTimeout(silentCheck, 2500);
  setInterval(silentCheck, CHECK_INTERVAL_MS).unref();
  app.on("browser-window-focus", () => void updater.checkOnFocus().catch(() => undefined));
  return updater;
}
