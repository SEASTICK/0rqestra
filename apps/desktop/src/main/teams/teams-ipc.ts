import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, clipboard, dialog, ipcMain, net, powerMonitor, safeStorage, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { toolEnvironment } from "../providers/tool-env";
import type { Plan } from "../team/plan";
import type { TeamEvent } from "../team/runner";
import { ActivityMonitor } from "./activity";
import { BriefPublisher, fileOutbox } from "./briefs";
import { ReservationCoordinator, type Gate } from "./reservations";
import { gitRunner } from "./git-checkout";
import { PresenceHub, type PresenceTarget, type SocketLike } from "./presence";
import { LinkStore, SessionStore } from "./local-store";
import type { FetchLike } from "./supabase-api";
import { loadTeamsConfig } from "./teams-config";
import { TeamsService } from "./teams-service";

// Electron wiring for Teams. Every request is accepted only from the app's own window. The window
// never sends a folder path: folders are chosen in the system dialog opened here, and the window
// refers to the result by an id. Tokens stay in this process; the session is encrypted with the
// operating system's key store (safeStorage) before it is written to disk.

const readFile = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

export interface TeamsWiring {
  service: TeamsService;
  // Team run events from main/team, for work briefs (phase 3) and releasing reservations (phase 5).
  onRunEvent: (info: { runId: string; localProjectId: string; plan: Plan }, event: TeamEvent) => Promise<void>;
  // Before a team run starts: reserve its paths in a linked project (phase 5).
  beforeStart: (info: { runId: string; localProjectId: string; plan: Plan }) => Promise<Gate>;
}

