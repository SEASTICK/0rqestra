import type { BrowserWindowConstructorOptions, WebPreferences } from "electron";

// Required renderer settings; see docs/architecture.md §4.
export const SECURE_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  experimentalFeatures: false,
} as const satisfies WebPreferences;

export const SMOKE_RENDERER_FLAG = "--worktreeai-smoke";

export function mainWindowOptions(preloadPath: string, smokeMode = false): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    show: false,
    title: "WorkTreeAI",
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      preload: preloadPath,
      ...(smokeMode ? { additionalArguments: [SMOKE_RENDERER_FLAG] } : {}),
    },
  };
}

export interface SenderInfo {
  webContentsId: number;
  isMainFrame: boolean;
  frameUrl: string | undefined;
}

export interface TrustedRenderer {
  webContentsId: number;
  rendererUrl: string;
  caseInsensitivePaths: boolean;
}

function filePathOf(url: string | undefined): string | null {
  if (url === undefined || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "file:" || parsed.host !== "" || parsed.search !== "" || parsed.hash !== "") return null;
  try {
    return decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
}

// Compares file URLs by decoded path: Node encodes "~" as "%7E" but Chromium does not.
export function isSameFileUrl(candidate: string | undefined, expected: string, caseInsensitive: boolean): boolean {
  const a = filePathOf(candidate);
  const b = filePathOf(expected);
  if (a === null || b === null) return false;
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// IPC is accepted only from the main frame of the app's own window, showing the app's own page.
export function isTrustedSender(sender: SenderInfo, trusted: TrustedRenderer): boolean {
  return (
    sender.webContentsId === trusted.webContentsId &&
    sender.isMainFrame &&
    isSameFileUrl(sender.frameUrl, trusted.rendererUrl, trusted.caseInsensitivePaths)
  );
}
