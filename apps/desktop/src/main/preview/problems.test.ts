import { describe, expect, it } from "vitest";
import { problemFromConsole, ProblemThrottle, type PreviewProblem } from "./problems.js";

const HOST = "pabc";
const known = (h: string) => h === HOST;
const page = `orqestra-preview://${HOST}/web/index.html?v=3`;
const base = { level: "error", message: "", lineNumber: 0, sourceId: "", frameUrl: page };

describe("preview problems", () => {
  it("reads a script error with its file and line", () => {
    expect(problemFromConsole({ ...base, message: "Uncaught TypeError: x is not a function", lineNumber: 12, sourceId: `orqestra-preview://${HOST}/web/app.js` }, known))
      .toEqual({ host: HOST, kind: "error", message: "Uncaught TypeError: x is not a function", page: "web/index.html", source: "web/app.js", line: 12 });
  });

  it("names a missing file", () => {
    expect(problemFromConsole({ ...base, message: "Failed to load resource: the server responded with a status of 404 (Not Found)", sourceId: `orqestra-preview://${HOST}/web/style%20s.css` }, known))
      .toMatchObject({ kind: "missing", message: "The page asks for web/style s.css, which does not exist.", source: "web/style s.css", line: null });
  });

  it("explains something blocked from the internet", () => {
    const p = problemFromConsole({ ...base, message: "Refused to load the script 'https://cdn.example.com/x.js' because it violates the following Content Security Policy directive", sourceId: page }, known);
    expect(p).toMatchObject({ kind: "blocked", source: null, line: null, message: "The page tried to load https://cdn.example.com/x.js from the internet, which the preview does not allow. Put what it needs in the product's own files." });
    expect(problemFromConsole({ ...base, message: "Refused to connect because it violates the document's Content Security Policy." }, known)?.message).toMatch(/^The page tried to load something from outside its own files/);
  });

  it("names a missing style or script that came back as plain text", () => {
    const msg = (kind: string, url: string) => `Refused to ${kind} from '${url}' because its MIME type ('text/plain') is not a supported stylesheet MIME type, and strict MIME checking is enabled.`;
    expect(problemFromConsole({ ...base, message: msg("apply style", `orqestra-preview://${HOST}/web/style.css`), sourceId: page }, known))
      .toMatchObject({ kind: "missing", source: "web/style.css", message: "The page asks for web/style.css, which does not exist." });
    expect(problemFromConsole({ ...base, message: msg("execute script", `orqestra-preview://${HOST}/web/app.js`) }, known)).toMatchObject({ kind: "missing", source: "web/app.js" });
    expect(problemFromConsole({ ...base, message: msg("apply style", "orqestra-preview://pother/x.css") }, known)?.kind).toBe("error");
  });

  it("ignores warnings, the app's own window, other hosts and empty messages", () => {
    expect(problemFromConsole({ ...base, level: "warning", message: "x" }, known)).toBeNull();
    expect(problemFromConsole({ ...base, message: "x", frameUrl: "file:///app/index.html", sourceId: "file:///app/app.js" }, known)).toBeNull();
    expect(problemFromConsole({ ...base, message: "x", frameUrl: "orqestra-preview://pother/index.html" }, known)).toBeNull();
    expect(problemFromConsole({ ...base, message: " \u0001 " }, known)).toBeNull();
  });

  it("cuts long messages and strips control characters", () => {
    const p = problemFromConsole({ ...base, message: `bad\u0007${"y".repeat(1000)}` }, known);
    expect(p?.message.length).toBe(401);
    expect(p?.message.startsWith("bady")).toBe(true);
  });

  it("uses the source's host when the frame is unknown, but never a source from another host", () => {
    expect(problemFromConsole({ ...base, frameUrl: null, message: "boom", sourceId: `orqestra-preview://${HOST}/a.js` }, known)).toMatchObject({ page: null, source: "a.js" });
    expect(problemFromConsole({ ...base, message: "boom", sourceId: "https://evil.example/a.js" }, known)).toMatchObject({ source: null, line: null });
  });
});

describe("throttle", () => {
  const p = (message: string, host = HOST): PreviewProblem => ({ host, kind: "error", message, page: null, source: null, line: null });
  it("sends the same problem once per window and caps each host", () => {
    const t = new ProblemThrottle(1000, 3);
    expect(t.allow(p("a"), 0)).toBe(true);
    expect(t.allow(p("a"), 10)).toBe(false);
    expect(t.allow(p("b"), 20)).toBe(true);
    expect(t.allow(p("c"), 30)).toBe(true);
    expect(t.allow(p("d"), 40)).toBe(false);
    expect(t.allow(p("d", "pother"), 40)).toBe(true);
    expect(t.allow(p("a"), 1100)).toBe(true);
  });
});
