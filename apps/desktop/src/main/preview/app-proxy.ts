import crypto from "node:crypto";
import { PREVIEW_HEADERS } from "./products";
import { withPicker } from "./picker";

// A running app (main/sandbox) is shown through the preview scheme, so the frame keeps its own origin,
// the same CSP and the same isolation as a plain page. Requests are passed to the app's port on this
// computer's loopback address, and nowhere else.

export function appHost(projectId: string, productId: string): string {
  return `a${crypto.createHash("sha256").update(`${projectId}\n${productId}`).digest("hex").slice(0, 31)}`;
}

const DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "content-security-policy", "content-security-policy-report-only", "x-frame-options", "strict-transport-security", "alt-svc"]);
const MAX_HTML = 3_000_000;

// The app's own headers, without those that do not apply through the proxy, plus the preview's.
export function proxiedHeaders(source: Headers, port: number): Headers {
  const out = new Headers();
  source.forEach((value, name) => {
    if (DROP.has(name.toLowerCase())) return;
    if (name.toLowerCase() === "location") {
      // An absolute redirect to the app itself stays inside the preview.
      const prefix = `http://127.0.0.1:${port}`;
      const local = [prefix, `http://localhost:${port}`, "http://0.0.0.0:3000", "http://localhost:3000"].find((p) => value.startsWith(p));
      out.set(name, local ? value.slice(local.length) || "/" : value);
      return;
    }
    out.append(name, value);
  });
  for (const [name, value] of Object.entries(PREVIEW_HEADERS)) out.set(name, value);
  return out;
}

export async function proxyToApp(request: Request, port: number, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("origin");
  headers.delete("referer");
  let response: Response;
  try {
    const init: RequestInit = { method: request.method, headers, redirect: "manual" };
    if (!["GET", "HEAD"].includes(request.method)) init.body = await request.arrayBuffer();
    response = await fetcher(target, init);
  } catch {
    return new Response("The app does not answer. It may have stopped; start it again from the preview.", { status: 502, headers: { ...PREVIEW_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  }
  const out = proxiedHeaders(response.headers, port);
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/html") && request.method === "GET") {
    const text = await response.text();
    return new Response(text.length <= MAX_HTML ? withPicker(text) : text, { status: response.status, headers: out });
  }
  return new Response([204, 304].includes(response.status) || request.method === "HEAD" ? null : response.body, { status: response.status, headers: out });
}
