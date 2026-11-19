import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentType, findProducts, PREVIEW_CSP, previewHost, resolvePreview, titleOf } from "./products.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-products-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(rel: string, content: string) {
  const full = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("products", () => {
  it("finds no product in an empty folder", () => {
    expect(findProducts(dir)).toEqual([]);
  });

  it("makes one product of a root index.html, named by its title, with every file", () => {
    write("index.html", "<html><head><title>Träningslogg &amp; mer</title></head></html>");
    write("css/style.css", "body{}");
    write("admin/index.html", "<title>Admin</title>");
    const [product, ...rest] = findProducts(dir);
    expect(rest).toEqual([]);
    expect(product).toMatchObject({ id: "root", folder: "", entry: "index.html", name: "Träningslogg & mer", kind: "web" });
    expect(product!.files.sort()).toEqual(["admin/index.html", "css/style.css", "index.html"]);
    expect(product!.updatedAt).toBeGreaterThan(0);
  });

  it("makes one product per folder with its own index.html", () => {
    write("web/index.html", "<title>Web app</title>");
    write("web/app.js", "");
    write("landing/index.htm", "no title");
    write("notes.md", "");
    const products = findProducts(dir);
    expect(products.map((p) => [p.id, p.entry, p.name])).toEqual([
      ["landing", "landing/index.htm", "landing"],
      ["web", "web/index.html", "Web app"],
    ]);
    expect(products[1]!.files.sort()).toEqual(["web/app.js", "web/index.html"]);
  });

  it("uses the shallowest page when there is no index.html", () => {
    write("pages/deep/a.html", "");
    write("pages/start.html", "");
    expect(findProducts(dir).map((p) => p.entry)).toEqual(["pages/start.html"]);
  });

  it("skips links", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orq-outside-"));
    fs.writeFileSync(path.join(outside, "index.html"), "<title>Secret</title>");
    try {
      fs.symlinkSync(outside, path.join(dir, "linked"), "dir");
      expect(findProducts(dir)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reads titles carefully", () => {
    expect(titleOf("<title>  A  \n b </title>")).toBe("A b");
    expect(titleOf("<title></title>")).toBeNull();
    expect(titleOf("<h1>No</h1>")).toBeNull();
    expect(titleOf(`<title>${"x".repeat(100)}</title>`)).toHaveLength(60);
  });
});

describe("preview requests", () => {
  const host = previewHost("project-1");
  const lookup = (h: string) => (h === host ? dir : null);

  it("gives each project its own lowercase host", () => {
    expect(host).toMatch(/^p[0-9a-f]{31}$/);
    expect(previewHost("Project-1")).not.toBe(host);
  });

  it("serves the project's own files with the right type", () => {
    write("index.html", "<p>hi</p>");
    write("css/style.css", "");
    expect(resolvePreview(`orqestra-preview://${host}/`, lookup)).toMatchObject({ status: 200, type: "text/html; charset=utf-8" });
    expect(resolvePreview(`orqestra-preview://${host}/css/style.css?v=3`, lookup)).toMatchObject({ status: 200, file: path.join(dir, "css", "style.css"), type: "text/css; charset=utf-8" });
  });

  it("refuses other schemes, unknown projects, missing files and paths out of the folder", () => {
    write("index.html", "");
    expect(resolvePreview(`file:///${dir}/index.html`, lookup).status).toBe(400);
    expect(resolvePreview("orqestra-preview://pnope/index.html", lookup).status).toBe(404);
    expect(resolvePreview(`orqestra-preview://${host}/missing.html`, lookup).status).toBe(404);
    expect(resolvePreview(`orqestra-preview://${host}/%2e%2e/secret.txt`, lookup).status).toBe(404);
    expect(resolvePreview(`orqestra-preview://${host}/a/%2e%2e%2f%2e%2e/secret.txt`, lookup).status).toBe(404);
    expect(resolvePreview(`orqestra-preview://${host}/.env`, lookup).status).toBe(404);
    expect(resolvePreview(`orqestra-preview://${host}/%E0%A4%A`, lookup).status).toBe(400);
  });

  it("refuses files reached through a link", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orq-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    try {
      fs.symlinkSync(outside, path.join(dir, "linked"), "dir");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "secret.txt"));
      expect(resolvePreview(`orqestra-preview://${host}/linked/secret.txt`, lookup).status).toBe(404);
      expect(resolvePreview(`orqestra-preview://${host}/secret.txt`, lookup).status).toBe(404);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("knows common types and blocks the network in the page", () => {
    expect(contentType("a.JS")).toBe("text/javascript; charset=utf-8");
    expect(contentType("a.exe")).toBe("application/octet-stream");
    expect(PREVIEW_CSP).toContain("default-src 'self'");
    expect(PREVIEW_CSP).toContain("form-action 'none'");
    expect(PREVIEW_CSP).not.toMatch(/https?:/);
  });
});
