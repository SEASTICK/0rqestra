import fs from "node:fs";
import path from "node:path";
import { app, clipboard, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { ChatService } from "./chat-service";
import { AttachmentStore, LIMITS } from "./attachments";
import { inside, listFiles, projectWorkspace } from "./team/workspace";
import { ClaudeCodeAdapter } from "./providers/claude-code";
import { CodexAdapter } from "./providers/codex";
import { toolEnvironment } from "./providers/tool-env";
import { LimitsStore, recordLimits } from "./providers/limits-store";

// The usage windows the tools last reported (shown in the sidebar).
export const limitsStore = new LimitsStore();

// Electron wiring for the chat: three request channels from the window and one event channel
// back to it. Each request is accepted only from the app's own window (isTrusted).

let service: ChatService | null = null;

export function createAdapters(): { claude: ClaudeCodeAdapter; codex: CodexAdapter } {
  return {
    claude: recordLimits(new ClaudeCodeAdapter({ settingsDir: path.join(app.getPath("userData"), "provider-settings") }), limitsStore),
    codex: recordLimits(new CodexAdapter(), limitsStore),
  };
}

export function registerChatIpc(isTrusted: (event: IpcMainInvokeEvent) => boolean, getWindow: () => BrowserWindow | null, adapters = createAdapters(), teamNow: (projectId: string) => string | null = () => null): ChatService {
  // An empty folder that is the working directory of every chat. The tools get no tools in a
  // chat, but if one ever looked around, there is nothing here to find.
  const cwd = () => {
    const dir = path.join(app.getPath("userData"), "chat-workspace");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const store = new AttachmentStore(path.join(app.getPath("userData"), "attachments"));
  store.prune();
  service = new ChatService(adapters, cwd, Date.now, teamNow, (id) => store.get(id));
  const guard = (event: IpcMainInvokeEvent) => {
    if (!isTrusted(event)) throw new Error("Rejected IPC from an untrusted sender.");
  };
  // The PATH is read from the registry at start and on every forced check (providers/tool-env.ts).
  const firstPath = toolEnvironment.refresh();
  ipcMain.handle("chat:providers", async (event, refresh: unknown) => {
    guard(event);
    await firstPath;
    if (refresh === true) await toolEnvironment.refresh();
    return limitsStore.merge(await service!.providers(refresh === true));
  });
  ipcMain.handle("chat:send", (event, payload: unknown) => {
    guard(event);
    const sender = event.sender;
    return service!.start(payload, (requestId, chatEvent) => {
      const window = getWindow();
      if (window && !window.isDestroyed() && window.webContents === sender && !sender.isDestroyed()) {
        sender.send("chat:event", { requestId, event: chatEvent });
      }
    });
  });
  // A file or image the user added to a message: its bytes, checked and kept here (attachments.ts).
  ipcMain.handle("chat:attach", (event, payload: unknown) => {
    guard(event);
    return store.add(payload);
  });
  // The + menu: the project's files, and one of them attached like a file the user picked. Only files inside
  // the project's folder, never through a link (workspace.ts inside()).
  ipcMain.handle("chat:project-files", (event, projectId: unknown) => {
    guard(event);
    if (typeof projectId !== "string") throw new Error("Invalid project id.");
    return listFiles(projectWorkspace(app.getPath("userData"), projectId), 200);
  });
  ipcMain.handle("chat:attach-project-file", (event, payload: unknown) => {
    guard(event);
    const v = (payload ?? {}) as Record<string, unknown>;
    if (typeof v.projectId !== "string" || typeof v.path !== "string") throw new Error("Invalid file.");
    const file = inside(projectWorkspace(app.getPath("userData"), v.projectId), v.path);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > LIMITS.pdf) throw new Error("This file cannot be attached.");
    return store.add({ name: v.path.split("/").pop(), data: new Uint8Array(fs.readFileSync(file)) });
  });
  // Copy a code block from the chat.
  ipcMain.handle("chat:copy", (event, text: unknown) => {
    guard(event);
    if (typeof text !== "string" || text.length > 1_000_000) return false;
    clipboard.writeText(text);
    return true;
  });
  // A link in a reply opens in the user's own browser, and only when it is a web address.
  ipcMain.handle("chat:open-link", async (event, raw: unknown) => {
    guard(event);
    const url = safeWebUrl(raw);
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle("chat:stop", (event, requestId: unknown) => {
    guard(event);
    return service!.stop(requestId);
  });
  // Nothing keeps running in the background after the app quits.
  app.on("before-quit", () => service?.stopAll());
  return service;
}

export function safeWebUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000 || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}