export function registerTeamsIpc(isTrusted: (event: IpcMainInvokeEvent) => boolean, getWindow: () => BrowserWindow | null): TeamsWiring {
  const dir = () => path.join(app.getPath("userData"), "teams");
  const config = () =>
    loadTeamsConfig({
      env: process.env,
      readFile,
      userFile: path.join(app.getPath("userData"), "teams-config.json"),
      bundledFile: path.join(app.getAppPath(), "teams-config.json"),
    });
  const fetchImpl: FetchLike = async (url, init) => {
    const response = await net.fetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), ...(init.signal ? { signal: init.signal } : {}) });
    return { ok: response.ok, status: response.status, text: () => response.text() };
  };
  // Presence (phase 2): one Realtime connection for this app session, created when Teams is
  // configured and there is something to watch.
  let hub: PresenceHub | null = null;
  const sessionKey = crypto.randomUUID();
  const ensureHub = (): PresenceHub | null => {
    if (hub) return hub;
    const c = config();
    if (!c.ok) return null;
    const url = `${c.config.url.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(c.config.publishableKey)}&vsn=1.0.0`;
    hub = new PresenceHub({
      url,
      sessionKey,
      createSocket: (u) => new WebSocket(u) as unknown as SocketLike,
      getToken: () => service.accessToken(),
      onChange: (snapshot) => {
        service.setPresence(snapshot);
        // Connected again: send any brief that is still waiting.
        if (Object.values(snapshot).some((p) => p.connection === "live")) void publisher.flush();
      },
      onBriefs: (projectId) => void service.refreshBriefs(projectId),
    });
    hub.setActive(activity.isActive());
    return hub;
  };
  const activity = new ActivityMonitor({ idleSeconds: () => powerMonitor.getSystemIdleTime(), onChange: (active) => hub?.setActive(active) });
  const publisher: BriefPublisher = new BriefPublisher({
    ...fileOutbox(path.join(dir(), "briefs.json")),
    linkFor: (localProjectId) => service.linkFor(localProjectId),
    branchOf: (folder) => service.branchOf(folder),
    send: (state) => service.publishBrief(state),
    currentUserId: () => service.currentUserId(),
    onChange: () => service.notifyLocalBriefs(),
  });
  const coordinator = new ReservationCoordinator({
    rpc: (fn, args) => service.reservationRpc(fn, args),
    linkFor: (localProjectId) => service.linkFor(localProjectId),
    branchOf: (folder) => service.branchOf(folder),
    onChange: () => void service.refreshBriefs(),
  });
  const service = new TeamsService({
    localBriefs: (projectId) => publisher.forProject(projectId).map((b) => ({ runId: b.runId, title: b.title, status: b.status, outcome: b.outcome, updatedAt: b.updatedAt, sync: b.sync, error: b.error })),
    onPresenceTargets: (targets: PresenceTarget[]) => {
      if (targets.length === 0) hub?.setTargets([]);
      else ensureHub()?.setTargets(targets);
    },
    config,
    fetch: fetchImpl,
    sessions: new SessionStore(path.join(dir(), "session.bin"), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (data) => safeStorage.decryptString(data),
    }),
    links: new LinkStore(path.join(dir(), "links.json")),
    git: gitRunner(() => toolEnvironment.env()),
    caseInsensitivePaths: process.platform === "win32" || process.platform === "darwin",
    emit: (view) => {
      const window = getWindow();
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("teams:event", { view });
    },
  });
  const guard = (event: IpcMainInvokeEvent) => {
    if (!isTrusted(event)) throw new Error("Rejected IPC from an untrusted sender.");
  };
  ipcMain.handle("teams:status", async (event, refresh: unknown) => {
    guard(event);
    return refresh === true ? service.refresh() : service.view();
  });
  ipcMain.handle("teams:send-code", (event, email: unknown) => {
    guard(event);
    return service.sendCode(email);
  });
  ipcMain.handle("teams:verify-code", (event, code: unknown) => {
    guard(event);
    return service.verifyCode(code);
  });
  ipcMain.handle("teams:cancel-code", (event) => {
    guard(event);
    return service.cancelCode();
  });
  ipcMain.handle("teams:sign-out", (event) => {
    guard(event);
    return service.signOut();
  });
  ipcMain.handle("teams:create-team", (event, name: unknown) => {
    guard(event);
    return service.createTeam(name);
  });
  ipcMain.handle("teams:create-invite", (event, teamId: unknown, email: unknown) => {
    guard(event);
    return service.createInvite(teamId, email);
  });
  ipcMain.handle("teams:copy-invite", (event, inviteId: unknown) => {
    guard(event);
    clipboard.writeText(service.inviteText(inviteId));
    return true;
  });
  ipcMain.handle("teams:revoke-invite", (event, inviteId: unknown) => {
    guard(event);
    return service.revokeInvite(inviteId);
  });
  ipcMain.handle("teams:accept-invite", (event, code: unknown) => {
    guard(event);
    return service.acceptInvite(code);
  });
  // Opens the system folder dialog. Returns null when the user cancels.
  ipcMain.handle("teams:choose-checkout", async (event) => {
    guard(event);
    const window = getWindow();
    const options = { title: "Choose your checkout of the repository", properties: ["openDirectory" as const] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const folder = result.filePaths[0];
    if (result.canceled || result.filePaths.length !== 1 || !folder) return null;
    return service.inspectFolder(folder);
  });
  // Re-describes an already chosen folder with a specific remote (when its remotes disagree).
  ipcMain.handle("teams:choose-remote", (event, selectionId: unknown, remote: unknown) => {
    guard(event);
    return service.describeSelection(selectionId, remote);
  });
  ipcMain.handle("teams:register-project", (event, payload: unknown) => {
    guard(event);
    return service.registerProject(payload);
  });
  ipcMain.handle("teams:link-checkout", (event, payload: unknown) => {
    guard(event);
    return service.linkCheckout(payload);
  });
  ipcMain.handle("teams:unlink", (event, sharedProjectId: unknown) => {
    guard(event);
    return service.unlink(sharedProjectId);
  });
  // Phase 4: catch-up, read tracking, and one teammate's current work. All read-only except the
  // read state, which only ever records what this account was shown.
  ipcMain.handle("teams:catch-up", (event, projectId: unknown) => {
    guard(event);
    return service.catchUp(projectId);
  });
  ipcMain.handle("teams:mark-seen", (event, projectId: unknown, items: unknown) => {
    guard(event);
    return service.markSeen(projectId, items);
  });
  ipcMain.handle("teams:teammate-work", (event, projectId: unknown, userId: unknown) => {
    guard(event);
    return service.teammateWork(projectId, userId);
  });
  ipcMain.handle("teams:open-checkout", async (event, sharedProjectId: unknown) => {
    guard(event);
    const folder = service.linkedFolder(sharedProjectId);
    if (!folder) return false;
    return (await shell.openPath(folder)) === "";
  });
  void app.whenReady().then(() => {
    activity.start();
    const wake = () => {
      activity.check();
      hub?.nudge();
    };
    powerMonitor.on("resume", wake);
    powerMonitor.on("unlock-screen", wake);
  });
  // Keep the Realtime channels authorized as the session token is renewed.
  const tokenTimer = setInterval(() => void hub?.refreshToken(), 4 * 60_000);
  // A safety net for briefs: re-read them once a minute, in case a change broadcast was missed.
  const briefsTimer = setInterval(() => {
    if (service.currentUserId()) void service.refreshBriefs();
  }, 60_000);
  app.on("before-quit", () => {
    clearInterval(tokenTimer);
    clearInterval(briefsTimer);
    activity.stop();
    // Closing the connection tells teammates right away that this session is gone.
    hub?.stop();
    // Release what this app holds; anything not released in time expires by itself.
    void coordinator.releaseAll();
  });
  return {
    service,
    beforeStart: (info) => coordinator.beforeStart(info),
    onRunEvent: async (info, event) => {
      // The runner has stopped writing when it reports the run finished: release after that.
      if (event.type === "run-finished") void coordinator.onRunFinished(info.runId);
      await publisher.onRunEvent(info, event);
    },
  };
}
