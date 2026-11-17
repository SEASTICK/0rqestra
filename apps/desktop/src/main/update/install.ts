import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// Platform installers. The file passed in has already been verified against the update key.

// Windows: the NSIS installer replaces the app silently; then the app is started again.
//
// The installer's own relaunch (--force-run) goes through Explorer and did not start the app in
// local testing, so a detached cmd waits for the installer and then starts the app itself:
//   cmd /d /s /c ""start "" /wait "<installer>" --updated /S & start "" "<app>""
// With /s, cmd removes only the outer quotes, so paths with spaces stay intact. Windows paths
// cannot contain a double quote; anything that does is refused rather than quoted.
export function windowsInstallCommand(installerPath: string, appPath: string): string {
  for (const value of [installerPath, appPath]) {
    if (value.includes('"') || !/^[A-Za-z]:\\|^\\\\/.test(value)) throw new Error(`Unexpected path for the update: ${value}`);
  }
  return `"start "" /wait "${installerPath}" --updated /S & start "" "${appPath}""`;
}

export function startWindowsInstaller(installerPath: string, appPath: string): void {
  const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", windowsInstallCommand(installerPath, appPath)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  child.unref();
}

export function macBundlePath(execPath: string): string {
  // <bundle>.app/Contents/MacOS/<executable>. Always a POSIX path; path.posix keeps the tests
  // meaningful on Windows runners too.
  const bundle = path.posix.resolve(execPath, "..", "..", "..");
  if (!bundle.endsWith(".app")) throw new Error(`Not running from an app bundle: ${execPath}`);
  if (bundle.includes("/AppTranslocation/")) {
    throw new Error("Move the app to the Applications folder, start it from there, and try again.");
  }
  return bundle;
}

export type Extract = (archivePath: string, destination: string) => Promise<void>;

const run = promisify(execFile);
// ditto keeps symlinks, permissions, and the code signature of the bundle intact.
export const extractWithDitto: Extract = async (archivePath, destination) => {
  await run("/usr/bin/ditto", ["-x", "-k", archivePath, destination]);
};

// macOS: unpack the new bundle next to the installed one, then swap them. If the swap fails,
// the previous bundle is put back. Returns after the new bundle is in place.
export async function swapMacBundle(bundlePath: string, archivePath: string, extract: Extract): Promise<void> {
  const parent = path.dirname(bundlePath);
  const staging = await fs.mkdtemp(path.join(parent, ".0rqestra-update-"));
  try {
    const unpacked = path.join(staging, "new");
    await fs.mkdir(unpacked);
    await extract(archivePath, unpacked);
    const bundles = (await fs.readdir(unpacked)).filter((name) => name.endsWith(".app"));
    if (bundles.length !== 1) throw new Error(`Expected one app bundle in the update, found ${bundles.length}.`);

    const previous = path.join(staging, "previous.app");
    await fs.rename(bundlePath, previous);
    try {
      await fs.rename(path.join(unpacked, bundles[0]!), bundlePath);
    } catch (error) {
      await fs.rename(previous, bundlePath);
      throw error;
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
