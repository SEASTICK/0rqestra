import fs from "node:fs";
import path from "node:path";
import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { ProviderAdapter, ProviderId } from "../providers/types";
import { TeamService } from "./team-service";
import { projectWorkspace } from "./workspace";

// Electron wiring for team runs: start, stop, and open the project's folder. Requests are accepted
// only from the app's own window.

export function registerTeamIpc(isTrusted: (event: IpcMainInvokeEvent) => boolean, getWindow: () => BrowserWindow | null, adapters: Record<ProviderId, ProviderAdapter>): void {
  const base = () => app.getPath("userData");
  const cwd = () => {
    const dir = path.join(base(), "chat-workspace");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const service = new TeamService(adapters, (projectId) => projectWorkspace(base(), projectId), cwd);
  const guard = (event: IpcMainInvokeEvent) => {
    if (!isTrusted(event)) throw new Error("Rejected IPC from an untrusted sender.");
  };
  ipcMain.handle("team:start", (event, payload: unknown) => {
    guard(event);
    const sender = event.sender;
    return service.start(payload, (runId, teamEvent) => {
      const window = getWindow();
      if (window && !window.isDestroyed() && window.webContents === sender && !sender.isDestroyed()) sender.send("team:event", { runId, event: teamEvent });
    });
  });
  ipcMain.handle("team:plan", (event, payload: unknown) => {
    guard(event);
    return service.plan(payload);
  });
  ipcMain.handle("team:plan-stop", (event, requestId: unknown) => {
    guard(event);
    return service.stopPlan(requestId);
  });
  ipcMain.handle("team:stop", (event, runId: unknown) => {
    guard(event);
    return service.stop(runId);
  });
  ipcMain.handle("team:open-folder", async (event, projectId: unknown) => {
    guard(event);
    if (typeof projectId !== "string") return false;
    const error = await shell.openPath(projectWorkspace(base(), projectId));
    return error === "";
  });
  app.on("before-quit", () => service.stopAll());
}
