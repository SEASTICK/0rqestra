import fs from "node:fs";
import path from "node:path";
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { ChatService } from "./chat-service";
import { ClaudeCodeAdapter } from "./providers/claude-code";
import { CodexAdapter } from "./providers/codex";
import { toolEnvironment } from "./providers/tool-env";

// Electron wiring for the chat: three request channels from the window and one event channel
// back to it. Each request is accepted only from the app's own window (isTrusted).

let service: ChatService | null = null;

export function createAdapters(): { claude: ClaudeCodeAdapter; codex: CodexAdapter } {
  return { claude: new ClaudeCodeAdapter({ settingsDir: path.join(app.getPath("userData"), "provider-settings") }), codex: new CodexAdapter() };
}

export function registerChatIpc(isTrusted: (event: IpcMainInvokeEvent) => boolean, getWindow: () => BrowserWindow | null, adapters = createAdapters(), teamNow: (projectId: string) => string | null = () => null): ChatService {
  // An empty folder that is the working directory of every chat. The tools get no tools in a
  // chat, but if one ever looked around, there is nothing here to find.
  const cwd = () => {
    const dir = path.join(app.getPath("userData"), "chat-workspace");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  service = new ChatService(adapters, cwd, Date.now, teamNow);
  const guard = (event: IpcMainInvokeEvent) => {
    if (!isTrusted(event)) throw new Error("Rejected IPC from an untrusted sender.");
  };
  // The PATH is read from the registry at start and on every forced check (providers/tool-env.ts).
  const firstPath = toolEnvironment.refresh();
  ipcMain.handle("chat:providers", async (event, refresh: unknown) => {
    guard(event);
    await firstPath;
    if (refresh === true) await toolEnvironment.refresh();
    return service!.providers(refresh === true);
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
  ipcMain.handle("chat:stop", (event, requestId: unknown) => {
    guard(event);
    return service!.stop(requestId);
  });
  // Nothing keeps running in the background after the app quits.
  app.on("before-quit", () => service?.stopAll());
  return service;
}
