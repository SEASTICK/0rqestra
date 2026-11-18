import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CatchUpLog, parseKept } from "./catch-up-log";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orq-catchup-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const P = "11111111-2222-3333-4444-555555555555";
const msg = (hash: string, at = Date.now()) => ({ id: `team-catchup-${P}-${hash}`, kind: "teamInfo", infoType: "catch-up", sharedProjectId: P, at, text: "While you were away: …" });

describe("catch-up log", () => {
  it("keeps each catch-up once, on disk, so a crash right after showing it cannot lose it", () => {
    const file = path.join(tmp, "a", "catch-up.json");
    const log = new CatchUpLog(file);
    log.keep(parseKept("local-1", msg("abc")));
    log.keep(parseKept("local-1", msg("abc")));
    log.keep(parseKept("local-1", msg("def")));
    // A new process (the app after a crash) reads the same file.
    expect(new CatchUpLog(file).all().map((k) => k.message.id)).toEqual([`team-catchup-${P}-abc`, `team-catchup-${P}-def`]);
  });

  it("refuses anything that is not a catch-up message, and forgets old ones", () => {
    expect(() => parseKept("../x", msg("abc"))).toThrow();
    expect(() => parseKept("local-1", { ...msg("abc"), id: "something-else" })).toThrow();
    expect(() => parseKept("local-1", { ...msg("abc"), text: "x".repeat(9000) })).toThrow();
    const file = path.join(tmp, "b", "catch-up.json");
    let now = Date.now();
    const log = new CatchUpLog(file, () => now);
    log.keep(parseKept("local-1", msg("old", now)));
    now += 31 * 24 * 3600_000;
    expect(log.all()).toEqual([]);
  });
});
