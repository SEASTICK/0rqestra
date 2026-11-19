import fs from "node:fs";
import path from "node:path";
import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { ProviderAdapter, ProviderId } from "../providers/types";
import type { Plan } from "./plan";
import type { TeamEvent } from "./runner";
import { TeamService } from "./team-service";

export type StartGate =
  | { kind: "solo" }
  | { kind: "granted"; guard: { authorize(paths: string[]): Promise<void>; release(): Promise<void> } }
  | { kind: "conflict" | "unavailable" | "no_scope"; message: string };
import { projectWorkspace } from "./workspace";
import { findProducts } from "../preview/products";
import { rememberPreviewHost } from "../preview/preview-protocol";

// Electron wiring for team runs: start, stop, and open the project's folder. Requests are accepted
// only from the app's own window.

export function registerTeamIpc(
  isTrusted: (event: IpcMainInvokeEvent) => boolean,
  getWindow: () => BrowserWindow | null,
  adapters: Record<ProviderId, ProviderAdapter>,
  observe?: (info: { runId: string; localProjectId: string; plan: Plan }, event: TeamEvent) => void,
  // Teams phase 5: a coordinated start reserves the run's paths first (solo projects pass).
  gate?: (info: { runId: string; localProjectId: string; plan: Plan }) => Promise<StartGate>,
  // Teams: what teammates are doing in a project right now, for the Planner.
  teamNow?: (projectId: string) => string | null,
): void {
  const base = () => app.getPath("userData");
  const cwd = () => {
    const dir = path.join(base(), "chat-workspace");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const service = new TeamService(adapters, (projectId) => projectWorkspace(base(), projectId), cwd, observe, teamNow);
  const guard = (event: IpcMainInvokeEvent) => {
    if (!isTrusted(event)) throw new Error("Rejected IPC from an untrusted sender.");
  };
  // Returns { ok: true, runId } or { ok: false, reason, message } when coordination refuses or is
  // unavailable; in that case nothing has started.
  ipcMain.handle("team:start", async (event, payload: unknown) => {
    guard(event);
    const sender = event.sender;
    const prepared = service.prepare(payload);
    const decision = gate ? await gate({ runId: prepared.runId, localProjectId: prepared.projectId, plan: prepared.plan }) : { kind: "solo" as const };
    if (decision.kind !== "solo" && decision.kind !== "granted") return { ok: false, reason: decision.kind, message: decision.message };
    try {
      const runId = service.launch(prepared, (id, teamEvent) => {
        const window = getWindow();
        if (window && !window.isDestroyed() && window.webContents === sender && !sender.isDestroyed()) sender.send("team:event", { runId: id, event: teamEvent });
      }, decision.kind === "granted" ? decision.guard : undefined);
      return { ok: true, runId };
    } catch (error) {
      if (decision.kind === "granted") await decision.guard.release();
      throw error;
    }
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
  // The products in the project's folder, and the preview host that serves them.
  ipcMain.handle("team:products", (event, projectId: unknown) => {
    guard(event);
    if (typeof projectId !== "string") throw new Error("Invalid project id.");
    const workspace = projectWorkspace(base(), projectId);
    return { host: rememberPreviewHost(projectId, workspace), products: findProducts(workspace) };
  });
  ipcMain.handle("team:open-folder", async (event, projectId: unknown) => {
    guard(event);
    if (typeof projectId !== "string") return false;
    const error = await shell.openPath(projectWorkspace(base(), projectId));
    return error === "";
  });
  app.on("before-quit", () => service.stopAll());
}
