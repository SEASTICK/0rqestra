import { PREVIEW_SCHEME } from "./products";

// Problems a previewed page shows in its console: a script error, a file it asks for that does not
// exist, or something it tried to load from outside its own files. They go to the window, so the user
// can see them and ask the Manager to fix them. Everything here is plain data from the page, so it is
// cut short and never used as anything but text.

export type ProblemKind = "error" | "missing" | "blocked";

export interface PreviewProblem {
  host: string;
  kind: ProblemKind;
  message: string;
  page: string | null;
  source: string | null;
  line: number | null;
}

export interface ConsoleDetails {
  level: string;
  message: string;
  lineNumber: number;
  sourceId: string;
  frameUrl: string | null;
}

const MAX_MESSAGE = 400;

function previewParts(url: string | null): { host: string; path: string } | null {
  if (!url || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== `${PREVIEW_SCHEME}:`) return null;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  } catch {
    path = parsed.pathname.replace(/^\/+/, "");
  }
  return { host: parsed.hostname, path: path || "index.html" };
}

// Control characters are dropped (tab and newline become spaces).
const clean = (text: string) => [...text].filter((c) => c === "\t" || c === "\n" || (c >= " " && c !== "\u007f")).join("").replace(/\s+/g, " ").trim();

export function problemFromConsole(details: ConsoleDetails, isKnownHost: (host: string) => boolean): PreviewProblem | null {
  if (details.level !== "error") return null;
  const frame = previewParts(details.frameUrl);
  const source = previewParts(details.sourceId);
  const host = frame?.host ?? source?.host;
  if (!host || !isKnownHost(host)) return null;
  const text = clean(details.message);
  if (!text) return null;
  const sameHost = (url: string | undefined) => {
    const parts = previewParts(url ?? null);
    return parts && parts.host === host ? parts.path : null;
  };
  let kind: ProblemKind = "error";
  let sourcePath = sameHost(details.sourceId);
  let message = text;
  // A file that does not exist is answered with a plain-text 404, so the browser may report it as a wrong type.
  const wrongType = /Refused to (?:apply style|execute script) from '([^']+)' because its MIME type \('text\/plain'\)/i.exec(text);
  const outside = /'((?:https?|wss?):\/\/[^']+)'/i.exec(text);
  if (wrongType && sameHost(wrongType[1])) {
    kind = "missing";
    sourcePath = sameHost(wrongType[1]);
  } else if (/Failed to load resource/i.test(text) && /\b404\b/.test(text)) {
    kind = "missing";
  } else if (/Content Security Policy|Refused to (load|connect|frame)/i.test(text)) {
    kind = "blocked";
    message = outside
      ? `The page tried to load ${outside[1]} from the internet, which the preview does not allow. Put what it needs in the product's own files.`
      : `The page tried to load something from outside its own files, which the preview does not allow. ${text}`;
  }
  if (kind === "missing") message = sourcePath ? `The page asks for ${sourcePath}, which does not exist.` : "The page asks for a file that does not exist.";
  return {
    host,
    kind,
    message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message,
    page: frame && frame.host === host ? frame.path : null,
    source: kind === "blocked" ? null : sourcePath,
    line: kind === "error" && sourcePath && details.lineNumber > 0 ? details.lineNumber : null,
  };
}

// A page in a loop could log thousands of errors. The same problem is sent once per window of time,
// and at most `max` problems per host in that window.
export class ProblemThrottle {
  private seen = new Map<string, number>();
  private counts = new Map<string, { start: number; count: number }>();

  constructor(private readonly windowMs = 60_000, private readonly max = 30) {}

  allow(problem: PreviewProblem, now = Date.now()): boolean {
    const key = `${problem.host}|${problem.kind}|${problem.source}|${problem.line}|${problem.message}`;
    const last = this.seen.get(key);
    if (last !== undefined && now - last < this.windowMs) return false;
    const bucket = this.counts.get(problem.host);
    if (!bucket || now - bucket.start >= this.windowMs) this.counts.set(problem.host, { start: now, count: 1 });
    else if (bucket.count >= this.max) return false;
    else bucket.count += 1;
    this.seen.set(key, now);
    if (this.seen.size > 2000) this.seen.clear();
    return true;
  }
}
