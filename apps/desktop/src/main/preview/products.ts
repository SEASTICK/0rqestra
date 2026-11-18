import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeRelativePath } from "../team/plan";
import { inside, listFiles } from "../team/workspace";

// Products are what the team builds in a project's folder. For now a product is a web page: a folder
// with an index.html (or, failing that, the shallowest .html file). The tree shows each product as a
// node, and the preview shows it through the orqestra-preview scheme below. Nothing here runs the
// agents' code: the preview is an isolated frame in the window, with no Node.js, no keys and no network.

export const PREVIEW_SCHEME = "orqestra-preview";
export const MAX_PRODUCTS = 12;
export const MAX_PREVIEW_BYTES = 20_000_000;

export interface Product {
  id: string;
  folder: string;
  entry: string;
  name: string;
  kind: "web";
  files: string[];
  updatedAt: number;
}

const depth = (file: string) => file.split("/").length;
const byDepth = (a: string, b: string) => depth(a) - depth(b) || a.localeCompare(b);
const folderOf = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");
const within = (file: string, folder: string) => folder === "" || file.startsWith(`${folder}/`);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

export function titleOf(html: string): string | null {
  const match = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html.slice(0, 20_000));
  if (!match) return null;
  const text = match[1]!.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e] ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 60) : null;
}

export function findProducts(root: string): Product[] {
  const files = listFiles(root, 500);
  const html = files.filter((f) => /\.html?$/i.test(f)).sort(byDepth);
  let entries = html.filter((f) => /^index\.html?$/i.test(f.split("/").pop()!));
  if (!entries.length && html.length) entries = [html[0]!];
  const chosen: { folder: string; entry: string }[] = [];
  for (const entry of entries) {
    const folder = folderOf(entry);
    // A page inside another product's folder is part of that product.
    if (chosen.some((c) => within(entry, c.folder))) continue;
    chosen.push({ folder, entry });
    if (chosen.length >= MAX_PRODUCTS) break;
  }
  return chosen.map(({ folder, entry }) => {
    const own = files.filter((f) => within(f, folder));
    let updatedAt = 0;
    for (const f of own) {
      try {
        updatedAt = Math.max(updatedAt, fs.statSync(path.join(root, ...f.split("/"))).mtimeMs);
      } catch {
        // A file that disappeared meanwhile does not count.
      }
    }
    let name: string | null;
    try {
      name = titleOf(fs.readFileSync(inside(root, entry), "utf8"));
    } catch {
      name = null;
    }
    return {
      id: folder || "root",
      folder,
      entry,
      name: name ?? (folder ? folder.split("/").pop()! : "Web page"),
      kind: "web" as const,
      files: own.slice(0, 200),
      updatedAt: Math.round(updatedAt),
    };
  });
}

// Each project gets its own host, so pages from different projects never share an origin or storage.
// Host names are lowercase, so the id is hashed rather than used as it is.
export function previewHost(projectId: string): string {
  return `p${crypto.createHash("sha256").update(projectId).digest("hex").slice(0, 31)}`;
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  wasm: "application/wasm",
};

export function contentType(file: string): string {
  const ext = file.includes(".") ? file.slice(file.lastIndexOf(".") + 1).toLowerCase() : "";
  return TYPES[ext] ?? "application/octet-stream";
}

// The page may use its own files and inline code, nothing from the network: no other site, no
// forms sent anywhere, and no way to reach the app around it (the frame has another origin).
export const PREVIEW_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join("; ");

export const PREVIEW_HEADERS = {
  "Content-Security-Policy": PREVIEW_CSP,
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
};

export type PreviewAnswer = { status: 200; file: string; type: string } | { status: 400 | 404; reason: string };

// Maps a preview URL to a file inside the right project's folder, or refuses it.
export function resolvePreview(url: string, workspaceForHost: (host: string) => string | null): PreviewAnswer {
  if (!URL.canParse(url)) return { status: 400, reason: "Not a URL." };
  const parsed = new URL(url);
  if (parsed.protocol !== `${PREVIEW_SCHEME}:`) return { status: 400, reason: "Wrong scheme." };
  const root = workspaceForHost(parsed.hostname);
  if (!root) return { status: 404, reason: "Unknown project." };
  let rel: string;
  try {
    rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  } catch {
    return { status: 400, reason: "Bad path." };
  }
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  if (!safeRelativePath(rel)) return { status: 404, reason: "Not a project file." };
  try {
    const file = inside(root, rel);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES) return { status: 404, reason: "Not a project file." };
    return { status: 200, file, type: contentType(rel) };
  } catch {
    return { status: 404, reason: "Not a project file." };
  }
}
