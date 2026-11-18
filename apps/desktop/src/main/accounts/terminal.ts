import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TerminalRequest } from "./accounts-service";

// Starting the official installer in the background, and opening a terminal window with an official
// command in it. The commands are constants from commands.ts; the window supplies only a provider id.

export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// PowerShell's -EncodedCommand: base64 of UTF-16LE. No quoting rules apply to it on any command line.
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// The script that runs the official installer without a window. Progress bars are switched off (they
// only slow a download down when nobody sees them) and output is UTF-8 so the log reads correctly.
export function backgroundInstallScript(command: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "try {",
    `  ${command}`,
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
    "if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  ].join("\n");
}

export function terminalScript(request: TerminalRequest): string {
  return [
    `$Host.UI.RawUI.WindowTitle = ${psQuote(request.title)}`,
    "Write-Host ''",
    ...request.intro.map((line) => `Write-Host ${psQuote(line)}`),
    "Write-Host ''",
    `Write-Host ${psQuote(`  ${request.command}`)} -ForegroundColor Cyan`,
    "Write-Host ''",
    ...(request.confirm ? ["$null = Read-Host 'Press Enter to run it, or close this window to cancel'"] : []),
    request.command,
    "Write-Host ''",
    "Write-Host 'Finished. You can close this window. 0rqestra notices the change by itself.' -ForegroundColor Green",
  ].join("\n");
}

export function shellTerminalScript(request: TerminalRequest): string {
  return [
    "#!/bin/bash",
    // A key in the user's shell profile must not decide how the tool signs in.
    "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY CODEX_API_KEY",
    `printf '\\033]0;%s\\007' ${shQuote(request.title)}`,
    "echo",
    ...request.intro.map((line) => `echo ${shQuote(line)}`),
    "echo",
    `echo ${shQuote(`  ${request.command}`)}`,
    "echo",
    ...(request.confirm ? ["read -r -p 'Press Enter to run it, or close this window to cancel '"] : []),
    request.command,
    "echo",
    "echo 'Finished. You can close this window. 0rqestra notices the change by itself.'",
  ].join("\n");
}

export function startInstallerProcess(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): ChildProcess {
  const options = { env, cwd: os.homedir(), stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], windowsHide: true };
  if (platform === "win32") {
    return spawn(windowsPowerShell(env), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(backgroundInstallScript(command))], options);
  }
  return spawn("/bin/bash", ["-c", command], options);
}

// The argument line for cmd.exe's `start`, which gives the new PowerShell its own visible window.
export function windowsTerminalArgs(request: TerminalRequest, env: NodeJS.ProcessEnv = process.env): string[] {
  const ps = windowsPowerShell(env);
  // With /s, cmd.exe removes the outer quotes and runs the rest as it is.
  return ["/d", "/s", "/c", `"start "0rqestra" "${ps}" -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(terminalScript(request))}"`];
}

export function openTerminalWindow(request: TerminalRequest, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, tmpDir = os.tmpdir()): boolean {
  try {
    if (platform === "win32") {
      const cmd = path.join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      const child = spawn(cmd, windowsTerminalArgs(request, env), { env, cwd: os.homedir(), stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true, detached: true });
      child.on("error", () => undefined);
      child.unref();
      return true;
    }
    if (platform === "darwin") {
      const dir = fs.mkdtempSync(path.join(tmpDir, "orqestra-terminal-"));
      const file = path.join(dir, "0rqestra.command");
      fs.writeFileSync(file, shellTerminalScript(request), { mode: 0o700 });
      const child = spawn("/usr/bin/open", ["-a", "Terminal", file], { env, stdio: "ignore", detached: true });
      child.on("error", () => undefined);
      child.unref();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
