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
    direct: (payload: unknown) => ipcRenderer.invoke("team:direct", payload),
    undo: (payload: unknown) => ipcRenderer.invoke("team:undo", payload),
    // Apps the team built, run in a locked container (main/sandbox).
    appDocker: () => ipcRenderer.invoke("team:app-docker"),
    appStatus: (projectId: string) => ipcRenderer.invoke("team:app-status", String(projectId)),
    appStart: (payload: unknown) => ipcRenderer.invoke("team:app-start", payload),
    appSync: (payload: unknown) => ipcRenderer.invoke("team:app-sync", payload),
    appStop: (payload: unknown) => ipcRenderer.invoke("team:app-stop", payload),
    onAppEvent: (listener: (message: unknown) => void) => {
      ipcRenderer.removeAllListeners("team:app-event");
      ipcRenderer.on("team:app-event", (_event, message: unknown) => listener(message));
    },
    plan: (payload: unknown) => ipcRenderer.invoke("team:plan", payload),
    stopPlan: (requestId: string) => ipcRenderer.invoke("team:plan-stop", String(requestId)),
    stop: (runId: string) => ipcRenderer.invoke("team:stop", String(runId)),
    openFolder: (projectId: string) => ipcRenderer.invoke("team:open-folder", String(projectId)),
    products: (projectId: string) => ipcRenderer.invoke("team:products", String(projectId)),
    subscribe: (listener: (message: unknown) => void) => {
      ipcRenderer.removeAllListeners("team:event");
      ipcRenderer.on("team:event", (_event, message: unknown) => listener(message));
    },
    // Errors from a previewed page (main/preview/problems.ts).
    onPreviewProblem: (listener: (message: unknown) => void) => {
      ipcRenderer.removeAllListeners("team:preview-problem");
      ipcRenderer.on("team:preview-problem", (_event, message: unknown) => listener(message));
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
  // Teams (main/teams/teams-ipc.ts): sign in with an email code, create and join teams, and link
  // this computer's checkout to a shared project. The page never sends a folder path or a token:
  // folders are chosen in the system dialog and referred to by the id that comes back.
  teams: {
    status: (refresh?: boolean) => ipcRenderer.invoke("teams:status", refresh === true),
    sendCode: (email: string, options?: { mode?: string; username?: string }) =>
      ipcRenderer.invoke("teams:send-code", String(email), { mode: options?.mode === "register" ? "register" : "sign_in", username: String(options?.username ?? "").slice(0, 100) }),
    verifyCode: (code: string) => ipcRenderer.invoke("teams:verify-code", String(code)),
    cancelCode: () => ipcRenderer.invoke("teams:cancel-code"),
    signOut: () => ipcRenderer.invoke("teams:sign-out"),
    createTeam: (name: string) => ipcRenderer.invoke("teams:create-team", String(name)),
    createInvite: (teamId: string, email: string) => ipcRenderer.invoke("teams:create-invite", String(teamId), String(email)),
    copyInvite: (inviteId: string) => ipcRenderer.invoke("teams:copy-invite", String(inviteId)),
    revokeInvite: (inviteId: string) => ipcRenderer.invoke("teams:revoke-invite", String(inviteId)),
    acceptInvite: (code: string) => ipcRenderer.invoke("teams:accept-invite", String(code)),
    setUsername: (name: string) => ipcRenderer.invoke("teams:set-username", String(name)),
    addFriend: (username: string) => ipcRenderer.invoke("teams:add-friend", String(username)),
    respondFriend: (requestId: string, accept: boolean) => ipcRenderer.invoke("teams:respond-friend", String(requestId), accept === true),
    removeFriend: (userId: string) => ipcRenderer.invoke("teams:remove-friend", String(userId)),
    inviteFriend: (teamId: string, userId: string) => ipcRenderer.invoke("teams:invite-friend", String(teamId), String(userId)),
    respondTeamInvite: (inviteId: string, accept: boolean) => ipcRenderer.invoke("teams:respond-team-invite", String(inviteId), accept === true),
    revokeTeamInvite: (inviteId: string) => ipcRenderer.invoke("teams:revoke-team-invite", String(inviteId)),
    chooseCheckout: () => ipcRenderer.invoke("teams:choose-checkout"),
    chooseRemote: (selectionId: string, remote: string) => ipcRenderer.invoke("teams:choose-remote", String(selectionId), String(remote)),
    registerProject: (payload: unknown) => ipcRenderer.invoke("teams:register-project", payload),
    linkCheckout: (payload: unknown) => ipcRenderer.invoke("teams:link-checkout", payload),
    unlink: (sharedProjectId: string) => ipcRenderer.invoke("teams:unlink", String(sharedProjectId)),
    openCheckout: (sharedProjectId: string) => ipcRenderer.invoke("teams:open-checkout", String(sharedProjectId)),
    catchUp: (sharedProjectId: string) => ipcRenderer.invoke("teams:catch-up", String(sharedProjectId)),
    markSeen: (sharedProjectId: string, items: unknown) => ipcRenderer.invoke("teams:mark-seen", String(sharedProjectId), items),
    keepCatchUp: (localProjectId: string, message: unknown) => ipcRenderer.invoke("teams:keep-catch-up", String(localProjectId), message),
    keptCatchUps: () => ipcRenderer.invoke("teams:kept-catch-ups"),
    teammateWork: (sharedProjectId: string, userId: string) => ipcRenderer.invoke("teams:teammate-work", String(sharedProjectId), String(userId)),
    subscribe: (listener: (message: unknown) => void) => {
      ipcRenderer.removeAllListeners("teams:event");
      ipcRenderer.on("teams:event", (_event, message: unknown) => listener(message));
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
