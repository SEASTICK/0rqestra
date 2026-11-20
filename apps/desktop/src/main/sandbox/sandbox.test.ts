import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appSpec, containerName, extraInstallArgs, installArgs, installKey, publishedPort, runArgs } from "./plan.js";
import { Sandbox, type AppStatus, type DockerCli } from "./sandbox.js";
import { sourceFiles, syncFolder } from "./sync.js";
import { appHost, proxiedHeaders, proxyToApp } from "../preview/app-proxy.js";
import { findProducts } from "../preview/products.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-sandbox-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (rel: string, content: string) => { const f = path.join(dir, ...rel.split("/")); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };

describe("what runs, and how it is locked", () => {
  it("starts dev, then start, and nothing without a script", () => {
    expect(appSpec({ scripts: { start: "node s.js", dev: "vite" } }, ["package-lock.json"])).toEqual({ script: "dev", hasLock: true });
    expect(appSpec({ scripts: { start: "node s.js" } }, [])).toEqual({ script: "start", hasLock: false });
    expect(appSpec({ scripts: { build: "x" } }, [])).toBeNull();
    expect(appSpec(null, [])).toBeNull();
  });

  it("locks the container: no root, no capabilities, limits, a copy of the files, the port on loopback only", () => {
    const args = runArgs("orqestra-abc", "/data/copy/app", { script: "start", hasLock: false });
    const joined = args.join(" ");
    for (const part of ["--cap-drop ALL", "--security-opt no-new-privileges", "--user node", "--memory 1g", "--cpus 1", "--pids-limit 256", "-p 127.0.0.1::3000", "-v /data/copy/app:/app", "npm run start"]) expect(joined).toContain(part);
    // Nothing from this computer's environment: every -e is a fixed value.
    const env = args.flatMap((a, i) => (args[i - 1] === "-e" ? [a] : []));
    expect(env.every((e) => /^(HOME|npm_config_[a-z_]+|PORT|HOST|NODE_ENV)=/.test(e))).toBe(true);
    expect(joined).not.toMatch(/--privileged|docker\.sock|--network host|-v \/:/);
    const install = installArgs("orqestra-abc", "/data/copy/app", { script: "dev", hasLock: true }).join(" ");
    expect(install).toContain("npm ci");
    expect(installArgs("n", "/a", { script: "dev", hasLock: false }).join(" ")).toContain("npm install");
  });

  it("reads the published port, names containers, and keys installs on the package files", () => {
    expect(publishedPort("127.0.0.1:49153\n")).toBe(49153);
    expect(publishedPort("[::1]:5000\n127.0.0.1:5001")).toBe(5001);
    expect(publishedPort("Error: no public port")).toBeNull();
    expect(containerName("p1", "web")).toMatch(/^orqestra-[0-9a-f]{16}$/);
    expect(containerName("p1", "web")).not.toBe(containerName("p1", "api"));
    expect(installKey("{}", null)).not.toBe(installKey("{}", "lock"));
    expect(extraInstallArgs({ ORQESTRA_SANDBOX_INSTALL_ARGS: '["--network","host"]' })).toEqual(["--network", "host"]);
    expect(extraInstallArgs({ ORQESTRA_SANDBOX_INSTALL_ARGS: "nope" })).toEqual([]);
    expect(extraInstallArgs({})).toEqual([]);
  });
});

