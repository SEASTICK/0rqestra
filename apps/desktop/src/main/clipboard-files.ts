import { fileURLToPath } from "node:url";

// Files the user copied in Explorer, Finder or a Linux file manager and then pasted into the chat. The
// browser part of the window does not always see them, so the main process reads the clipboard's own
// formats: "FileNameW" on Windows (UTF-16 paths, each ending in NUL), file:// URLs on macOS and Linux.

export const MAX_PASTED_FILES = 6;

export function windowsFileNames(buffer: Buffer | Uint8Array | null | undefined): string[] {
  if (!buffer || buffer.length < 2) return [];
  const text = Buffer.from(buffer).toString("utf16le");
  return text.split("\0").map((s) => s.trim()).filter((s) => /^([a-zA-Z]:\\|\\\\)/.test(s)).slice(0, MAX_PASTED_FILES);
}

export function fileUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const v = line.trim();
    if (!v.startsWith("file://")) continue;
    try {
      out.push(fileURLToPath(v));
    } catch {
      /* not a local file */
    }
  }
  return out.slice(0, MAX_PASTED_FILES);
}
