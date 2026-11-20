import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findBinary, killTree, providerEnv } from "../providers/process";
import { toolEnvironment } from "../providers/tool-env";
import type { DockerCli } from "./sandbox";

// The `docker` command line, run with fixed arguments (sandbox/plan.ts builds them; nothing from a user
// or a model is ever a command). The CLI itself gets this computer's environment without keys; the
// containers get nothing from it unless an argument says so.

const EXTRA_LOCATIONS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"],
  win32: ["C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"],
  linux: ["/usr/bin/docker", "/usr/local/bin/docker"],
};

export function findDocker(env: NodeJS.ProcessEnv = toolEnvironment.env()): string | null {
  const override = env.ORQESTRA_DOCKER_BIN;
  if (override && fs.existsSync(override)) return override;
  const found = findBinary("docker", env);
  if (found && !found.viaCmd) return found.path;
  return (EXTRA_LOCATIONS[process.platform] ?? []).find((p) => fs.existsSync(p)) ?? null;
}

function lines(onLine: (line: string) => void) {
  let rest = "";
  return {
    push(chunk: string) {
      rest += chunk;
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? "";
      for (const p of parts) onLine(p);
    },
    end() { if (rest) onLine(rest); rest = ""; },
  };
}

export function createDockerCli(): DockerCli {
  const env = () => {
    const base = providerEnv(toolEnvironment.env());
    const bin = findDocker();
    // Docker Desktop's helpers live next to the CLI; they need to be found on PATH.
    if (bin) base.PATH = [path.dirname(bin), base.PATH ?? base.Path ?? ""].filter(Boolean).join(path.delimiter);
    return base;
  };
  return {
    available: () => findDocker() !== null,
    run(args, options = {}) {
      const bin = findDocker();
      if (!bin) return Promise.reject(new Error("Docker is not installed."));
      return new Promise((resolve) => {
        const child = spawn(bin, args, { env: env(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let out = "";
        const forward = options.onLine ? lines(options.onLine) : null;
        const take = (d: Buffer) => {
          const text = d.toString("utf8");
          out = (out + text).slice(-20_000);
          forward?.push(text);
        };
        child.stdout?.on("data", take);
        child.stderr?.on("data", take);
        const timer = options.timeoutMs ? setTimeout(() => killTree(child), options.timeoutMs) : null;
        child.on("error", (error) => { if (timer) clearTimeout(timer); resolve({ code: 127, out: error.message }); });
        child.on("close", (code) => { if (timer) clearTimeout(timer); forward?.end(); resolve({ code: code ?? 1, out }); });
      });
    },
    runNow(args, timeoutMs) {
      const bin = findDocker();
      if (bin) spawnSync(bin, args, { env: env(), stdio: "ignore", timeout: timeoutMs, windowsHide: true });
    },
    follow(args, onLine) {
      const bin = findDocker();
      if (!bin) return { stop() {} };
      const child = spawn(bin, args, { env: env(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const forward = lines(onLine);
      child.stdout?.on("data", (d: Buffer) => forward.push(d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => forward.push(d.toString("utf8")));
      child.on("error", () => undefined);
      return { stop: () => killTree(child) };
    },
  };
}
