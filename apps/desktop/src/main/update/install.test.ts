import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { macBundlePath, swapMacBundle, type Extract, windowsInstallCommand } from "./install.js";

describe("macBundlePath", () => {
  it("finds the bundle from the executable path", () => {
    expect(macBundlePath("/Applications/0rqestra.app/Contents/MacOS/0rqestra")).toBe("/Applications/0rqestra.app");
  });

  it("refuses when not running from a bundle or when translocated", () => {
    expect(() => macBundlePath("/usr/local/bin/electron")).toThrow(/Not running from an app bundle/);
    expect(() =>
      macBundlePath("/private/var/folders/x/AppTranslocation/ABC/d/0rqestra.app/Contents/MacOS/0rqestra"),
    ).toThrow(/Applications folder/);
  });
});

describe("swapMacBundle", () => {
  let dir: string;
  let bundle: string;
  const marker = () => fs.readFileSync(path.join(bundle, "version.txt"), "utf8");
  const extractBundles =
    (...names: string[]): Extract =>
    async (_archive, destination) => {
      for (const name of names) {
        fs.mkdirSync(path.join(destination, name));
        fs.writeFileSync(path.join(destination, name, "version.txt"), "new");
      }
    };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-test-"));
    bundle = path.join(dir, "0rqestra.app");
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, "version.txt"), "old");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("replaces the bundle and leaves nothing else behind", async () => {
    await swapMacBundle(bundle, "update.zip", extractBundles("Renamed.app"));
    expect(marker()).toBe("new");
    expect(fs.readdirSync(dir)).toEqual(["0rqestra.app"]);
  });

  it("keeps the installed app when the update cannot be unpacked", async () => {
    await expect(
      swapMacBundle(bundle, "update.zip", async () => {
        throw new Error("corrupt archive");
      }),
    ).rejects.toThrow("corrupt archive");
    expect(marker()).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["0rqestra.app"]);
  });

  it("keeps the installed app when the update holds no bundle or several", async () => {
    await expect(swapMacBundle(bundle, "update.zip", extractBundles())).rejects.toThrow(/found 0/);
    await expect(swapMacBundle(bundle, "update.zip", extractBundles("A.app", "B.app"))).rejects.toThrow(/found 2/);
    expect(marker()).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["0rqestra.app"]);
  });
});

describe("windowsInstallCommand", () => {
  it("runs the installer silently, waits for it, then starts the app, keeping paths with spaces whole", () => {
    const command = windowsInstallCommand(
      "C:\\Users\\Min Dator\\AppData\\Roaming\\0rqestra\\updates\\0rqestra_0.2.1_x64-setup.exe",
      "C:\\Users\\Min Dator\\AppData\\Local\\Programs\\0rqestra\\0rqestra.exe",
    );
    expect(command).toBe(
      '"start "" /wait "C:\\Users\\Min Dator\\AppData\\Roaming\\0rqestra\\updates\\0rqestra_0.2.1_x64-setup.exe" --updated /S & start "" "C:\\Users\\Min Dator\\AppData\\Local\\Programs\\0rqestra\\0rqestra.exe""',
    );
    expect(command).not.toContain("--force-run");
  });

  it("refuses paths that are not absolute Windows paths or contain a quote", () => {
    expect(() => windowsInstallCommand('C:\\a"b.exe', "C:\\app.exe")).toThrow(/Unexpected path/);
    expect(() => windowsInstallCommand("relative\\setup.exe", "C:\\app.exe")).toThrow(/Unexpected path/);
    expect(() => windowsInstallCommand("C:\\setup.exe", "C:\\app.exe & calc")).not.toThrow(); // stays inside the quotes
  });
});
