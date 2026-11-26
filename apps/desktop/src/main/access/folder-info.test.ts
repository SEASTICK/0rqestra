import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessService } from "./access-service.js";
import { AccessStore } from "./access-store.js";
import { folderOutline, suggestedChecks } from "./folder-info.js";

let dir: string;
let repo: string;
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "orq-folder-")));
  repo = path.join(dir, "app");
  fs.mkdirSync(path.join(repo, "src", "ui"), { recursive: true });
  fs.mkdirSync(path.join(repo, "node_modules", "react"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "main.ts"), "secret content");
  fs.writeFileSync(path.join(repo, "README.md"), "# App");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { dev: "vite", test: "vitest", lint: "eslint .", check: "npm run lint && npm test" } }));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the folder a project works on", () => {
  it("names files two levels deep, without their contents, and skips .git and node_modules", () => {
    const outline = folderOutline(repo);
    expect(outline).toContain("src/");
    expect(outline).toContain("  src/main.ts");
    expect(outline).toContain("  src/ui/");
    expect(outline).toContain("README.md");
    expect(outline.join("\n")).not.toMatch(/node_modules|\.git|secret content/);
  });

  it("suggests the checks the folder's own setup has, and nothing else", () => {
    expect(suggestedChecks(repo).map((c) => c.command)).toEqual(["npm run check", "npm run lint", "npm run test"]);
    expect(suggestedChecks(path.join(repo, "src"))).toEqual([]);
  });

  it("tells the Manager about the folder, and keeps files waiting to be applied across a restart", () => {
    const store = new AccessStore(path.join(dir, "data"));
    const ledgerDir = path.join(dir, "data", "changes");
    const workspace = path.join(dir, "ws");
    fs.mkdirSync(workspace);
    const service = new AccessService(store, () => workspace, () => {}, () => null, { ledgerDir });
    expect(service.overview("p1")).toBeNull();
    const folder = store.addFolder("p1", repo).folders[0]!;
    const text = service.overview("p1")!;
    expect(text).toContain(repo);
    expect(text).toContain("  src/main.ts");
    expect(text).toContain("(read only)");
    service.recordFiles("p1", "r1", "t1", "builder", "Bob", ["README.md"]);
    const again = new AccessService(store, () => workspace, () => {}, () => null, { ledgerDir });
    expect(again.pendingFiles("p1")).toEqual([{ path: "README.md", agentKey: "builder", agentName: "Bob", taskId: "t1", runId: "r1" }]);
    again.forgetProject("p1");
    expect(new AccessService(store, () => workspace, () => {}, () => null, { ledgerDir }).pendingFiles("p1")).toEqual([]);
    void folder;
  });
});
