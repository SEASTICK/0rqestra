import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { APP_PORT, appSpec, containerName, extraInstallArgs, INSTALL_TIMEOUT_MS, installArgs, installKey, LABEL, publishedPort, READY_TIMEOUT_MS, RUN_LIMIT_MS, runArgs } from "./plan";
import { sourceFiles, syncFolder } from "./sync";
import { inside } from "../team/workspace";

// Starts and stops the apps the team built, each in its own locked container (plan.ts). One app per
// product; the window follows each through its states and sees the last lines of its log.

export type AppState = "stopped" | "preparing" | "installing" | "starting" | "running" | "failed";
export type DockerState = { state: "ready" | "not_installed" | "not_running"; message: string | null };

export interface AppStatus {
  state: AppState;
  message: string | null;
  port: number | null;
  startedAt: number | null;
  log: string[];
}

export interface DockerCli {
  available(): boolean;
  run(args: string[], options?: { timeoutMs?: number; onLine?: (line: string) => void }): Promise<{ code: number; out: string }>;
  runNow(args: string[], timeoutMs: number): void;
  follow(args: string[], onLine: (line: string) => void): { stop(): void };
}

export interface SandboxOptions {
  docker: DockerCli;
  // Where the copy of a product lives (outside the project folder).
  dirFor: (projectId: string, productId: string) => string;
  emit: (projectId: string, productId: string, status: AppStatus) => void;
  probe?: (port: number) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

const MAX_LOG = 200;
// Colour codes in the app's output (ESC [ … letter), removed for the window.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

export function probeHttp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

// On Linux the container's user (node) is not the owner of the copy, so the copy is opened to it.
function openToContainer(dir: string): void {
  if (process.platform !== "linux") return;
  const walk = (p: string) => {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(p);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    fs.chmodSync(p, stat.isDirectory() ? 0o777 : 0o666);
    if (stat.isDirectory()) for (const name of fs.readdirSync(p)) if (name !== "node_modules") walk(path.join(p, name));
  };
  walk(dir);
}

class Stopped extends Error {}

export class Sandbox {
  private apps = new Map<string, { projectId: string; productId: string; status: AppStatus; generation: number; logs: { stop(): void } | null; timer: NodeJS.Timeout | null }>();
  private readonly probe: (port: number) => Promise<boolean>;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly o: SandboxOptions) {
    this.probe = o.probe ?? probeHttp;
    this.now = o.now ?? Date.now;
    this.wait = o.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async dockerState(): Promise<DockerState> {
    if (!this.o.docker.available()) return { state: "not_installed", message: "Docker is not installed. Install Docker Desktop to run apps the team builds." };
    const r = await this.o.docker.run(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 }).catch(() => ({ code: 1, out: "" }));
    if (r.code !== 0 || !r.out.trim()) return { state: "not_running", message: "Docker is installed but not running. Start Docker Desktop and try again." };
    return { state: "ready", message: null };
  }

  status(projectId: string): Record<string, AppStatus> {
    const out: Record<string, AppStatus> = {};
    for (const a of this.apps.values()) if (a.projectId === projectId) out[a.productId] = { ...a.status, log: [...a.status.log] };
    return out;
  }

  private entry(projectId: string, productId: string) {
    const key = `${projectId}/${productId}`;
    let e = this.apps.get(key);
    if (!e) {
      e = { projectId, productId, status: { state: "stopped", message: null, port: null, startedAt: null, log: [] }, generation: 0, logs: null, timer: null };
      this.apps.set(key, e);
    }
    return e;
  }

  private set(e: ReturnType<Sandbox["entry"]>, patch: Partial<AppStatus>): void {
    e.status = { ...e.status, ...patch };
    this.o.emit(e.projectId, e.productId, { ...e.status, log: [...e.status.log] });
  }

  private line(e: ReturnType<Sandbox["entry"]>, line: string): void {
    const clean = line.replace(ANSI, "").replace(/\r/g, "").slice(0, 500);
    if (!clean.trim()) return;
    e.status.log = [...e.status.log, clean].slice(-MAX_LOG);
    this.o.emit(e.projectId, e.productId, { ...e.status, log: [...e.status.log] });
  }

