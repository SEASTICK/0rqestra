import type { TeamsConfig } from "./teams-config";

// A small client for the parts of Supabase that Teams uses: Auth (email one-time code, refresh,
// sign-out) and the Data API (tables and database functions). It follows the HTTP API that
// supabase-js uses: the publishable key goes in the apikey header only, and a signed-in request
// carries the user's access token as "Authorization: Bearer". It runs in the main process only, so
// tokens never reach the window.

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  // Milliseconds since the epoch.
  expiresAt: number;
  user: { id: string; email: string };
}

export class SupabaseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    // Supabase's own code: an Auth error_code, a Postgres SQLSTATE, or our function's message code.
    readonly code: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorFrom(status: number, body: unknown): SupabaseError {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  // Data API (PostgREST): { code, message, details, hint }. Auth: { error_code, msg } or { error, error_description }.
  const message = str(b.message) || str(b.msg) || str(b.error_description) || str(b.error) || `Supabase answered ${status}.`;
  const code = str(b.error_code) || (typeof b.code === "string" ? b.code : "") || str(b.error) || String(status);
  return new SupabaseError(message, status, code);
}

export function sessionFrom(body: unknown, now: number): AuthSession {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const user = (b.user && typeof b.user === "object" ? b.user : {}) as Record<string, unknown>;
  if (typeof b.access_token !== "string" || typeof b.refresh_token !== "string" || typeof user.id !== "string") {
    throw new SupabaseError("Supabase did not return a session.", 500, "no_session");
  }
  const expiresAt = typeof b.expires_at === "number" ? b.expires_at * 1000 : now + (typeof b.expires_in === "number" ? b.expires_in : 3600) * 1000;
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt, user: { id: user.id, email: typeof user.email === "string" ? user.email : "" } };
}

export class SupabaseApi {
  constructor(
    private readonly config: TeamsConfig,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number = Date.now,
  ) {}

  private async request(method: string, path: string, opts: { token?: string; body?: unknown; prefer?: string } = {}): Promise<unknown> {
    const headers: Record<string, string> = { apikey: this.config.publishableKey, Accept: "application/json" };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.prefer) headers.Prefer = opts.prefer;
    let response;
    try {
      response = await this.fetchImpl(`${this.config.url}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new SupabaseError("Could not reach the Teams server. Check the internet connection and try again.", 0, "network");
    }
    const body = parseJson(await response.text());
    if (!response.ok) throw errorFrom(response.status, body);
    return body;
  }

  // Sends a one-time code to the address. A new address gets an account on first sign-in.
  async sendCode(email: string): Promise<void> {
    await this.request("POST", "/auth/v1/otp", { body: { email, create_user: true } });
  }

  async verifyCode(email: string, token: string): Promise<AuthSession> {
    return sessionFrom(await this.request("POST", "/auth/v1/verify", { body: { type: "email", email, token } }), this.now());
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    return sessionFrom(await this.request("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: refreshToken } }), this.now());
  }

  // Ends this computer's session only.
  async signOut(accessToken: string): Promise<void> {
    await this.request("POST", "/auth/v1/logout?scope=local", { token: accessToken });
  }

  select<T>(token: string, table: string, query: string): Promise<T[]> {
    return this.request("GET", `/rest/v1/${table}?${query}`, { token }) as Promise<T[]>;
  }

  async insert<T>(token: string, table: string, row: Record<string, unknown>, select: string): Promise<T> {
    const rows = (await this.request("POST", `/rest/v1/${table}?select=${select}`, { token, body: row, prefer: "return=representation" })) as T[];
    if (!Array.isArray(rows) || rows.length !== 1) throw new SupabaseError("The row was not saved.", 403, "not_saved");
    return rows[0]!;
  }

  rpc<T>(token: string, fn: string, args: Record<string, unknown>): Promise<T> {
    return this.request("POST", `/rest/v1/rpc/${fn}`, { token, body: args }) as Promise<T>;
  }
}
