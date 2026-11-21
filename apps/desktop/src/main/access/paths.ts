import fs from "node:fs";
import path from "node:path";

// Where an agent may read or write on this computer. Every check resolves the real path on disk at
// the moment of use (fs.realpathSync.native), so a symbolic link, a Windows junction or a ".." in the
// request can never lead outside a granted folder, also when the link is created after the folder
// was granted. A granted folder that itself turned into a link somewhere else is refused as well.

const WINDOWS = process.platform === "win32";
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

export class AccessDenied extends Error {}

const same = (a: string, b: string) => (WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b);

// True when `child` is `root` or inside it (both real, absolute paths).
export function within(root: string, child: string): boolean {
  if (same(root, child)) return true;
  const rel = path.relative(root, child);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// A plain relative path inside a folder: forward or back slashes, no drive, no "..", no device
// names, no alternate data streams (":"), no control characters. Returns the parts, or null.
export function relativeParts(ref: string): string[] | null {
  if (typeof ref !== "string" || ref.length > 400) return null;
  const clean = ref.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (clean === "") return [];
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean) || clean.startsWith("~")) return null;
  const parts = clean.split("/");
  for (const p of parts) {
    if (!p || p === "." || p === ".." || p.includes(":") || /[<>"|?*]/.test(p) || [...p].some((c) => c.charCodeAt(0) < 32)) return null;
    if (WINDOWS && (DEVICE.test(p) || /[. ]$/.test(p))) return null;
  }
  return parts;
}

// The folder's real path now; refused when it is gone or now resolves somewhere else.
export function liveRoot(granted: string): string {
  let real: string;
  try {
    real = fs.realpathSync.native(granted);
  } catch {
    throw new AccessDenied(`The folder ${granted} is not there any more.`);
  }
  if (!same(real, granted)) throw new AccessDenied(`The folder ${granted} now leads to ${real}, so access was refused.`);
  if (!fs.statSync(real).isDirectory()) throw new AccessDenied(`${granted} is not a folder.`);
  return real;
}

// An existing file or folder for reading. Returns its real path.
export function resolveForRead(granted: string, ref: string): string {
  const root = liveRoot(granted);
  const parts = relativeParts(ref);
  if (!parts) throw new AccessDenied(`"${ref}" is not a plain path inside the folder.`);
  const full = path.join(root, ...parts);
  let real: string;
  try {
    real = fs.realpathSync.native(full);
  } catch {
    throw new AccessDenied(`${ref || "."} does not exist in ${granted}.`);
  }
  if (!within(root, real)) throw new AccessDenied(`${ref} leads outside ${granted} (to ${real}), so it was refused.`);
  return real;
}

// A file to write (it may not exist yet). The nearest existing folder must resolve inside the
// granted folder; an existing target must be a plain file: not a link, and not a hard link that
// another path shares (writing it would change a file elsewhere).
export function resolveForWrite(granted: string, ref: string): string {
  const root = liveRoot(granted);
  const parts = relativeParts(ref);
  if (!parts || !parts.length) throw new AccessDenied(`"${ref}" is not a plain file path inside the folder.`);
  const full = path.join(root, ...parts);
  let probe = path.dirname(full);
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) throw new AccessDenied(`${ref} has no folder to write into.`);
    probe = up;
  }
  const realDir = fs.realpathSync.native(probe);
  if (!within(root, realDir)) throw new AccessDenied(`${ref} leads outside ${granted} (through ${realDir}), so it was refused.`);
  if (fs.existsSync(full) || isLink(full)) {
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) throw new AccessDenied(`${ref} is a link, so it was not written.`);
    if (!st.isFile()) throw new AccessDenied(`${ref} is not a file.`);
    if (st.nlink > 1) throw new AccessDenied(`${ref} is a hard link shared with another path, so it was not written.`);
    const real = fs.realpathSync.native(full);
    if (!within(root, real)) throw new AccessDenied(`${ref} leads outside ${granted}, so it was refused.`);
  }
  return full;
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Writes a file checked with resolveForWrite: folders are made one at a time and each is checked
// again (a link swapped in between is caught), then a temporary file is renamed into place.
export function writeInside(granted: string, ref: string, content: string): void {
  const full = resolveForWrite(granted, ref);
  const root = liveRoot(granted);
  const dirs: string[] = [];
  for (let d = path.dirname(full); !fs.existsSync(d); d = path.dirname(d)) dirs.unshift(d);
  for (const d of dirs) {
    fs.mkdirSync(d);
    if (!within(root, fs.realpathSync.native(d))) throw new AccessDenied(`${ref} leads outside ${granted}, so it was refused.`);
  }
  const realDir = fs.realpathSync.native(path.dirname(full));
  if (!within(root, realDir)) throw new AccessDenied(`${ref} leads outside ${granted}, so it was refused.`);
  const temp = path.join(realDir, `.${path.basename(full)}.orqestra-tmp`);
  fs.rmSync(temp, { force: true });
  // "wx" never follows a link planted at the temporary name: it fails if anything is there.
  fs.writeFileSync(temp, content, { encoding: "utf8", flag: "wx" });
  try {
    resolveForWrite(granted, ref);
    fs.renameSync(temp, path.join(realDir, path.basename(full)));
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
