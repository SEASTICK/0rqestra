import { describe, expect, it } from "vitest";
import {
  isSameFileUrl,
  isTrustedSender,
  mainWindowOptions,
  SECURE_WEB_PREFERENCES,
  SMOKE_RENDERER_FLAG,
  type SenderInfo,
} from "./security.js";

describe("Electron renderer security settings", () => {
  const prefs = mainWindowOptions("/app/dist/preload/preload.js").webPreferences;

  it("sandboxes and isolates the renderer", () => {
    expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, webSecurity: true });
  });

  it("disables Node.js in the renderer, workers, and subframes", () => {
    expect(prefs).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
    });
  });

  it("disables webview tags, insecure content, and experimental features", () => {
    expect(prefs).toMatchObject({
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    });
  });

  it("sets the app icon only when a path is given, without touching web preferences", () => {
    const withIcon = mainWindowOptions("/p.js", false, "/app/dist/icon.ico");
    expect(withIcon.icon).toBe("/app/dist/icon.ico");
    expect(withIcon.webPreferences).toEqual(mainWindowOptions("/p.js").webPreferences);
    expect("icon" in mainWindowOptions("/p.js")).toBe(false);
  });

  it("applies exactly the required settings to the normal window", () => {
    expect(prefs).toEqual({ ...SECURE_WEB_PREFERENCES, preload: "/app/dist/preload/preload.js" });
  });

  it("adds only the smoke flag in smoke mode, keeping every security setting", () => {
    const smokePrefs = mainWindowOptions("/p.js", true).webPreferences;
    expect(smokePrefs).toEqual({
      ...SECURE_WEB_PREFERENCES,
      preload: "/p.js",
      additionalArguments: [SMOKE_RENDERER_FLAG],
    });
  });
});

describe("file URL comparison", () => {
  const expected = "file:///C:/Users/MINDAT%7E1/app/index.html";

  it("treats percent-encoded and literal characters as the same path", () => {
    expect(isSameFileUrl("file:///C:/Users/MINDAT~1/app/index.html", expected, false)).toBe(true);
  });

  it("ignores letter case only when asked to", () => {
    expect(isSameFileUrl("file:///c:/users/mindat~1/app/index.html", expected, true)).toBe(true);
    expect(isSameFileUrl("file:///c:/users/mindat~1/app/index.html", expected, false)).toBe(false);
  });

  it("rejects non-file schemes, hosts, queries, fragments, and malformed URLs", () => {
    expect(isSameFileUrl("https://C:/Users/MINDAT~1/app/index.html", expected, true)).toBe(false);
    expect(isSameFileUrl("file://server/C:/Users/MINDAT~1/app/index.html", expected, true)).toBe(false);
    expect(isSameFileUrl("file:///C:/Users/MINDAT~1/app/index.html?x=1", expected, true)).toBe(false);
    expect(isSameFileUrl("file:///C:/Users/MINDAT~1/app/index.html#a", expected, true)).toBe(false);
    expect(isSameFileUrl("not a url", expected, true)).toBe(false);
    expect(isSameFileUrl("file:///C:/%E0%A4%A", expected, true)).toBe(false);
  });
});

describe("IPC sender validation", () => {
  const trusted = { webContentsId: 7, rendererUrl: "file:///app/dist/renderer/index.html", caseInsensitivePaths: false };
  const valid: SenderInfo = { webContentsId: 7, isMainFrame: true, frameUrl: trusted.rendererUrl };

  it("accepts the main frame of the app window showing the app page", () => {
    expect(isTrustedSender(valid, trusted)).toBe(true);
  });

  it("rejects a different webContents, even with the right page and main frame", () => {
    expect(isTrustedSender({ ...valid, webContentsId: 8 }, trusted)).toBe(false);
  });

  it("rejects a subframe of the app window", () => {
    expect(isTrustedSender({ ...valid, isMainFrame: false }, trusted)).toBe(false);
  });

  it("rejects other origins and other local files", () => {
    expect(isTrustedSender({ ...valid, frameUrl: "https://example.com/" }, trusted)).toBe(false);
    expect(isTrustedSender({ ...valid, frameUrl: "file:///app/dist/renderer/other.html" }, trusted)).toBe(false);
    expect(isTrustedSender({ ...valid, frameUrl: `${trusted.rendererUrl}?x=1` }, trusted)).toBe(false);
  });

  it("rejects a sender whose frame is gone", () => {
    expect(isTrustedSender({ ...valid, frameUrl: undefined, isMainFrame: false }, trusted)).toBe(false);
  });
});
