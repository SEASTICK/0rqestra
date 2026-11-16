import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// Platform installers. The file passed in has already been verified against the update key.

// Windows: the NSIS installer replaces the app silently and starts it again (--force-run).
export function startWindowsInstaller(installerPath: string): void {
  const child = spawn(installerPath, ["--updated", "/S", "--force-run"], { detached: true, stdio: "ignore" });
  child.unref();
}

export function macBundlePath(execPath: string): string {
  // <bundle>.app/Contents/MacOS/<executable>
  const bundle = path.resolve(execPath, "..", "..", "..");
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
  const staging = await fs.mkdtemp(path.join(parent, ".worktreeai-update-"));
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
