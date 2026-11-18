import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Starting the provider tools safely: find the official binary, give it an environment without
// any API key (so a subscription login is the only way it can work), and stop it reliably.

// Variables that could make a tool bill an API account instead of the user's subscription, or
// that belong to Electron itself. They never reach a provider process.
const BLOCKED = [
  /^ANTHROPIC_/,
  /^CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$/,
  /^OPENAI_/,
  /^CODEX_API_KEY$/,
  /^AZURE_OPENAI_/,
  /^AWS_/,
  /^GOOGLE_APPLICATION_CREDENTIALS$/,
  /_API_KEY$/,
  /_ACCESS_TOKEN$/,
  /^ELECTRON_/,
  /^NODE_OPTIONS$/,
  /^ORQESTRA_/,
];

export function providerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !BLOCKED.some((pattern) => pattern.test(name))) env[name] = value;
  }
  return env;
}

export type ToolSource = "override" | "path" | "native" | "winget" | "npm" | "homebrew";

export interface ToolBinary {
  path: string;
  // npm installs a .cmd launcher on Windows, which has to go through cmd.exe.
  viaCmd: boolean;
  // Where it was found, shown in AI accounts. Absent for test doubles.
  source?: ToolSource;
}

// Folders that belong to a desktop app's own copy of a tool (the Claude and Codex desktop apps, and
// Store app aliases). Neither provider documents those copies for use by other programs, so they are
// never used, even when they are on PATH. 0rqestra uses only the standalone CLI installs.
const BUNDLED_DIRS = [
  /[\\/]Microsoft[\\/]WindowsApps([\\/]|$)/i,
  /[\\/]AnthropicClaude([\\/]|$)/i,
  /[\\/]AppData[\\/]Roaming[\\/]Claude([\\/]|$)/i,
  /[\\/]Claude\.app[\\/]/i,
  /[\\/]Codex\.app[\\/]/i,
];

export function isBundledDir(dir: string): boolean {
  return BUNDLED_DIRS.some((pattern) => pattern.test(dir));
}

interface Location {
  dir: string;
  source: ToolSource;
}

function wingetPackageDirs(localAppData: string, prefix: string): string[] {
  const root = path.join(localAppData, "Microsoft", "WinGet", "Packages");
  try {
    return fs.readdirSync(root).filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase())).map((name) => path.join(root, name));
  } catch {
    return [];
  }
}

// The places the official installers put each tool, from the providers' install documentation
// (checked 2026-11-18): Claude Code's native installer uses ~/.local/bin; Codex's install.ps1 uses
// %LOCALAPPDATA%\Programs\OpenAI\Codex\bin (or CODEX_INSTALL_DIR); WinGet portable packages link
// into %LOCALAPPDATA%\Microsoft\WinGet\Links; npm uses %APPDATA%\npm. A fresh install is often not
// on the PATH that 0rqestra has, so these are searched too.
export function officialLocations(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Location[] {
  const home = env.USERPROFILE ?? env.HOME ?? "";
  const out: Location[] = [];
  if (home) out.push({ dir: path.join(home, ".local", "bin"), source: "native" });
  if (name === "claude" && home) out.push({ dir: path.join(home, ".claude", "local"), source: "native" });
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? (home ? path.join(home, "AppData", "Local") : "");
    const roaming = env.APPDATA ?? (home ? path.join(home, "AppData", "Roaming") : "");
    if (name === "codex" && env.CODEX_INSTALL_DIR) out.push({ dir: env.CODEX_INSTALL_DIR, source: "native" });
    if (name === "codex" && local) out.push({ dir: path.join(local, "Programs", "OpenAI", "Codex", "bin"), source: "native" });
    if (local) {
      out.push({ dir: path.join(local, "Microsoft", "WinGet", "Links"), source: "winget" });
      const pkg = name === "claude" ? "Anthropic.ClaudeCode_" : "OpenAI.Codex_";
      for (const dir of wingetPackageDirs(local, pkg)) out.push({ dir, source: "winget" });
    }
    if (roaming) out.push({ dir: path.join(roaming, "npm"), source: "npm" });
  }
  if (platform === "darwin") {
    out.push({ dir: "/opt/homebrew/bin", source: "homebrew" }, { dir: "/usr/local/bin", source: "homebrew" });
  }
  return out;
}

function pathOf(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path");
  return key ? env[key] ?? "" : "";
}

// Looks for the tool on PATH and in the places the official installers use. ORQESTRA_<NAME>_BIN
// (read from the app's own environment) overrides the search, for unusual installs.
export function findBinary(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ToolBinary | null {
  const override = env[`ORQESTRA_${name.toUpperCase()}_BIN`];
  if (override && fs.existsSync(override)) return { path: override, viaCmd: /\.(cmd|bat)$/i.test(override), source: "override" };
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const locations: Location[] = [
    ...pathOf(env).split(delimiter).filter(Boolean).map((dir) => ({ dir, source: "path" as const })),
    ...officialLocations(name, env, platform),
  ];
  const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const { dir, source } of locations) {
    if (isBundledDir(dir)) continue;
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      try {
        if (fs.statSync(full).isFile()) return { path: full, viaCmd: /\.cmd$/i.test(candidate), source };
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

// Arguments are fixed flags, file paths, and validated model names. User text never goes on the
// command line (it goes on stdin), so quoting for cmd.exe only has to handle these.
// Letters (any language), digits, and path punctuation; never %, ^, !, &, |, <, >, or quotes.
export const SAFE_ARG = /^[\p{L}\p{N} _.,:=+@/\\()\-*[\]~']*$/u;

function cmdQuote(arg: string): string {
  if (!SAFE_ARG.test(arg)) throw new Error(`Unsafe argument for cmd.exe: ${arg}`);
  return `"${arg}"`;
}

export interface SpawnSpec {
  bin: ToolBinary;
  prefixArgs?: string[] | undefined;
  args: string[];
  cwd?: string | undefined;
  env: NodeJS.ProcessEnv;
}

export function spawnTool({ bin, prefixArgs = [], args, cwd, env }: SpawnSpec): ChildProcess {
  const all = [...prefixArgs, ...args];
  const options = { cwd, env, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], windowsHide: true };
  if (bin.viaCmd) {
    const line = [cmdQuote(bin.path), ...all.map(cmdQuote)].join(" ");
    return spawn(env.ComSpec ?? process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(bin.path, all, options);
}

export function onJsonLines(stream: NodeJS.ReadableStream, onObject: (value: Record<string, unknown>) => void): void {
  let buffer = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (value && typeof value === "object" && !Array.isArray(value)) onObject(value as Record<string, unknown>);
      } catch {
        // Not JSON (for example a warning): ignored.
      }
    }
  });
}

export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
  } else {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2000).unref();
  }
}

// Runs a short command (for example --version or auth status) and collects its output.
export function runShort(spec: SpawnSpec, timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string; error: string | null }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnTool(spec);
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let error: string | null = null;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.stdin?.end();
    const timer = setTimeout(() => {
      error = `timed out after ${timeoutMs} ms`;
      killTree(child);
    }, timeoutMs);
    child.on("error", (e) => (error = e.message));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, error });
    });
  });
}

// Model names go on the command line, so only plain names are accepted.
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,79}$/;
export const EFFORT_NAME = /^[a-z]{1,16}$/;
