import zlib from "node:zlib";

// The chats in a data export from Claude or ChatGPT, kept in the main process while the user looks through
// them in "Import chat": a list with titles and dates, a search over titles and over the text of the
// messages, and then only the chosen chats go to the window. Claude and ChatGPT give no other way to read
// the chats (there is no public interface for a person's chat history, and 0rqestra does not use a login
// cookie or token to reach one), so the user asks them for their data export once, and picks the file here:
// the .zip they email as it is, or the conversations.json inside it.

export interface LibraryMessage {
  role: "user" | "assistant";
  text: string;
  label?: string;
}

export interface LibraryChat {
  title: string;
  at: number | null;
  messages: LibraryMessage[];
}

export interface LibraryItem {
  id: number;
  title: string;
  at: number | null;
  count: number;
  preview: string;
}

export interface LibraryHit extends LibraryItem {
  // Where the search words were found: the title, or a piece of a message.
  snippet: string | null;
}

export type LibrarySource = "Claude" | "ChatGPT";

export const MAX_FILE_BYTES = 1_000_000_000;
export const MAX_JSON_BYTES = 500_000_000;
export const MAX_MESSAGES = 300;
export const MAX_MESSAGE_CHARS = 30_000;
export const MAX_PICK = 100;

const clean = (text: unknown): string => String(text ?? "").replace(/\r\n?/g, "\n").split(String.fromCharCode(0)).join("").trim();

// ---- zip (stored and deflate; no zip64) -----------------------------------------------------------

export interface ZipEntry {
  name: string;
  data: Buffer;
}

// Reads the entries of a zip whose name passes `wanted`. Sizes are checked against `maxBytes` before and while
// unpacking, so a damaged or hostile file cannot fill the memory.
export function readZip(buffer: Buffer, wanted: (name: string) => boolean, maxBytes = MAX_JSON_BYTES): ZipEntry[] {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65_535); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This is not a zip file.");
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  const offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error("This zip file is too large for 0rqestra to open (zip64). Unpack it and choose conversations.json inside it.");
  const out: ZipEntry[] = [];
  let at = offset;
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("The zip file is damaged.");
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const uncompressed = buffer.readUInt32LE(at + 24);
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || !wanted(name)) continue;
    if (flags & 1) throw new Error("The zip file is password protected.");
    if (uncompressed > maxBytes || total + uncompressed > maxBytes) throw new Error("A chat file in the zip is too large for 0rqestra (over 500 MB).");
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error("The zip file is damaged.");
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressed);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, uncompressed) });
      } catch {
        throw new Error("The zip file is damaged.");
      }
    } else throw new Error("This zip file uses a compression 0rqestra cannot open. Unpack it and choose conversations.json inside it.");
    total += data.length;
    out.push({ name, data });
  }
  return out;
}

// ---- the two export formats (the same readings as ui/chat-io.mjs) ---------------------------------

const textOf = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join("\n\n");
  if (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string") return (v as { text: string }).text;
  return "";
};

type Json = Record<string, unknown>;

function fromClaude(list: Json[]): LibraryChat[] {
  return list.filter((c) => Array.isArray(c.chat_messages)).map((c) => ({
    title: clean(c.name) || "Chat from Claude",
    at: Date.parse(String(c.updated_at || c.created_at)) || null,
    messages: (c.chat_messages as Json[]).map((m): LibraryMessage => {
      const parts = Array.isArray(m.content) ? (m.content as Json[]).filter((p) => !p?.type || p.type === "text") : [];
      return { role: m.sender === "human" ? "user" : "assistant", text: clean(m.text || textOf(parts)), ...(m.sender === "human" ? {} : { label: "Claude" }) };
    }).filter((m) => m.text),
  }));
}

function fromChatGPT(list: Json[]): LibraryChat[] {
  return list.filter((c) => c && typeof c.mapping === "object" && c.mapping).map((c) => {
    const mapping = c.mapping as Record<string, Json>;
    const order: Json[] = [];
    const seen = new Set<string>();
    let id: string | undefined = (c.current_node as string | undefined) || Object.keys(mapping).find((k) => !((mapping[k]?.children as unknown[]) || []).length);
    while (id && mapping[id] && !seen.has(id) && order.length < 5000) { seen.add(id); order.unshift(mapping[id]!); id = mapping[id]!.parent as string | undefined; }
    const messages = order.map((n) => n.message as Json | null)
      .filter((m): m is Json => Boolean(m) && ((m!.author as Json | undefined)?.role === "user" || (m!.author as Json | undefined)?.role === "assistant") && (m!.metadata as Json | undefined)?.is_visually_hidden_from_conversation !== true)
      .map((m): LibraryMessage => {
        const role = (m.author as Json).role as "user" | "assistant";
        const parts = ((m.content as Json | undefined)?.parts as unknown[] | undefined) ?? [];
        return { role, text: clean(parts.filter((p) => typeof p === "string").join("\n\n")), ...(role === "assistant" ? { label: "ChatGPT" } : {}) };
      })
      .filter((m) => m.text);
    return { title: clean(c.title) || "Chat from ChatGPT", at: typeof c.update_time === "number" ? c.update_time * 1000 : null, messages };
  });
}

