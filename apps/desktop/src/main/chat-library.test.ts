import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { ChatLibrary, MAX_MESSAGE_CHARS, parseConversations, readExport, readZip } from "./chat-library.js";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// A small zip writer for the tests: [name, content, method] entries.
function zip(files: ([string, string | Buffer] | [string, string | Buffer, "store" | "deflate"])[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content, how] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const method = how === "store" || name.endsWith("/") ? 0 : 8;
    const packed = method === 8 ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc32(data), 16); head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(nameBuf.length, 28); head.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const claude = JSON.stringify([
  { name: "Fotosyntes", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-02T10:00:00Z", chat_messages: [{ sender: "human", text: "Vad är fotosyntes?" }, { sender: "assistant", text: "Växter gör socker av ljus och koldioxid." }] },
  { name: "Matteprov", created_at: "2026-11-01T10:00:00Z", chat_messages: [{ sender: "human", text: "Hjälp mig med derivator" }, { sender: "assistant", content: [{ type: "text", text: "Derivatan av x² är 2x. Fotosyntes nämns inte." }, { type: "tool_use" }] }] },
  { name: "Tom", created_at: "2026-11-02T10:00:00Z", chat_messages: [] },
]);
const gpt = (title: string, user: string, bot: string, time: number) => ({ title, update_time: time, current_node: "n2", mapping: {
  root: { message: null, parent: null, children: ["n1"] },
  n1: { parent: "root", children: ["n2"], message: { author: { role: "user" }, content: { parts: [user] } } },
  n2: { parent: "n1", children: [], message: { author: { role: "assistant" }, content: { parts: [bot] } } },
} });

describe("Reading an export", () => {
  it("opens the zip as emailed, with stored and compressed files, and finds conversations.json in it", () => {
    const file = zip([["export/", ""], ["export/user.json", "{}", "store"], ["export/conversations.json", claude], ["export/projects.json", "[]"]]);
    const texts = readExport(file, "data-2026.zip");
    expect(texts).toHaveLength(1);
    expect(parseConversations(texts).source).toBe("Claude");
    // A zip is recognised by its content too, and ChatGPT's split files are read in order.
    const split = zip([["conversations-001.json", JSON.stringify([gpt("B", "q2", "a2", 2000)])], ["conversations-000.json", JSON.stringify([gpt("A", "q1", "a1", 1000)])]]);
    const parsed = parseConversations(readExport(split, "export"));
    expect(parsed.source).toBe("ChatGPT");
    expect(parsed.chats.map((c) => c.title)).toEqual(["B", "A"]);
  });

  it("reads a plain conversations.json and says plainly what is wrong with other files", () => {
    expect(readExport(Buffer.from(claude), "conversations.json")).toEqual([claude]);
    expect(() => readExport(zip([["notes.txt", "x"]]), "a.zip")).toThrow(/no conversations\.json/);
    expect(() => readZip(Buffer.from("not a zip at all, just some text that is long enough"), () => true)).toThrow(/not a zip/);
    expect(() => parseConversations(["{broken"])).toThrow(/not valid JSON/);
    expect(() => parseConversations(['{"a":1}'])).toThrow(/No chats found/);
    const bad = zip([["conversations.json", claude]]);
    bad.writeUInt32LE(0xffffffff, bad.length - 22 + 16);
    expect(() => readZip(bad, () => true)).toThrow(/zip64/);
    const enc = zip([["conversations.json", claude]]);
    enc.writeUInt16LE(1, enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
    expect(() => readZip(enc, () => true)).toThrow(/password/);
  });

  it("refuses a file that unpacks to more than it says (a damaged or hostile zip)", () => {
    const file = zip([["conversations.json", "x".repeat(5000)]]);
    // The central directory claims 10 bytes; unpacking to more than that must fail, not fill the memory.
    file.writeUInt32LE(10, file.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
    expect(() => readZip(file, () => true)).toThrow(/damaged/);
    expect(() => readZip(zip([["conversations.json", "{}"]]), () => true, 1)).toThrow(/too large/);
  });
});

describe("The chat library", () => {
  const library = () => ChatLibrary.fromFile(Buffer.from(claude), "conversations.json");

  it("lists the chats newest first, without empty ones, with a preview", () => {
    const items = library().list();
    expect(items.map((i) => i.title)).toEqual(["Matteprov", "Fotosyntes"]);
    expect(items[1]).toMatchObject({ count: 2, preview: "Vad är fotosyntes?" });
  });

  it("searches titles and message text, every word, any case, titles first, with a snippet", () => {
    const lib = library();
    expect(lib.search("FOTOSYNTES").map((h) => h.title)).toEqual(["Fotosyntes", "Matteprov"]);
    expect(lib.search("fotosyntes")[0]!.snippet).toBeNull();
    expect(lib.search("fotosyntes")[1]!.snippet).toContain("Fotosyntes nämns inte");
    expect(lib.search("socker koldioxid").map((h) => h.title)).toEqual(["Fotosyntes"]);
    expect(lib.search("socker derivatan")).toEqual([]);
    expect(lib.search("   ")).toEqual([]);
    expect(lib.search("x²")[0]!.title).toBe("Matteprov");
  });

  it("hands over only the chosen chats, cut to what the app keeps, and refuses bad choices", () => {
    const long = JSON.stringify([{ name: "Lång", chat_messages: [{ sender: "human", text: "y".repeat(MAX_MESSAGE_CHARS + 10) }, ...Array.from({ length: 400 }, (_, i) => ({ sender: "assistant", text: `svar ${i}` }))] }]);
    const lib = ChatLibrary.fromFile(Buffer.from(long), "conversations.json");
    const picked = lib.pick([0, 0]);
    expect(picked.chats).toHaveLength(1);
    expect(picked.chats[0]!.messages).toHaveLength(300);
    expect(picked.chats[0]!.messages.at(-1)!.text).toBe("svar 399");
    expect(() => lib.pick([])).toThrow(/at least one/);
    expect(() => lib.pick([5, -1, "x", 1.5])).toThrow(/at least one/);
    expect(() => lib.pick(Array.from({ length: 101 }, () => 0))).toThrow(/at most 100/);
    const first = ChatLibrary.fromFile(Buffer.from(JSON.stringify([{ name: "A", chat_messages: [{ sender: "human", text: "z".repeat(MAX_MESSAGE_CHARS + 10) }] }])), "c.json").pick([0]);
    expect(first.chats[0]!.messages[0]!.text.endsWith("[… cut to fit]")).toBe(true);
  });
});
