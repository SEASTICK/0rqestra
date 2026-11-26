import path from "node:path";
import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { projectWorkspace } from "../team/workspace";
import { AccessService } from "./access-service";
import { AccessStore } from "./access-store";
import { useAccess } from "./registry";

// Electron wiring for Project → Computer access. Requests come only from the app's window, and the
// window never sends a path: a folder is granted only after the user chose it in the system's folder
// picker (or, for a linked checkout, the path main already knows). Permissions live here in the
// main process and are enforced where files are read or written and commands run (access-service).

const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function registerAccessIpc(
  isTrusted: (event: IpcMainInvokeEvent) => boolean,
  getWindow: () => BrowserWindow | null,
  // Teams: the checkout linked to a local project, and teammates' reservations over paths.
  teams: { linkFor(localProjectId: string): { path: string } | null; reservedByOthers(localProjectId: string, paths: string[]): string | null },
): AccessService {
  const base = () => app.getPath("userData");
  const send = (channel: string, payload: unknown) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };
  const service = new AccessService(new AccessStore(base()), (projectId) => projectWorkspace(base(), projectId), (event) => send("access:event", event), (projectId, paths) => teams.reservedByOthers(projectId, paths), {
    ledgerDir: path.join(base(), "access", "changes"),
    checkoutFor: (projectId) => teams.linkFor(projectId)?.path ?? null,
    onChanges: (projectId) => send("access:event", { projectId, kind: "changes" }),
  });
  useAccess(service);
  const guard = (event: IpcMainInvokeEvent) => {
    if (!isTrusted(event)) throw new Error("Rejected IPC from an untrusted sender.");
  };
  const project = (raw: unknown) => {
    if (typeof raw !== "string" || !PROJECT_ID.test(raw)) throw new Error("Unknown project.");
    return raw;
  };
  const state = (projectId: string) => ({
    ...service.store.view(projectId),
    checkout: teams.linkFor(projectId)?.path ?? null,
    workspace: projectWorkspace(base(), projectId),
    pending: service.pendingFiles(projectId).map((f) => ({ path: f.path, agent: f.agentName, taskId: f.taskId, runId: f.runId })),
    pendingByRun: service.pendingByRun(projectId),
    recent: service.recent(projectId).slice(0, 30),
  });

  ipcMain.handle("access:view", (event, projectId: unknown) => {
    guard(event);
    return state(project(projectId));
  });
  // "Add folder": the system's folder picker. Granted read-only.
  ipcMain.handle("access:add-folder", async (event, projectId: unknown) => {
    guard(event);
    const id = project(projectId);
    const window = getWindow();
    const options = { title: "Choose a folder agents may read", properties: ["openDirectory" as const] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen) return state(id);
    service.store.addFolder(id, chosen);
    return state(id);
  });
  // Grants this computer's linked checkout of a shared project (a path main already has).
  ipcMain.handle("access:add-checkout", (event, projectId: unknown) => {
    guard(event);
    const id = project(projectId);
    const link = teams.linkFor(id);
    if (!link) throw new Error("This project has no linked checkout on this computer.");
    service.store.addFolder(id, link.path);
    return state(id);
  });
  ipcMain.handle("access:open-project-folder", async (event, projectId: unknown) => {
    guard(event);
    const id = project(projectId);
    const target = teams.linkFor(id)?.path ?? projectWorkspace(base(), id);
    return (await shell.openPath(path.resolve(target))) === "";
  });
  ipcMain.handle("access:set-folder-write", (event, projectId: unknown, folderId: unknown, write: unknown) => {
    guard(event);
    const id = project(projectId);
    service.store.setFolderWrite(id, folderId, write);
    return state(id);
  });
  ipcMain.handle("access:revoke-folder", (event, projectId: unknown, folderId: unknown) => {
    guard(event);
    const id = project(projectId);
    service.store.revokeFolder(id, folderId);
    return state(id);
  });
  ipcMain.handle("access:set-agent", (event, projectId: unknown, agentKey: unknown, access: unknown) => {
    guard(event);
    const id = project(projectId);
    service.store.setAgent(id, agentKey, access);
    return state(id);
  });
  ipcMain.handle("access:revoke-agents", (event, projectId: unknown) => {
    guard(event);
    const id = project(projectId);
    service.store.revokeAgents(id);
    return state(id);
  });
  ipcMain.handle("access:add-command", (event, projectId: unknown, command: unknown) => {
    guard(event);
    const id = project(projectId);
    service.store.addCommand(id, command);
    return state(id);
  });
  ipcMain.handle("access:remove-command", (event, projectId: unknown, commandId: unknown) => {
    guard(event);
    const id = project(projectId);
    service.store.removeCommand(id, commandId);
    return state(id);
  });
  ipcMain.handle("access:preview-apply", (event, projectId: unknown, folderId: unknown) => {
    guard(event);
    return service.previewApply(project(projectId), folderId);
  });
  ipcMain.handle("access:apply", (event, projectId: unknown, previewId: unknown, paths: unknown) => {
    guard(event);
    const id = project(projectId);
    return { result: service.apply(id, previewId, paths), view: state(id) };
  });
  // One run's changes, from its card in Manager chat (scoped to that run in the main process).
  ipcMain.handle("access:pending-by-run", (event, projectId: unknown) => {
    guard(event);
    return service.pendingByRun(project(projectId));
  });
  ipcMain.handle("access:review-run", (event, projectId: unknown, runId: unknown, folderId: unknown) => {
    guard(event);
    return service.reviewRun(project(projectId), runId, typeof folderId === "string" && folderId ? folderId : undefined);
  });
  ipcMain.handle("access:apply-run", async (event, projectId: unknown, runId: unknown, previewId: unknown, paths: unknown) => {
    guard(event);
    return service.applyRun(project(projectId), runId, previewId, paths);
  });
  ipcMain.handle("access:forget-project", (event, projectId: unknown) => {
    guard(event);
    service.forgetProject(project(projectId));
    return true;
  });
  return service;
}
