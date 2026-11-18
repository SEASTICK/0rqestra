import fs from "node:fs";
import path from "node:path";
import { app, clipboard, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { killTree, providerEnv } from "../providers/process";
import { toolEnvironment } from "../providers/tool-env";
import type { ProviderAdapter, ProviderId } from "../providers/types";
import { AccountsService, parseKind, parseProvider } from "./accounts-service";
import { installScript } from "./commands";
import { openTerminalWindow, startInstallerProcess } from "./terminal";

// Electron wiring for AI accounts. Every request is accepted only from the app's own window, and
// carries at most a provider id and a command kind, both checked against fixed lists. The window
// never chooses a program, a path, an argument, or text that is run.

export function registerAccountsIpc(
  isTrusted: (event: IpcMainInvokeEvent) => boolean,
  getWindow: () => BrowserWindow | null,
  adapters: Record<ProviderId, ProviderAdapter>,
  invalidate: () => void,
): AccountsService {
  // Installers and sign-in get the same cleaned environment as the tools: no API keys.
  const env = () => providerEnv(toolEnvironment.env());
  const service = new AccountsService({
    adapters,
    refreshPath: () => toolEnvironment.refresh(),
    invalidate,
    startInstaller: (provider) => startInstallerProcess(installScript(provider, process.platform), env()),
    openTerminal: process.platform === "win32" || process.platform === "darwin" ? (request) => openTerminalWindow(request, env()) : null,
    cwd: () => {
      const dir = path.join(app.getPath("userData"), "chat-workspace");
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    emit: (accounts) => {
      const window = getWindow();
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("accounts:event", { accounts });
    },
    killTree,
  });
  const guard = (event: IpcMainInvokeEvent) => {
    if (!isTrusted(event)) throw new Error("Rejected IPC from an untrusted sender.");
  };
  ipcMain.handle("accounts:status", async (event, refresh: unknown) => {
    guard(event);
    return refresh === false ? service.view() : service.refresh();
  });
  ipcMain.handle("accounts:install", (event, provider: unknown) => {
    guard(event);
    return service.install(provider);
  });
  ipcMain.handle("accounts:sign-in", (event, provider: unknown) => {
    guard(event);
    return service.signIn(provider);
  });
  ipcMain.handle("accounts:open-terminal", (event, provider: unknown, kind: unknown) => {
    guard(event);
    return service.openTerminal(provider, kind);
  });
  ipcMain.handle("accounts:cancel", (event, provider: unknown) => {
    guard(event);
    return service.cancel(provider);
  });
  ipcMain.handle("accounts:test", (event, provider: unknown) => {
    guard(event);
    return service.test(provider);
  });
  // Copies an official command for the user to paste into a terminal themselves.
  ipcMain.handle("accounts:copy", (event, provider: unknown, kind: unknown) => {
    guard(event);
    const id = parseProvider(provider);
    const which = parseKind(kind);
    const view = service.view().find((a) => a.provider === id)!;
    clipboard.writeText(which === "install" ? view.commands.install : view.commands.signIn);
    return true;
  });
  app.on("before-quit", () => service.stopAll());
  return service;
}
