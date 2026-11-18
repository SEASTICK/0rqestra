import { contextBridge, ipcRenderer } from "electron";

// Sandboxed preloads cannot require local modules, so channel names and the flag are repeated here.
contextBridge.exposeInMainWorld("orqestra", {
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
  // App updates (main/update/index.ts). The page receives state messages and can only ask for a
  // check or answer the "Restart now / Later" question; the main process decides everything else.
  updates: {
    subscribe: (listener: (message: unknown) => void) => {
      ipcRenderer.removeAllListeners("update:state");
      ipcRenderer.on("update:state", (_event, message: unknown) => listener(message));
      return ipcRenderer.invoke("update:subscribe");
    },
    check: () => ipcRenderer.invoke("update:check"),
    respond: (choice: string) => ipcRenderer.invoke("update:respond", choice === "restart" ? "restart" : "later"),
  },
  // The chat (main/chat-ipc.ts). The page can ask which tools are ready, send one message with its
  // history, and stop a reply. It never chooses a program, a path, or an argument.
  chat: {
    providers: (refresh?: boolean) => ipcRenderer.invoke("chat:providers", refresh === true),
    send: (payload: unknown) => ipcRenderer.invoke("chat:send", payload),
    stop: (requestId: string) => ipcRenderer.invoke("chat:stop", String(requestId)),
    subscribe: (listener: (message: unknown) => void) => {
      ipcRenderer.removeAllListeners("chat:event");
      ipcRenderer.on("chat:event", (_event, message: unknown) => listener(message));
    },
  },
  // Team runs (main/team/team-ipc.ts): start an approved plan, stop it, open the project's folder.
  team: {
    start: (payload: unknown) => ipcRenderer.invoke("team:start", payload),
    stop: (runId: string) => ipcRenderer.invoke("team:stop", String(runId)),
    openFolder: (projectId: string) => ipcRenderer.invoke("team:open-folder", String(projectId)),
    subscribe: (listener: (message: unknown) => void) => {
      ipcRenderer.removeAllListeners("team:event");
      ipcRenderer.on("team:event", (_event, message: unknown) => listener(message));
    },
  },
  // AI accounts (main/accounts/accounts-ipc.ts): check the tools, run the official installer or
  // sign-in, test a connection. The page names a provider ("claude" or "codex") and a command kind
  // ("install" or "signIn"); the main process decides the command.
  accounts: {
    status: (refresh?: boolean) => ipcRenderer.invoke("accounts:status", refresh !== false),
    install: (provider: string) => ipcRenderer.invoke("accounts:install", String(provider)),
    signIn: (provider: string) => ipcRenderer.invoke("accounts:sign-in", String(provider)),
    openTerminal: (provider: string, kind: string) => ipcRenderer.invoke("accounts:open-terminal", String(provider), String(kind)),
    cancel: (provider: string) => ipcRenderer.invoke("accounts:cancel", String(provider)),
    test: (provider: string) => ipcRenderer.invoke("accounts:test", String(provider)),
    copy: (provider: string, kind: string) => ipcRenderer.invoke("accounts:copy", String(provider), String(kind)),
    subscribe: (listener: (message: unknown) => void) => {
      ipcRenderer.removeAllListeners("accounts:event");
      ipcRenderer.on("accounts:event", (_event, message: unknown) => listener(message));
    },
  },
});

// Smoke-only diagnostic sent to the main process; nothing is exposed to the page.
if (process.argv.includes("--orqestra-smoke")) {
  ipcRenderer.send("smoke:diagnostics", {
    sandboxed: process.sandboxed,
    contextIsolated: process.contextIsolated,
  });
}
