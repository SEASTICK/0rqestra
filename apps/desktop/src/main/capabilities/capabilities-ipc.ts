import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { projectWorkspace } from "../team/workspace";
import { useSkillStore } from "./registry";
import { AGENT_KEY, SKILL_ID, SkillStore } from "./skill-store";

// Electron wiring for an agent's Capabilities tab. Requests come only from the app's window. A file
// or folder is read only after the user chose it in the system dialog, or as the text of a file the
// user dropped on the window; the window never sends a path. Nothing here runs anything: the setup
// terminal is a terminal the user types in.

const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function registerCapabilitiesIpc(isTrusted: (event: IpcMainInvokeEvent) => boolean, getWindow: () => BrowserWindow | null): SkillStore {
  const store = new SkillStore(path.join(app.getPath("userData"), "capabilities"));
  useSkillStore(store);
  const guard = (event: IpcMainInvokeEvent) => {
    if (!isTrusted(event)) throw new Error("Rejected IPC from an untrusted sender.");
  };
  const key = (raw: unknown) => {
    if (typeof raw !== "string" || !AGENT_KEY.test(raw)) throw new Error("Unknown agent.");
    return raw;
  };

  // The skills on this computer, and the ones installed on one agent.
  ipcMain.handle("capabilities:skills", (event, agentKey: unknown) => {
    guard(event);
    return { skills: store.list(), installed: typeof agentKey === "string" && AGENT_KEY.test(agentKey) ? store.installedOn(agentKey) : [] };
  });
  // Choose a SKILL.md file or a skill folder in the system dialog; returns a preview (nothing saved yet).
  ipcMain.handle("capabilities:choose-skill", async (event, kind: unknown) => {
    guard(event);
    const folder = kind === "folder";
    const window = getWindow();
    const options = folder
      ? { title: "Choose a skill folder (with a SKILL.md)", properties: ["openDirectory" as const] }
      : { title: "Choose a SKILL.md file", properties: ["openFile" as const], filters: [{ name: "Skill", extensions: ["md"] }] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen) return null;
    return store.stagePath(chosen);
  });
  // A SKILL.md dropped on the window, as text.
  ipcMain.handle("capabilities:preview-text", (event, fileName: unknown, text: unknown) => {
    guard(event);
    return store.stageText(typeof fileName === "string" ? fileName : "SKILL.md", typeof text === "string" ? text : "");
  });
  // Saves the previewed skill's copy and installs it on this agent.
  ipcMain.handle("capabilities:install", (event, selectionId: unknown, agentKey: unknown, agentName: unknown) => {
    guard(event);
    const k = key(agentKey);
    const record = store.install(selectionId);
    return { record, installed: store.assign(k, record.id, agentName) };
  });
  ipcMain.handle("capabilities:assign", (event, skillId: unknown, agentKey: unknown, agentName: unknown) => {
    guard(event);
    return store.assign(key(agentKey), skillId, agentName);
  });
  ipcMain.handle("capabilities:unassign", (event, skillId: unknown, agentKey: unknown) => {
    guard(event);
    if (typeof skillId !== "string" || !SKILL_ID.test(skillId)) throw new Error("Unknown skill.");
    return store.unassign(key(agentKey), skillId);
  });
  // Advanced: a terminal in the project's folder, for a provider's own install commands. The user
  // types every command; nothing is run for them.
  ipcMain.handle("capabilities:open-terminal", (event, projectId: unknown, label: unknown) => {
    guard(event);
    if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) throw new Error("Unknown project.");
    const dir = projectWorkspace(app.getPath("userData"), projectId);
    fs.mkdirSync(dir, { recursive: true });
    const title = String(label ?? "0rqestra setup").replace(/[^A-Za-z0-9 ·:()_.-]/g, "").slice(0, 80) || "0rqestra setup";
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", `"${title}"`, "cmd.exe", "/k", `title ${title}`], { cwd: dir, detached: true, stdio: "ignore", windowsVerbatimArguments: false }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", ["-a", "Terminal", dir], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("x-terminal-emulator", [], { cwd: dir, detached: true, stdio: "ignore" }).on("error", () => {}).unref();
    }
    return { folder: dir };
  });
  return store;
}
