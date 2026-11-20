import crypto from "node:crypto";
import path from "node:path";
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { findProducts } from "../preview/products";
import { rememberAppHost } from "../preview/preview-protocol";
import { projectWorkspace } from "../team/workspace";
import { createDockerCli } from "./docker-cli";
import { Sandbox, type AppStatus } from "./sandbox";

// Electron wiring for running the apps the team built (sandbox.ts). The window names a project and a
// product; the main process finds the product in the project's folder and decides everything else.

const ID = /^[A-Za-z0-9_-]{1,100}$/;

export function registerSandboxIpc(isTrusted: (event: IpcMainInvokeEvent) => boolean, getWindow: () => BrowserWindow | null): Sandbox {
  const base = () => app.getPath("userData");
  const sandbox = new Sandbox({
    docker: createDockerCli(),
    dirFor: (projectId, productId) => path.join(base(), "sandbox", projectId, crypto.createHash("sha256").update(productId).digest("hex").slice(0, 16)),
    emit: (projectId, productId, status) => {
      const host = rememberAppHost(projectId, productId, status.state === "running" ? status.port : null);
      const window = getWindow();
      if (window && !window.isDestroyed()) window.webContents.send("team:app-event", { projectId, productId, host, status: publicStatus(status) });
    },
  });
  const guard = (event: IpcMainInvokeEvent) => {
    if (!isTrusted(event)) throw new Error("Rejected IPC from an untrusted sender.");
  };
  const target = (raw: unknown) => {
    const v = (raw ?? {}) as Record<string, unknown>;
    if (typeof v.projectId !== "string" || !ID.test(v.projectId)) throw new Error("Invalid project id.");
    const workspace = projectWorkspace(base(), v.projectId);
    const product = findProducts(workspace).find((p) => p.id === v.productId && p.kind === "app");
    if (!product) throw new Error("This app is no longer in the project folder.");
    return { projectId: v.projectId, product, workspace };
  };
  ipcMain.handle("team:app-docker", (event) => {
    guard(event);
    return sandbox.dockerState();
  });
  ipcMain.handle("team:app-status", (event, projectId: unknown) => {
    guard(event);
    if (typeof projectId !== "string" || !ID.test(projectId)) throw new Error("Invalid project id.");
    const out: Record<string, { host: string; status: ReturnType<typeof publicStatus> }> = {};
    for (const [productId, status] of Object.entries(sandbox.status(projectId))) {
      out[productId] = { host: rememberAppHost(projectId, productId, status.state === "running" ? status.port : null), status: publicStatus(status) };
    }
    return out;
  });
  ipcMain.handle("team:app-start", (event, raw: unknown) => {
    guard(event);
    const { projectId, product, workspace } = target(raw);
    void sandbox.start(projectId, product, workspace);
    return { host: rememberAppHost(projectId, product.id, null) };
  });
  ipcMain.handle("team:app-sync", (event, raw: unknown) => {
    guard(event);
    const { projectId, product, workspace } = target(raw);
    return sandbox.sync(projectId, product, workspace);
  });
  ipcMain.handle("team:app-stop", async (event, raw: unknown) => {
    guard(event);
    const v = (raw ?? {}) as Record<string, unknown>;
    if (typeof v.projectId !== "string" || !ID.test(v.projectId) || typeof v.productId !== "string" || v.productId.length > 200) throw new Error("Invalid app.");
    await sandbox.stop(v.projectId, v.productId);
    return true;
  });
  // Leftovers from a crash are removed at start, and nothing keeps running after the app quits.
  void sandbox.cleanup();
  // Quitting is not held up (an update restarts the app this way): the containers are removed at once,
  // within a few seconds at most, and only when an app was started.
  app.on("will-quit", () => sandbox.stopAllNow());
  return sandbox;
}

// The window does not need the port: it reaches the app through its preview host.
function publicStatus(status: AppStatus) {
  return { state: status.state, message: status.message, startedAt: status.startedAt, log: status.log.slice(-120) };
}
