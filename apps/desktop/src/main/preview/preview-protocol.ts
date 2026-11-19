import fs from "node:fs";
import { protocol, session, type BrowserWindow } from "electron";
import { PREVIEW_HEADERS, PREVIEW_SCHEME, previewHost, resolvePreview } from "./products";
import { problemFromConsole, ProblemThrottle } from "./problems";
import { PICKER_PATH, PICKER_SCRIPT, withPicker } from "./picker";

// The orqestra-preview scheme serves a project's own files to the preview frame, and nothing else.
// A host is known only after the window asked for that project's products.

const hosts = new Map<string, string>();
const projects = new Map<string, string>();

export function rememberPreviewHost(projectId: string, workspace: string): string {
  const host = previewHost(projectId);
  hosts.set(host, workspace);
  projects.set(host, projectId);
  return host;
}

// Errors from a previewed page reach the window as "team:preview-problem", with the project they belong to.
export function watchPreviewProblems(window: BrowserWindow): void {
  const throttle = new ProblemThrottle();
  window.webContents.on("console-message", (event) => {
    let frameUrl: string | null;
    try {
      frameUrl = event.frame?.url ?? null;
    } catch {
      frameUrl = null;
    }
    const problem = problemFromConsole({ level: event.level, message: event.message, lineNumber: event.lineNumber, sourceId: event.sourceId, frameUrl }, (host) => hosts.has(host));
    if (!problem || !throttle.allow(problem) || window.isDestroyed()) return;
    const projectId = projects.get(problem.host);
    if (!projectId) return;
    window.webContents.send("team:preview-problem", { projectId, kind: problem.kind, message: problem.message, page: problem.page, source: problem.source, line: problem.line });
  });
}

// Must run before the app is ready.
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

export function handlePreviewScheme(): void {
  session.defaultSession.protocol.handle(PREVIEW_SCHEME, (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not allowed", { status: 405, headers: PREVIEW_HEADERS });
    // The Select script (picker.ts) is served at a reserved path of every known project.
    const url = URL.canParse(request.url) ? new URL(request.url) : null;
    if (url && hosts.has(url.hostname) && url.pathname === `/${PICKER_PATH}`) {
      return new Response(request.method === "HEAD" ? null : PICKER_SCRIPT, { status: 200, headers: { ...PREVIEW_HEADERS, "Content-Type": "text/javascript; charset=utf-8" } });
    }
    const answer = resolvePreview(request.url, (host) => hosts.get(host) ?? null);
    if (answer.status !== 200) return new Response(answer.reason, { status: answer.status, headers: { ...PREVIEW_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
    const body = answer.type.startsWith("text/html") ? withPicker(fs.readFileSync(answer.file, "utf8")) : fs.readFileSync(answer.file);
    return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: { ...PREVIEW_HEADERS, "Content-Type": answer.type } });
  });
  // A page in the preview never downloads anything to the user's computer.
  session.defaultSession.on("will-download", (event) => event.preventDefault());
}

export function isPreviewUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === `${PREVIEW_SCHEME}:` && hosts.has(parsed.hostname);
}