  // Copies the product, installs its packages when they changed, starts it, and waits until it answers.
  async start(projectId: string, product: { id: string; folder: string }, workspace: string): Promise<AppStatus> {
    const e = this.entry(projectId, product.id);
    if (["preparing", "installing", "starting", "running"].includes(e.status.state)) return e.status;
    const generation = ++e.generation;
    const check = () => { if (e.generation !== generation) throw new Stopped(); };
    const name = containerName(projectId, product.id);
    this.set(e, { state: "preparing", message: "Checking Docker…", port: null, startedAt: null, log: [] });
    try {
      const docker = await this.dockerState();
      if (docker.state !== "ready") throw new Error(docker.message ?? "Docker is not available.");
      check();
      const src = product.folder ? path.join(workspace, ...product.folder.split("/")) : workspace;
      const files = sourceFiles(src);
      const pkgText = fs.readFileSync(inside(workspace, product.folder ? `${product.folder}/package.json` : "package.json"), "utf8");
      let pkg: unknown;
      try {
        pkg = JSON.parse(pkgText);
      } catch {
        throw new Error("package.json is not valid JSON.");
      }
      const spec = appSpec(pkg, files);
      if (!spec) throw new Error('package.json has no "dev" or "start" script, so there is nothing to start.');
      const base = this.o.dirFor(projectId, product.id);
      const appDir = path.join(base, "app");
      this.set(e, { message: "Copying the files…" });
      syncFolder(src, appDir);
      openToContainer(base);
      const lock = files.includes("package-lock.json") ? fs.readFileSync(inside(workspace, product.folder ? `${product.folder}/package-lock.json` : "package-lock.json"), "utf8") : null;
      const key = installKey(pkgText, lock);
      const marker = path.join(base, ".install-key");
      const installed = fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === key && fs.existsSync(path.join(appDir, "node_modules"));
      check();
      if (!installed) {
        this.set(e, { state: "installing", message: `Installing packages (npm ${spec.hasLock ? "ci" : "install"})…` });
        await this.o.docker.run(["rm", "-f", `${name}-install`], { timeoutMs: 30_000 }).catch(() => undefined);
        const r = await this.o.docker.run(installArgs(name, appDir, spec, extraInstallArgs(this.o.env ?? process.env)), { timeoutMs: INSTALL_TIMEOUT_MS, onLine: (l) => this.line(e, l) });
        check();
        if (r.code !== 0) throw new Error("Installing the packages failed. The log below says why.");
        fs.writeFileSync(marker, key);
      }
      this.set(e, { state: "starting", message: `Starting the app (npm run ${spec.script})…` });
      await this.o.docker.run(["rm", "-f", name], { timeoutMs: 30_000 }).catch(() => undefined);
      const started = await this.o.docker.run(runArgs(name, appDir, spec), { timeoutMs: 60_000 });
      check();
      if (started.code !== 0) throw new Error(`Docker could not start the app. ${started.out.trim().split(/\r?\n/).pop() ?? ""}`.trim());
      e.logs = this.o.docker.follow(["logs", "-f", name], (l) => this.line(e, l));
      const ports = await this.o.docker.run(["port", name, String(APP_PORT)], { timeoutMs: 15_000 });
      const port = publishedPort(ports.out);
      if (!port) throw new Error("The app's port could not be read from Docker.");
      const deadline = this.now() + READY_TIMEOUT_MS;
      while (!(await this.probe(port))) {
        check();
        const running = await this.o.docker.run(["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 15_000 }).catch(() => ({ code: 1, out: "" }));
        if (running.out.trim() !== "true") throw new Error("The app stopped while starting. The log below says why.");
        if (this.now() > deadline) throw new Error(`The app did not answer on port ${APP_PORT} within ${READY_TIMEOUT_MS / 1000} s. It must listen on process.env.PORT and host 0.0.0.0.`);
        await this.wait(1000);
      }
      check();
      e.timer = setTimeout(() => void this.stop(projectId, product.id, "Stopped after an hour to save your computer's resources. Start it again when you need it."), RUN_LIMIT_MS);
      e.timer.unref?.();
      this.set(e, { state: "running", message: null, port, startedAt: this.now() });
      return e.status;
    } catch (error) {
      if (error instanceof Stopped) return e.status;
      e.generation += 1;
      e.logs?.stop();
      e.logs = null;
      await this.o.docker.run(["rm", "-f", name], { timeoutMs: 30_000 }).catch(() => undefined);
      this.set(e, { state: "failed", message: error instanceof Error ? error.message : String(error), port: null });
      return e.status;
    }
  }

  // While an app runs, the team's changes reach its copy (dev servers reload them). When the packages
  // changed, the app is started again so they are installed.
  async sync(projectId: string, product: { id: string; folder: string }, workspace: string): Promise<"synced" | "restarted" | "not-running"> {
    const e = this.apps.get(`${projectId}/${product.id}`);
    if (!e || e.status.state !== "running") return "not-running";
    const src = product.folder ? path.join(workspace, ...product.folder.split("/")) : workspace;
    const base = this.o.dirFor(projectId, product.id);
    const pkgText = fs.readFileSync(inside(workspace, product.folder ? `${product.folder}/package.json` : "package.json"), "utf8");
    const lockRel = product.folder ? `${product.folder}/package-lock.json` : "package-lock.json";
    const lock = fs.existsSync(path.join(workspace, ...lockRel.split("/"))) ? fs.readFileSync(inside(workspace, lockRel), "utf8") : null;
    const marker = path.join(base, ".install-key");
    if (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8") !== installKey(pkgText, lock)) {
      await this.stop(projectId, product.id);
      await this.start(projectId, product, workspace);
      return "restarted";
    }
    syncFolder(src, path.join(base, "app"));
    openToContainer(base);
    return "synced";
  }

  async stop(projectId: string, productId: string, message: string | null = null): Promise<void> {
    const e = this.apps.get(`${projectId}/${productId}`);
    if (!e) return;
    e.generation += 1;
    e.logs?.stop();
    e.logs = null;
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    const name = containerName(projectId, productId);
    await Promise.all([name, `${name}-install`].map((n) => this.o.docker.run(["rm", "-f", n], { timeoutMs: 30_000 }).catch(() => undefined)));
    this.set(e, { state: "stopped", message, port: null, startedAt: null });
  }

  // Nothing keeps running after the app quits, and leftovers from a crash are removed at start.
  async stopAll(): Promise<void> {
    for (const e of this.apps.values()) {
      e.generation += 1;
      e.logs?.stop();
      if (e.timer) clearTimeout(e.timer);
    }
    await this.cleanup();
  }

  // A project removed from 0rqestra: its apps stop (the project's files stay).
  async stopProject(projectId: string): Promise<void> {
    const started = [...this.apps.values()].filter((e) => e.projectId === projectId && e.generation > 0 && e.status.state !== "stopped");
    await Promise.all(started.map((e) => this.stop(e.projectId, e.productId)));
  }

  stopAllNow(): void {
    const started = [...this.apps.values()].filter((e) => e.generation > 0);
    if (!started.length || !this.o.docker.available()) return;
    for (const e of started) {
      e.generation += 1;
      e.logs?.stop();
      if (e.timer) clearTimeout(e.timer);
    }
    const names = started.flatMap((e) => { const n = containerName(e.projectId, e.productId); return [n, `${n}-install`]; });
    this.o.docker.runNow(["rm", "-f", ...names], 5000);
  }

  async cleanup(): Promise<void> {
    if (!this.o.docker.available()) return;
    const r = await this.o.docker.run(["ps", "-aq", "--filter", `label=${LABEL}`], { timeoutMs: 15_000 }).catch(() => ({ code: 1, out: "" }));
    const ids = r.out.split(/\s+/).filter((id) => /^[0-9a-f]{6,64}$/.test(id));
    if (ids.length) await this.o.docker.run(["rm", "-f", ...ids], { timeoutMs: 30_000 }).catch(() => undefined);
  }
}
