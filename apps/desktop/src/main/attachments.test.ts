import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStore, cleanName, detect, withTextFiles } from "./attachments.js";
import { claudeContent } from "./providers/claude-code.js";
import { codexInput } from "./providers/codex.js";
import { parseSend } from "./chat-service.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "orq-att-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const pdf = new TextEncoder().encode("%PDF-1.7\nhello");
const text = new TextEncoder().encode("namn,kcal\nÄgg,155\n");

describe("attachments", () => {
  it("knows a file by its content, not its name", () => {
    expect(detect(png)).toMatchObject({ kind: "image", mediaType: "image/png" });
    expect(detect(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toMatchObject({ mediaType: "image/jpeg" });
    expect(detect(pdf)).toMatchObject({ kind: "pdf" });
    expect(detect(text)).toMatchObject({ kind: "text" });
    expect(detect(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBeNull();
    expect(detect(new Uint8Array([0xc3, 0x28]))).toBeNull();
  });

  it("keeps files with a clean name, refuses the wrong kind or size, and finds them by id only", () => {
    const store = new AttachmentStore(dir);
    const meta = store.add({ name: "../../bild\u0007.png", data: png });
    expect(meta).toMatchObject({ name: ".._.._bild.png", kind: "image", size: 11 });
    expect(store.get(meta.id)).toMatchObject({ kind: "image", path: path.join(dir, `${meta.id}.png`) });
    expect(store.get("../../etc/passwd")).toBeNull();
    expect(store.get("0".repeat(24))).toBeNull();
    expect(() => store.add({ name: "a.exe", data: new Uint8Array([0x4d, 0x5a, 0, 0]) })).toThrow(/cannot be attached/);
    expect(() => store.add({ name: "big.txt", data: new Uint8Array(300_001).fill(65) })).toThrow(/too large/);
    expect(() => store.add({ name: "e", data: new Uint8Array() })).toThrow(/empty/);
    expect(() => store.add({ name: "x", data: "not bytes" })).toThrow(/empty/);
    expect(cleanName("")).toBe("file");
  });

  it("removes attachments after a week", () => {
    let t = 0;
    const store = new AttachmentStore(dir, () => t);
    const meta = store.add({ name: "a.txt", data: text });
    t = 8 * 24 * 3600_000;
    store.prune();
    expect(store.get(meta.id)).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("gives Claude images and PDFs as blocks, Codex images as files, and both text files in the text", () => {
    const store = new AttachmentStore(dir);
    const all = [store.add({ name: "bild.png", data: png }), store.add({ name: "kurs.pdf", data: pdf }), store.add({ name: "mat.csv", data: text })].map((m) => store.get(m.id)!);
    const claude = claudeContent("Hjälp mig", all) as { type: string; text?: string; source?: { media_type: string } }[];
    expect(claude.map((b) => b.type)).toEqual(["text", "image", "document"]);
    expect(claude[0]!.text).toContain('Attached file "mat.csv":\n```\nnamn,kcal');
    expect(claude[1]!.source!.media_type).toBe("image/png");
    expect(claudeContent("Bara text", [])).toBe("Bara text");
    const codex = codexInput("Hjälp mig", all) as { type: string; text?: string; path?: string }[];
    expect(codex.map((b) => b.type)).toEqual(["text", "localImage"]);
    expect(codex[0]!.text).toContain("PDFs cannot be read here");
    expect(codex[1]!.path).toBe(all[0]!.path);
    expect(withTextFiles("x", [])).toBe("x");
  });

  it("accepts at most six attachment ids in a chat request", () => {
    const base = { requestId: "req-00001", projectId: "p1", provider: "claude", model: null, effort: null, text: "hej", history: [] };
    expect(parseSend({ ...base, attachments: ["a".repeat(24)] }).attachments).toEqual(["a".repeat(24)]);
    expect(() => parseSend({ ...base, attachments: Array(7).fill("a") })).toThrow(/attachments/);
    expect(() => parseSend({ ...base, attachments: [5] })).toThrow(/attachments/);
  });
});
