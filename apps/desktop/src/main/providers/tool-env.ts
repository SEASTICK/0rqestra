import { execFile } from "node:child_process";
import path from "node:path";

// The PATH that provider tools are looked up with and started with. On Windows an installer writes
// the new PATH to the registry, but a program that is already running keeps the PATH it started
// with in process.env. So the user and machine PATH are read again from the registry every time the
// tools are checked, and an install made while 0rqestra is open is found without a restart.

const USER_KEY = "HKCU\\Environment";
const MACHINE_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

export type RegistryReader = (key: string) => Promise<string | null>;

// The text that `reg query <key> /v Path` prints, reduced to the value. REG_EXPAND_SZ values keep
// their %VARIABLES%; they are expanded by expandWindowsVars.
export function parseRegQuery(output: string): string | null {
  const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output);
  return match ? match[1]!.trim() : null;
}

export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv): string {
  const lookup = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => lookup.get(name.toLowerCase()) ?? whole);
}

// Reads one registry value with Windows' own reg.exe (by full path, so nothing on PATH can stand in).
export const readRegistryPath: RegistryReader = (key) =>
  new Promise((resolve) => {
    const reg = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
    execFile(reg, ["query", key, "/v", "Path"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      resolve(error ? null : parseRegQuery(String(stdout)));
    });
  });

export function pathKey(env: NodeJS.ProcessEnv): string | undefined {
  return Object.keys(env).find((k) => k.toLowerCase() === "path");
}

export function readPathVar(env: NodeJS.ProcessEnv): string {
  const key = pathKey(env);
  return key ? env[key] ?? "" : "";
}

// Machine entries first, then the user's (the order Windows uses for a new process), then anything
// only this process had, without duplicates.
export function mergePath(parts: (string | null | undefined)[], delimiter = path.delimiter, caseInsensitive = true): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const raw of (part ?? "").split(delimiter)) {
      const entry = raw.trim();
      if (!entry) continue;
      const id = (caseInsensitive ? entry.toLowerCase() : entry).replace(/[\\/]+$/, "");
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(entry);
    }
  }
  return out.join(delimiter);
}

export class ToolEnvironment {
  private fresh: string | null = null;

  constructor(
    private readonly base: () => NodeJS.ProcessEnv = () => process.env,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly read: RegistryReader = readRegistryPath,
  ) {}

  // Reads the PATH again. Elsewhere than Windows, the PATH the app started with is used as it is.
  async refresh(): Promise<string> {
    const base = this.base();
    if (this.platform !== "win32") {
      this.fresh = readPathVar(base);
      return this.fresh;
    }
    const [machine, user] = await Promise.all([this.read(MACHINE_KEY), this.read(USER_KEY)]);
    this.fresh = mergePath([machine, user].map((v) => (v === null ? null : expandWindowsVars(v, base))).concat(readPathVar(base)), ";", true);
    return this.fresh;
  }

  // The app's environment with the PATH from the last refresh. Exactly one PATH key is kept, since
  // Windows would otherwise pick one of several spellings.
  env(): NodeJS.ProcessEnv {
    const base = { ...this.base() };
    if (this.fresh === null) return base;
    for (const key of Object.keys(base)) if (key.toLowerCase() === "path") delete base[key];
    base[this.platform === "win32" ? "Path" : "PATH"] = this.fresh;
    return base;
  }
}

// One shared instance for the app: the adapters, the installer, and sign-in all see the same PATH.
export const toolEnvironment = new ToolEnvironment();
