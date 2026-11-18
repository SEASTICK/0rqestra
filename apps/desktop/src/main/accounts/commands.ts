import type { ProviderId } from "../providers/types";

// The providers' official install and sign-in commands, word for word from their documentation
// (checked 2026-11-18):
// - Claude Code, https://code.claude.com/docs/en/setup: Windows PowerShell
//   `irm https://claude.ai/install.ps1 | iex`; macOS/Linux `curl -fsSL https://claude.ai/install.sh | bash`.
//   Sign-in: `claude auth login` (CLI reference; `--console` would be API billing and is never used).
// - Codex, README of github.com/openai/codex: Windows
//   `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`;
//   macOS/Linux `curl -fsSL https://chatgpt.com/codex/install.sh | sh`. Sign-in: `codex login`
//   (learn.chatgpt.com/docs/auth: "Run codex login, then complete the browser flow").
// These strings are constants. Nothing from the window ever becomes part of a command.

export type CommandKind = "install" | "signIn";

export interface OfficialCommands {
  // What the user can copy into a terminal themselves (the fallback).
  install: string;
  signIn: string;
  version: string;
  // What 0rqestra runs: the installer script inside PowerShell (Windows) or a shell, and the sign-in
  // with the tool's full path, so it works even before a new terminal has the new PATH.
  terminalInstall: string;
  terminalSignIn: string;
  // The shell those strings are written for.
  shell: "powershell" | "sh";
}

const INSTALL_SCRIPT: Record<ProviderId, { ps: string; sh: string; docs: string }> = {
  claude: {
    ps: "irm https://claude.ai/install.ps1 | iex",
    docs: "irm https://claude.ai/install.ps1 | iex",
    sh: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  codex: {
    ps: "irm https://chatgpt.com/codex/install.ps1 | iex",
    docs: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    sh: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  },
};

const SIGN_IN_ARGS: Record<ProviderId, string> = { claude: "auth login", codex: "login" };
const TOOL: Record<ProviderId, string> = { claude: "claude", codex: "codex" };

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function installScript(provider: ProviderId, platform: NodeJS.Platform): string {
  return platform === "win32" ? INSTALL_SCRIPT[provider].ps : INSTALL_SCRIPT[provider].sh;
}

export function officialCommands(provider: ProviderId, platform: NodeJS.Platform, binaryPath: string | null, source: string | null): OfficialCommands {
  const win = platform === "win32";
  const tool = TOOL[provider];
  const args = SIGN_IN_ARGS[provider];
  // A tool found on PATH can be typed by name; one found only in its install folder needs the path.
  const call = binaryPath && source !== "path" ? (win ? `& ${psQuote(binaryPath)}` : shQuote(binaryPath)) : tool;
  const full = binaryPath ? (win ? `& ${psQuote(binaryPath)}` : shQuote(binaryPath)) : tool;
  return {
    install: win ? INSTALL_SCRIPT[provider].docs : INSTALL_SCRIPT[provider].sh,
    signIn: `${call} ${args}`,
    version: `${call} --version`,
    terminalInstall: installScript(provider, platform),
    terminalSignIn: `${full} ${args}`,
    shell: win ? "powershell" : "sh",
  };
}
