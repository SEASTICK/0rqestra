import { contextBridge, ipcRenderer } from "electron";

// Sandboxed preloads cannot require local modules, so channel names and the flag are repeated here.
contextBridge.exposeInMainWorld("worktreeai", {
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
});

// Smoke-only diagnostic sent to the main process; nothing is exposed to the page.
if (process.argv.includes("--worktreeai-smoke")) {
  ipcRenderer.send("smoke:diagnostics", {
    sandboxed: process.sandboxed,
    contextIsolated: process.contextIsolated,
  });
}
