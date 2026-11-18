import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findBinary, isBundledDir, officialLocations } from "./process.js";
import { expandWindowsVars, mergePath, parseRegQuery, ToolEnvironment } from "./tool-env.js";

let root: string;
let home: string;
let local: string;
let roaming: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "orq-toolenv-"));
  home = path.join(root, "home");
  local = path.join(home, "AppData", "Local");
  roaming = path.join(home, "AppData", "Roaming");
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(roaming, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// An environment that points every official location at the temporary folder, so the real tools on
// the machine that runs the tests are never found.
const winEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ USERPROFILE: home, LOCALAPPDATA: local, APPDATA: roaming, Path: "", ...extra });
const touch = (file: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  return file;
};

describe("reading PATH from the registry", () => {
  it("parses reg.exe output and expands variables", () => {
    const out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools\r\n\r\n";
    expect(parseRegQuery(out)).toBe("%USERPROFILE%\\.local\\bin;C:\\Tools");
    expect(parseRegQuery("    Path    REG_SZ    C:\\A")).toBe("C:\\A");
    expect(parseRegQuery("ERROR: The system was unable to find the specified registry key or value.")).toBeNull();
    expect(expandWindowsVars("%userprofile%\\x;%MISSING%\\y", { USERPROFILE: "C:\\Users\\Åsa" })).toBe("C:\\Users\\Åsa\\x;%MISSING%\\y");
  });

  it("merges machine, user and process entries without duplicates", () => {
    expect(mergePath(["C:\\Windows;C:\\Tools\\", "c:\\tools;C:\\User", "C:\\Windows;C:\\Old"], ";")).toBe("C:\\Windows;C:\\Tools\\;C:\\User;C:\\Old");
  });

  it("sees a PATH change made by an installer while the app is running, without trusting process.env", async () => {
    const bin = path.join(root, "NewTool", "bin");
    touch(path.join(bin, "claude.exe"));
    // process.env as it was when the app started: the new folder is not in it, and it never changes.
    const started = Object.freeze(winEnv({ Path: "C:\\Windows\\System32" }));
    let userPath = "C:\\Users\\x\\Old";
    const reads: string[] = [];
    const tools = new ToolEnvironment(() => started, "win32", async (key) => {
      reads.push(key);
      return key.startsWith("HKCU") ? userPath : "C:\\Windows\\System32;%USERPROFILE%\\machine";
    });

    await tools.refresh();
    expect(findBinary("claude", tools.env(), "win32")).toBeNull();

    // The installer writes the user PATH in the registry (as both official installers do).
    userPath = `C:\\Users\\x\\Old;${bin}`;
    await tools.refresh();
    const env = tools.env();
    expect(findBinary("claude", env, "win32")).toEqual({ path: path.join(bin, "claude.exe"), viaCmd: false, source: "path" });
    expect(Object.keys(env).filter((k) => k.toLowerCase() === "path")).toEqual(["Path"]);
    expect(env.Path).toBe(`C:\\Windows\\System32;${home}\\machine;C:\\Users\\x\\Old;${bin}`);
    expect(started.Path).toBe("C:\\Windows\\System32");
    expect(reads.filter((k) => k.startsWith("HKLM")).length).toBe(2);
    expect(reads.filter((k) => k.startsWith("HKCU")).length).toBe(2);
  });

  it("keeps the started PATH when the registry cannot be read, and uses it as is elsewhere than Windows", async () => {
    const win = new ToolEnvironment(() => ({ PATH: "C:\\A" }), "win32", async () => null);
    await win.refresh();
    expect(win.env().Path).toBe("C:\\A");
    const mac = new ToolEnvironment(() => ({ PATH: "/usr/bin:/bin" }), "darwin", async () => {
      throw new Error("must not read the registry");
    });
    await mac.refresh();
    expect(mac.env().PATH).toBe("/usr/bin:/bin");
  });
});

describe("finding the official tools", () => {
  it("finds Claude Code from the native installer outside PATH", () => {
    const file = touch(path.join(home, ".local", "bin", "claude.exe"));
    expect(findBinary("claude", winEnv(), "win32")).toEqual({ path: file, viaCmd: false, source: "native" });
  });

  it("finds Codex from its Windows installer folder, CODEX_INSTALL_DIR, WinGet and npm", () => {
    const native = touch(path.join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"));
    expect(findBinary("codex", winEnv(), "win32")).toEqual({ path: native, viaCmd: false, source: "native" });
    const custom = touch(path.join(root, "custom", "codex.exe"));
    expect(findBinary("codex", winEnv({ CODEX_INSTALL_DIR: path.dirname(custom) }), "win32")?.path).toBe(custom);
    fs.rmSync(native);
    const winget = touch(path.join(local, "Microsoft", "WinGet", "Links", "codex.exe"));
    expect(findBinary("codex", winEnv(), "win32")).toEqual({ path: winget, viaCmd: false, source: "winget" });
    fs.rmSync(winget);
    const pkg = touch(path.join(local, "Microsoft", "WinGet", "Packages", "OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe", "codex.exe"));
    expect(findBinary("codex", winEnv(), "win32")).toEqual({ path: pkg, viaCmd: false, source: "winget" });
    fs.rmSync(pkg);
    const npm = touch(path.join(roaming, "npm", "codex.cmd"));
    expect(findBinary("codex", winEnv(), "win32")).toEqual({ path: npm, viaCmd: true, source: "npm" });
  });

  it("prefers PATH over the install folders", () => {
    touch(path.join(home, ".local", "bin", "claude.exe"));
    const onPath = touch(path.join(root, "onpath", "claude.exe"));
    expect(findBinary("claude", winEnv({ Path: path.dirname(onPath) }), "win32")?.source).toBe("path");
  });

  it("never uses a copy bundled inside a desktop app, even on PATH", () => {
    const store = touch(path.join(local, "Microsoft", "WindowsApps", "codex.exe"));
    const desktop = touch(path.join(roaming, "Claude", "claude-code", "2.1.325", "claude.exe"));
    expect(isBundledDir(path.dirname(store))).toBe(true);
    expect(isBundledDir(path.dirname(desktop))).toBe(true);
    expect(isBundledDir(path.join(home, ".local", "bin"))).toBe(false);
    expect(findBinary("codex", winEnv({ Path: path.dirname(store) }), "win32")).toBeNull();
    expect(findBinary("claude", winEnv({ Path: path.dirname(desktop) }), "win32")).toBeNull();
  });

  it("lists macOS install folders", () => {
    const dirs = officialLocations("claude", { HOME: "/Users/a" }, "darwin").map((l) => l.dir.replace(/\\/g, "/"));
    expect(dirs).toEqual(expect.arrayContaining(["/Users/a/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]));
  });
});
