import crypto from "node:crypto";

// Running an app the team built (a Node.js project with a package.json) in a locked container. This file
// holds the decisions, free of Docker and Electron so they are unit-tested: which script runs, and the
// exact `docker run` arguments. Nothing here starts a process.
//
// What the container gets: a copy of the product's folder (never the project folder itself), the
// official Node.js image, and limits on memory, CPU, processes and time. What it never gets: keys or
// other environment variables from this computer, other files, extra Linux capabilities, or root.

export const IMAGE = "node:22-alpine";
export const APP_PORT = 3000;
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
export const RUN_LIMIT_MS = 60 * 60_000;
export const READY_TIMEOUT_MS = 90_000;

export interface AppSpec {
  script: string;
  hasLock: boolean;
}

// The script that starts the app: "dev" first (live reload while the team works), then "start".
export function appSpec(packageJson: unknown, files: string[]): AppSpec | null {
  if (!packageJson || typeof packageJson !== "object") return null;
  const scripts = (packageJson as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object") return null;
  const s = scripts as Record<string, unknown>;
  const script = ["dev", "start"].find((name) => typeof s[name] === "string" && (s[name] as string).trim());
  if (!script) return null;
  return { script, hasLock: files.includes("package-lock.json") };
}

// A name Docker accepts and that says what it is, the same for the same product.
export function containerName(projectId: string, productId: string): string {
  return `orqestra-${crypto.createHash("sha256").update(`${projectId}\n${productId}`).digest("hex").slice(0, 16)}`;
}

export const LABEL = "dev.orqestra.sandbox=1";

const LOCKED = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "node", "--label", LABEL];
const QUIET_NPM = ["-e", "HOME=/tmp", "-e", "npm_config_cache=/tmp/.npm", "-e", "npm_config_update_notifier=false", "-e", "npm_config_fund=false", "-e", "npm_config_audit=false"];

// Installs the packages into the copy. This step needs the package registry, so it has a network.
export function installArgs(name: string, appDir: string, spec: AppSpec, extra: string[] = []): string[] {
  return [
    "run", "--rm", "--name", `${name}-install`, ...LOCKED,
    "--memory", "2g", "--cpus", "2", "--pids-limit", "512",
    ...QUIET_NPM, ...extra,
    "-v", `${appDir}:/app`, "-w", "/app", "--tmpfs", "/tmp:exec",
    IMAGE, "npm", spec.hasLock ? "ci" : "install",
  ];
}

// Runs the app. Its port is published on this computer's loopback address only, on a free port.
export function runArgs(name: string, appDir: string, spec: AppSpec): string[] {
  return [
    "run", "-d", "--rm", "--name", name, ...LOCKED,
    "--memory", "1g", "--cpus", "1", "--pids-limit", "256",
    ...QUIET_NPM, "-e", `PORT=${APP_PORT}`, "-e", "HOST=0.0.0.0", "-e", "NODE_ENV=development",
    "-p", `127.0.0.1::${APP_PORT}`,
    "-v", `${appDir}:/app`, "-w", "/app", "--tmpfs", "/tmp:exec",
    IMAGE, "npm", "run", spec.script,
  ];
}

// "127.0.0.1:49153" (and on some systems an IPv6 line as well) → 49153.
export function publishedPort(output: string): number | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^127\.0\.0\.1:(\d{1,5})$/.exec(line.trim());
    if (m) return Number(m[1]);
  }
  return null;
}

// The packages to install change only when package.json or the lockfile change.
export function installKey(packageJson: string, lock: string | null): string {
  return crypto.createHash("sha256").update(packageJson).update("\n--lock--\n").update(lock ?? "").digest("hex");
}

// For tests in an environment without Docker networking only: extra `docker run` arguments for the
// install step, as a JSON list in ORQESTRA_SANDBOX_INSTALL_ARGS. The app never sets it.
export function extraInstallArgs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.ORQESTRA_SANDBOX_INSTALL_ARGS;
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : [];
  } catch {
    return [];
  }
}
