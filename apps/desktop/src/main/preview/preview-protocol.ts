import fs from "node:fs";
import { protocol, session } from "electron";
import { PREVIEW_HEADERS, PREVIEW_SCHEME, previewHost, resolvePreview } from "./products";

// The orqestra-preview scheme serves a project's own files to the preview frame, and nothing else.
// A host is known only after the window asked for that project's products.

const hosts = new Map<string, string>();

export function rememberPreviewHost(projectId: string, workspace: string): string {
  const host = previewHost(projectId);
  hosts.set(host, workspace);
  return host;
}

// Must run before the app is ready.
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

export function handlePreviewScheme(): void {
  session.defaultSession.protocol.handle(PREVIEW_SCHEME, (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not allowed", { status: 405, headers: PREVIEW_HEADERS });
    const answer = resolvePreview(request.url, (host) => hosts.get(host) ?? null);
    if (answer.status !== 200) return new Response(answer.reason, { status: answer.status, headers: { ...PREVIEW_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
    return new Response(request.method === "HEAD" ? null : fs.readFileSync(answer.file), { status: 200, headers: { ...PREVIEW_HEADERS, "Content-Type": answer.type } });
  });
  // A page in the preview never downloads anything to the user's computer.
  session.defaultSession.on("will-download", (event) => event.preventDefault());
}

export function isPreviewUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === `${PREVIEW_SCHEME}:` && hosts.has(parsed.hostname);
}
