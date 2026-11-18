import fs from "node:fs";
import path from "node:path";

// The catch-up messages shown in the Manager chat, kept by the main process in a file that is
// flushed to disk before the app records them as seen in Supabase (Teams phase 4).
//
// Found while verifying phases 1-5: the chat itself lives in the window's local storage, which
// Chromium writes to disk with a delay. If the app crashed or was force-closed right after a
// catch-up appeared, the message could be lost while Supabase already counted it as seen, so the
// user would never see that update. With this log the message is durable first, and the window
// adds back any kept catch-up its chat is missing at startup.

export interface KeptCatchUp {
  localProjectId: string;
  message: { id: string; kind: "teamInfo"; infoType: "catch-up"; sharedProjectId: string; at: number; text: string };
}

const KEEP_MS = 30 * 24 * 3600_000;
const MAX_ENTRIES = 200;
const LOCAL_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MESSAGE_ID = /^team-catchup-[0-9a-f-]{36}-[0-9a-z]{1,16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseKept(localProjectId: unknown, raw: unknown): KeptCatchUp {
  const m = (raw ?? {}) as Record<string, unknown>;
  if (typeof localProjectId !== "string" || !LOCAL_ID.test(localProjectId)) throw new Error("Invalid project.");
  if (typeof m.id !== "string" || !MESSAGE_ID.test(m.id)) throw new Error("Invalid catch-up message.");
  if (typeof m.sharedProjectId !== "string" || !UUID.test(m.sharedProjectId)) throw new Error("Invalid catch-up message.");
  if (typeof m.text !== "string" || !m.text.trim() || m.text.length > 8000) throw new Error("Invalid catch-up message.");
  const at = typeof m.at === "number" && Number.isFinite(m.at) ? m.at : Date.now();
  return { localProjectId, message: { id: m.id, kind: "teamInfo", infoType: "catch-up", sharedProjectId: m.sharedProjectId, at, text: m.text } };
}

export class CatchUpLog {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  all(): KeptCatchUp[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8")) as { kept?: unknown };
      if (!Array.isArray(v.kept)) return [];
      const cutoff = this.now() - KEEP_MS;
      return v.kept.flatMap((k: { localProjectId?: unknown; message?: unknown }) => {
        try {
          const parsed = parseKept(k.localProjectId, k.message);
          return parsed.message.at >= cutoff ? [parsed] : [];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  // Adds a catch-up (once per message id) and returns only after the file is flushed to disk.
  keep(entry: KeptCatchUp): void {
    const kept = this.all().filter((k) => !(k.message.id === entry.message.id && k.localProjectId === entry.localProjectId));
    kept.push(entry);
    const data = JSON.stringify({ version: 1, kept: kept.slice(-MAX_ENTRIES) });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }
}
