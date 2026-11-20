import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Files and images the user adds to a chat message. The window hands over the bytes of a file the user
// picked, dropped or pasted; the main process decides what it is from its content (not its name),
// enforces the size limits, and keeps it in `<user data>/attachments` for the reply that uses it.

export type AttachmentKind = "image" | "pdf" | "text";

export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mediaType: string;
  size: number;
  path: string;
}

export const LIMITS: Record<AttachmentKind, number> = { image: 5_000_000, pdf: 10_000_000, text: 300_000 };
export const MAX_PER_MESSAGE = 6;
const ID = /^[0-9a-f]{24}$/;

const starts = (b: Uint8Array, bytes: number[], at = 0) => bytes.every((v, i) => b[at + i] === v);

export function detect(bytes: Uint8Array): { kind: AttachmentKind; mediaType: string; ext: string } | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mediaType: "image/png", ext: "png" };
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", mediaType: "image/jpeg", ext: "jpg" };
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) return { kind: "image", mediaType: "image/gif", ext: "gif" };
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { kind: "image", mediaType: "image/webp", ext: "webp" };
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: "pdf", mediaType: "application/pdf", ext: "pdf" };
  // Text: valid UTF-8 without NUL bytes (code, notes, CSV, JSON, Markdown…).
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return { kind: "text", mediaType: "text/plain", ext: "txt" };
}

export function cleanName(name: unknown): string {
  const text = typeof name === "string" ? [...name].filter((c) => c >= " " && c !== "\u007f").join("").replace(/[\\/]/g, "_").trim() : "";
  return (text || "file").slice(0, 120);
}

export class AttachmentStore {
  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {}

  add(raw: unknown): Omit<Attachment, "path"> {
    const v = (raw ?? {}) as Record<string, unknown>;
    const data = v.data instanceof Uint8Array ? v.data : null;
    if (!data || data.length === 0) throw new Error("The file is empty.");
    const found = detect(data);
    if (!found) throw new Error("This kind of file cannot be attached. Images (PNG, JPEG, GIF, WebP), PDFs and text files work.");
    if (data.length > LIMITS[found.kind]) throw new Error(`The file is too large: at most ${Math.round(LIMITS[found.kind] / 1_000_000 * 10) / 10} MB for ${found.kind === "text" ? "text files" : found.kind === "pdf" ? "PDFs" : "images"}.`);
    fs.mkdirSync(this.dir, { recursive: true });
    const id = crypto.randomBytes(12).toString("hex");
    const name = cleanName(v.name);
    fs.writeFileSync(path.join(this.dir, `${id}.${found.ext}`), data);
    fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify({ name, kind: found.kind, mediaType: found.mediaType, size: data.length, ext: found.ext, at: this.now() }));
    return { id, name, kind: found.kind, mediaType: found.mediaType, size: data.length };
  }

  get(id: unknown): Attachment | null {
    if (typeof id !== "string" || !ID.test(id)) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8")) as { name: string; kind: AttachmentKind; mediaType: string; size: number; ext: string };
      const file = path.join(this.dir, `${id}.${meta.ext}`);
      if (!/^(png|jpg|gif|webp|pdf|txt)$/.test(meta.ext) || !fs.lstatSync(file).isFile()) return null;
      return { id, name: meta.name, kind: meta.kind, mediaType: meta.mediaType, size: meta.size, path: file };
    } catch {
      return null;
    }
  }

  // Attachments are kept for a week, then removed.
  prune(maxAgeMs = 7 * 24 * 3600_000): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const id = name.slice(0, -5);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")) as { at: number; ext: string };
        if (this.now() - meta.at > maxAgeMs) {
          fs.rmSync(path.join(this.dir, name), { force: true });
          if (/^(png|jpg|gif|webp|pdf|txt)$/.test(meta.ext)) fs.rmSync(path.join(this.dir, `${id}.${meta.ext}`), { force: true });
        }
      } catch {
        fs.rmSync(path.join(this.dir, name), { force: true });
      }
    }
  }
}

// Text files go into the message itself; the tools get images (and PDFs, for Claude) as such.
export function withTextFiles(text: string, attachments: Attachment[]): string {
  const texts = attachments.filter((a) => a.kind === "text");
  if (!texts.length) return text;
  const blocks = texts.map((a) => `Attached file "${a.name}":\n\`\`\`\n${fs.readFileSync(a.path, "utf8")}\n\`\`\``);
  return `${text}\n\n${blocks.join("\n\n")}`;
}
