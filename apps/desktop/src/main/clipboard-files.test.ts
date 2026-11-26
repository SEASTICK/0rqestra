import { describe, expect, it } from "vitest";
import { fileUrls, MAX_PASTED_FILES, windowsFileNames } from "./clipboard-files.js";

describe("files copied in a file manager", () => {
  it("reads the paths Windows puts on the clipboard", () => {
    const buffer = Buffer.from("C:\\Users\\philip\\bild.png\0D:\\notes.txt\0\0", "utf16le");
    expect(windowsFileNames(buffer)).toEqual(["C:\\Users\\philip\\bild.png", "D:\\notes.txt"]);
    expect(windowsFileNames(Buffer.from("\\\\server\\share\\a.pdf\0", "utf16le"))).toEqual(["\\\\server\\share\\a.pdf"]);
    expect(windowsFileNames(Buffer.from("not a path\0", "utf16le"))).toEqual([]);
    expect(windowsFileNames(null)).toEqual([]);
  });

  it("reads file URLs from macOS and Linux, and nothing else", () => {
    expect(fileUrls("file:///home/philip/Bilder/sk%C3%A4rmbild.png\r\nfile:///tmp/a.txt\n")).toEqual(["/home/philip/Bilder/skärmbild.png", "/tmp/a.txt"]);
    expect(fileUrls("https://example.com/a.png\n# comment")).toEqual([]);
    expect(fileUrls("")).toEqual([]);
  });

  it("takes at most a message's worth of files", () => {
    const many = Array.from({ length: 10 }, (_, i) => `file:///tmp/${i}.txt`).join("\n");
    expect(fileUrls(many)).toHaveLength(MAX_PASTED_FILES);
  });
});
