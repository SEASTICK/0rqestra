import fs from "node:fs";
import path from "node:path";
import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { projectWorkspace } from "../team/workspace";
import { AccessService } from "./access-service";
import { AccessStore } from "./access-store";
import { gitRunner } from "./git";
import { suggestedChecks } from "./folder-info";
import { ghEnv, GithubClient, REPO_NAME } from "../github/github";
import { openTerminalWindow } from "../accounts/terminal";
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
  const service = new AccessService(new AccessStore(base()), (projectId) => projectWorkspace(base(), projectId), (event) => send("access:event", event), (projectId, paths) => teams.reservedByOthers(projectId, paths), gitRunner(path.join(base(), "git-no-hooks")), path.join(base(), "access-pending.json"));
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
    pending: service.pendingFiles(projectId).map((f) => ({ path: f.path, agent: f.agentName, taskId: f.taskId })),
    recent: service.recent(projectId).slice(0, 30),
  });

  // A folder the user chose (or just cloned): granted with changes allowed (each one is still reviewed before it is
  // applied), with the checks its own setup offers and its git state.
  const setupAt = async (id: string, chosen: string) => {
    const view = service.store.addFolder(id, chosen);
    const real = fs.realpathSync.native(chosen);
    const folder = view.folders.find((f) => f.path.toLowerCase() === real.toLowerCase());
    if (!folder) throw new Error("The folder could not be added.");
    service.store.setFolderWrite(id, folder.id, true);
    return { folderId: folder.id, folder: folder.path, checks: suggestedChecks(folder.path), git: await service.gitState(id, folder.id), view: state(id) };
  };

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
  // "Work in a folder": the folder picker, then the folder is granted with changes allowed (each change is
  // still reviewed before it is applied). Returns the checks the folder's own setup offers, for the user
  // to approve or not; nothing runs until they do.
  ipcMain.handle("access:setup-folder", async (event, projectId: unknown) => {
    guard(event);
    const id = project(projectId);
    const window = getWindow();
    const options = { title: "Choose the folder of the app to work on", properties: ["openDirectory" as const] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen) return null;
    return setupAt(id, chosen);
  });
  // GitHub: the user's repositories through the official `gh` (github/github.ts), and one cloned into a
  // folder chosen in the system's picker, then set up like any folder. Nothing here sees a password or token.
  const github = new GithubClient();
  ipcMain.handle("github:status", async (event) => {
    guard(event);
    return github.status();
  });
  ipcMain.handle("github:repos", async (event, refresh: unknown) => {
    guard(event);
    return github.repos(refresh === true);
  });
  // Opens a terminal with a fixed official command: installing gh, or signing in to it. The window only names which.
  ipcMain.handle("github:open-terminal", (event, kind: unknown) => {
    guard(event);
    if (kind !== "install" && kind !== "signIn") throw new Error("Unknown command.");
    github.forget();
    if (process.platform !== "win32" && process.platform !== "darwin") return false;
    const command = kind === "install" ? (process.platform === "win32" ? "winget install --id GitHub.cli" : "brew install gh") : "gh auth login --web --git-protocol https";
    return openTerminalWindow(kind === "install"
      ? { title: "0rqestra: install GitHub CLI", intro: ["This window installs GitHub's official command line tool, gh:"], command, confirm: true }
      : { title: "0rqestra: sign in to GitHub", intro: ["This window runs gh's own sign-in. 0rqestra never sees your password or token.", "Choose GitHub.com, HTTPS, and Login with a web browser. Say yes to authenticating git."], command, confirm: false }, ghEnv());
  });
  ipcMain.handle("github:clone", async (event, projectId: unknown, fullName: unknown) => {
    guard(event);
    const id = project(projectId);
    if (typeof fullName !== "string" || !REPO_NAME.test(fullName)) throw new Error("Choose a repository from the list.");
    const window = getWindow();
    const options = { title: `Choose where to put ${fullName.split("/")[1]}`, defaultPath: app.getPath("documents"), properties: ["openDirectory" as const, "createDirectory" as const] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const parent = result.filePaths[0];
    if (result.canceled || !parent) return null;
    const cloned = await github.clone(fullName, parent);
    return { ...(await setupAt(id, cloned.path)), repo: fullName, reused: cloned.reused };
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
  // Commit and push what the user applied: only from these buttons, in a folder that accepts changes.
  ipcMain.handle("access:git-state", (event, projectId: unknown, folderId: unknown) => {
    guard(event);
    return service.gitState(project(projectId), folderId);
  });
  ipcMain.handle("access:commit", async (event, projectId: unknown, folderId: unknown, paths: unknown, message: unknown) => {
    guard(event);
    const id = project(projectId);
    const result = await service.commit(id, folderId, paths, message);
    return { result, git: await service.gitState(id, folderId), view: state(id) };
  });
  ipcMain.handle("access:push", async (event, projectId: unknown, folderId: unknown) => {
    guard(event);
    const id = project(projectId);
    const result = await service.push(id, folderId);
    return { result, git: await service.gitState(id, folderId), view: state(id) };
  });
  ipcMain.handle("access:forget-project", (event, projectId: unknown) => {
    guard(event);
    service.forgetProject(project(projectId));
    return true;
  });
  return service;
}