describe("the copy", () => {
  it("follows the source, keeps node_modules, and never copies links", () => {
    write("src/a.js", "a");
    write("package.json", "{}");
    write("node_modules/x/i.js", "skip");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orq-out-"));
    fs.writeFileSync(path.join(outside, "secret"), "s");
    fs.symlinkSync(path.join(outside, "secret"), path.join(dir, "link"));
    const dest = path.join(dir, "..", `${path.basename(dir)}-copy`);
    try {
      expect(sourceFiles(dir).sort()).toEqual(["package.json", "src/a.js"]);
      expect(syncFolder(dir, dest).sort()).toEqual(["package.json", "src/a.js"]);
      fs.mkdirSync(path.join(dest, "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(dest, "node_modules", "kept"), "k");
      fs.rmSync(path.join(dir, "src", "a.js"));
      write("src/b.js", "b");
      expect(syncFolder(dir, dest)).toEqual(["src/b.js"]);
      expect(fs.existsSync(path.join(dest, "src", "a.js"))).toBe(false);
      expect(fs.existsSync(path.join(dest, "node_modules", "kept"))).toBe(true);
      expect(fs.existsSync(path.join(dest, "link"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});

class FakeDocker implements DockerCli {
  calls: string[][] = [];
  constructor(private readonly opts: { available?: boolean; daemon?: boolean; installCode?: number; running?: boolean } = {}) {}
  available() { return this.opts.available ?? true; }
  async run(args: string[], options: { onLine?: (l: string) => void } = {}) {
    this.calls.push(args);
    if (args[0] === "version") return { code: this.opts.daemon === false ? 1 : 0, out: this.opts.daemon === false ? "" : "29.0" };
    if (args[0] === "run" && args.includes("--rm") && !args.includes("-d")) { options.onLine?.("added 3 packages"); return { code: this.opts.installCode ?? 0, out: "" }; }
    if (args[0] === "run") return { code: 0, out: "abc123\n" };
    if (args[0] === "port") return { code: 0, out: "127.0.0.1:41234\n" };
    if (args[0] === "inspect") return { code: 0, out: this.opts.running === false ? "false" : "true" };
    if (args[0] === "ps") return { code: 0, out: "aaaaaa\nbbbbbb\n" };
    return { code: 0, out: "" };
  }
  runNow(args: string[]) { this.calls.push(args); }
  follow(_args: string[], onLine: (l: string) => void) { onLine("\u001b[32mlistening on 3000\u001b[0m"); return { stop() {} }; }
}

describe("the sandbox", () => {
  const setup = (docker: FakeDocker, probe: () => Promise<boolean> = async () => true) => {
    const events: AppStatus[] = [];
    write("ws/app/package.json", JSON.stringify({ name: "logg", scripts: { start: "node server.js" } }));
    write("ws/app/server.js", "x");
    const sandbox = new Sandbox({ docker, dirFor: (p, id) => path.join(dir, "sb", p, id), emit: (_p, _id, s) => events.push(s), probe, env: {}, wait: async () => {} });
    return { sandbox, events, ws: path.join(dir, "ws") };
  };

  it("copies, installs once, starts, and reports the port when the app answers", async () => {
    const docker = new FakeDocker();
    const { sandbox, events, ws } = setup(docker);
    const status = await sandbox.start("p1", { id: "app", folder: "app" }, ws);
    expect(status).toMatchObject({ state: "running", port: 41234 });
    expect(events.map((e) => e.state)).toEqual(expect.arrayContaining(["preparing", "installing", "starting", "running"]));
    expect(status.log).toEqual(["added 3 packages", "listening on 3000"]);
    expect(fs.readFileSync(path.join(dir, "sb", "p1", "app", "app", "server.js"), "utf8")).toBe("x");
    await sandbox.stop("p1", "app");
    fs.mkdirSync(path.join(dir, "sb", "p1", "app", "app", "node_modules"));
    docker.calls = [];
    await sandbox.start("p1", { id: "app", folder: "app" }, ws);
    expect(docker.calls.some((c) => c[0] === "run" && c.includes("npm") && c.includes("install"))).toBe(false);
    expect(sandbox.status("p1").app!.state).toBe("running");
  });

  it("says plainly when Docker is missing or not running, and when installing fails", async () => {
    expect((await setup(new FakeDocker({ available: false })).sandbox.start("p1", { id: "app", folder: "app" }, path.join(dir, "ws"))).message).toMatch(/not installed/);
    expect((await setup(new FakeDocker({ daemon: false })).sandbox.start("p1", { id: "app", folder: "app" }, path.join(dir, "ws"))).message).toMatch(/not running/);
    expect((await setup(new FakeDocker({ installCode: 1 })).sandbox.start("p1", { id: "app", folder: "app" }, path.join(dir, "ws")))).toMatchObject({ state: "failed", message: expect.stringMatching(/Installing the packages failed/) });
  });

  it("notices an app that stops while starting", async () => {
    const { sandbox, ws } = setup(new FakeDocker({ running: false }), async () => false);
    expect(await sandbox.start("p1", { id: "app", folder: "app" }, ws)).toMatchObject({ state: "failed", message: expect.stringMatching(/stopped while starting/) });
  });

  it("refuses a package.json that is a link out of the project", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orq-out-"));
    try {
      fs.writeFileSync(path.join(outside, "package.json"), JSON.stringify({ scripts: { start: "x" } }));
      fs.mkdirSync(path.join(dir, "ws2", "evil"), { recursive: true });
      fs.symlinkSync(path.join(outside, "package.json"), path.join(dir, "ws2", "evil", "package.json"));
      const { sandbox } = setup(new FakeDocker());
      expect(await sandbox.start("p1", { id: "evil", folder: "evil" }, path.join(dir, "ws2"))).toMatchObject({ state: "failed" });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("removes its containers when the app quits and after a crash", async () => {
    const docker = new FakeDocker();
    const { sandbox, ws } = setup(docker);
    await sandbox.start("p1", { id: "app", folder: "app" }, ws);
    docker.calls = [];
    sandbox.stopAllNow();
    expect(docker.calls[0]).toEqual(["rm", "-f", containerName("p1", "app"), `${containerName("p1", "app")}-install`]);
    docker.calls = [];
    await sandbox.cleanup();
    expect(docker.calls.at(-1)).toEqual(["rm", "-f", "aaaaaa", "bbbbbb"]);
  });
});

describe("apps in the preview", () => {
  it("finds apps by their package.json, with their pages inside them", () => {
    write("ws/server/package.json", JSON.stringify({ name: "logg-api", scripts: { dev: "node s.js" } }));
    write("ws/server/index.html", "<title>Inside</title>");
    write("ws/site/index.html", "<title>Site</title>");
    write("ws/lib/package.json", JSON.stringify({ name: "lib" }));
    const products = findProducts(path.join(dir, "ws"));
    expect(products.map((p) => [p.id, p.kind, p.entry, p.name])).toEqual([
      ["server", "app", "server/index.html", "Inside"],
      ["site", "web", "site/index.html", "Site"],
    ]);
  });

  it("passes requests to the app's port only, and keeps the preview's rules", async () => {
    expect(appHost("p1", "web")).toMatch(/^a[0-9a-f]{31}$/);
    const seen: string[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url}`);
      return new Response("<html><body>Hi</body></html>", { status: 200, headers: { "content-type": "text/html", "content-security-policy": "default-src *", "content-encoding": "gzip", "x-app": "1" } });
    }) as unknown as typeof fetch;
    const res = await proxyToApp(new Request("orqestra-preview://ahost/list?x=1"), 41234, fetcher);
    expect(seen).toEqual(["GET http://127.0.0.1:41234/list?x=1"]);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("x-app")).toBe("1");
    expect(await res.text()).toContain("__orqestra/picker.js");
    const down = await proxyToApp(new Request("orqestra-preview://ahost/"), 1, (async () => { throw new Error("refused"); }) as unknown as typeof fetch);
    expect(down.status).toBe(502);
  });

  it("keeps redirects to the app inside the preview", () => {
    const h = proxiedHeaders(new Headers({ location: "http://127.0.0.1:41234/login" }), 41234);
    expect(h.get("location")).toBe("/login");
    expect(proxiedHeaders(new Headers({ location: "https://elsewhere.example/" }), 1).get("location")).toBe("https://elsewhere.example/");
  });
});