// The JSON text(s) of an export: one string per file (ChatGPT splits big exports into conversations-000.json, …).
export function readExport(buffer: Buffer, fileName: string): string[] {
  if (buffer.length > MAX_FILE_BYTES) throw new Error("The file is too large for 0rqestra (over 1 GB).");
  const isZip = buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50 || /\.zip$/i.test(fileName);
  if (!isZip) {
    if (buffer.length > MAX_JSON_BYTES) throw new Error("The file is too large for 0rqestra (over 500 MB).");
    return [buffer.toString("utf8")];
  }
  const entries = readZip(buffer, (name) => /(^|\/)conversations(-\d+)?\.json$/i.test(name));
  if (!entries.length) throw new Error("There is no conversations.json in this zip. Choose the zip you got from Claude or ChatGPT.");
  return entries.sort((a, b) => a.name.localeCompare(b.name)).map((e) => e.data.toString("utf8"));
}

export function parseConversations(texts: string[]): { source: LibrarySource; chats: LibraryChat[] } {
  const list: Json[] = [];
  for (const text of texts) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("The file is not valid JSON, or it is too large to read (over about 500 MB).");
    }
    const part = Array.isArray(data) ? data : Array.isArray((data as Json | null)?.conversations) ? ((data as Json).conversations as unknown[]) : [data];
    for (const c of part) if (c && typeof c === "object") list.push(c as Json);
  }
  let source: LibrarySource;
  let chats: LibraryChat[];
  if (list.some((c) => Array.isArray(c.chat_messages))) { source = "Claude"; chats = fromClaude(list); }
  else if (list.some((c) => c.mapping && typeof c.mapping === "object")) { source = "ChatGPT"; chats = fromChatGPT(list); }
  else throw new Error("No chats found. Choose the data export from Claude or ChatGPT (the zip, or conversations.json inside it).");
  chats = chats.filter((c) => c.messages.length).sort((a, b) => (b.at || 0) - (a.at || 0));
  if (!chats.length) throw new Error("No chats with messages were found in this export.");
  return { source, chats };
}

// ---- the library: list, search, pick -------------------------------------------------------------

const preview = (c: LibraryChat): string => (c.messages.find((m) => m.role === "user") ?? c.messages[0]!).text.replace(/\s+/g, " ").slice(0, 140);

export class ChatLibrary {
  readonly source: LibrarySource;
  readonly chats: LibraryChat[];

  constructor(parsed: { source: LibrarySource; chats: LibraryChat[] }) {
    this.source = parsed.source;
    this.chats = parsed.chats;
  }

  static fromFile(buffer: Buffer, fileName: string): ChatLibrary {
    return new ChatLibrary(parseConversations(readExport(buffer, fileName)));
  }

  private item(index: number): LibraryItem {
    const c = this.chats[index]!;
    return { id: index, title: c.title.slice(0, 120), at: c.at, count: c.messages.length, preview: preview(c) };
  }

  list(): LibraryItem[] {
    return this.chats.map((_, i) => this.item(i));
  }

  // Every word has to be in the title or in the text of a message (case does not matter); the title is
  // listed first. Returns at most `limit` chats with the place where the words were found.
  search(query: unknown, limit = 200): LibraryHit[] {
    const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length) return [];
    const hits: { hit: LibraryHit; inTitle: boolean }[] = [];
    this.chats.forEach((c, i) => {
      const title = c.title.toLowerCase();
      const texts = c.messages.map((m) => m.text.toLowerCase());
      const whole = `${title}\n${texts.join("\n")}`;
      if (!words.every((w) => whole.includes(w))) return;
      const inTitle = words.every((w) => title.includes(w));
      let snippet: string | null = null;
      if (!inTitle) {
        const at = texts.findIndex((t) => t.includes(words[0]!));
        if (at >= 0) {
          const text = c.messages[at]!.text.replace(/\s+/g, " ");
          const pos = Math.max(0, text.toLowerCase().indexOf(words[0]!) - 50);
          snippet = `${pos > 0 ? "…" : ""}${text.slice(pos, pos + 140)}${pos + 140 < text.length ? "…" : ""}`;
        }
      }
      hits.push({ hit: { ...this.item(i), snippet }, inTitle });
    });
    return hits.sort((a, b) => Number(b.inTitle) - Number(a.inTitle)).slice(0, limit).map((h) => h.hit);
  }

  // The chosen chats, cut to what the app keeps (the latest messages, each message limited in length).
  pick(ids: unknown): { source: LibrarySource; chats: LibraryChat[] } {
    const wanted = (Array.isArray(ids) ? ids : []).filter((n): n is number => Number.isInteger(n) && n >= 0 && n < this.chats.length);
    if (!wanted.length) throw new Error("Choose at least one chat.");
    if (wanted.length > MAX_PICK) throw new Error(`Choose at most ${MAX_PICK} chats at a time.`);
    return {
      source: this.source,
      chats: [...new Set(wanted)].map((i) => {
        const c = this.chats[i]!;
        return {
          title: c.title.slice(0, 80),
          at: c.at,
          messages: c.messages.slice(-MAX_MESSAGES).map((m) => ({ ...m, text: m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)}\n\n[… cut to fit]` : m.text })),
        };
      }),
    };
  }
}
