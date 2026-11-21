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
  // displayName comes from the account's profile (user metadata), set when the account is created.
  user: { id: string; email: string; displayName: string | null };
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
  const meta = (user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {}) as Record<string, unknown>;
  const displayName = typeof meta.display_name === "string" && meta.display_name.trim() ? meta.display_name.trim().slice(0, 60) : null;
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt, user: { id: user.id, email: typeof user.email === "string" ? user.email : "", displayName } };
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

  // Sends a one-time code. Only createUser: true may create an account (with the display name in
  // its profile); otherwise Supabase refuses an unknown address with otp_disabled.
  async sendCode(email: string, opts: { createUser: boolean; displayName?: string; username?: string } = { createUser: false }): Promise<void> {
    const data = { ...(opts.displayName ? { display_name: opts.displayName } : {}), ...(opts.username ? { username: opts.username } : {}) };
    await this.request("POST", "/auth/v1/otp", {
      body: { email, create_user: opts.createUser, ...(opts.createUser && Object.keys(data).length ? { data } : {}) },
    });
  }

  // Whether the Auth server answers at all (used to tell "offline" apart from "signed out").
  async health(): Promise<void> {
    await this.request("GET", "/auth/v1/health");
  }

  // Saves the display name in the signed-in account's profile.
  async setDisplayName(token: string, displayName: string): Promise<void> {
    await this.request("PUT", "/auth/v1/user", { token, body: { data: { display_name: displayName } } });
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

  // Deletes the rows a query selects (row-level security decides which ones may go) and returns them.
  async remove<T>(token: string, table: string, query: string): Promise<T[]> {
    const rows = (await this.request("DELETE", `/rest/v1/${table}?${query}`, { token, prefer: "return=representation" })) as T[];
    return Array.isArray(rows) ? rows : [];
  }

  // A null token calls the function as an anonymous visitor (only username_available allows that).
  rpc<T>(token: string | null, fn: string, args: Record<string, unknown>): Promise<T> {
    return this.request("POST", `/rest/v1/rpc/${fn}`, { ...(token ? { token } : {}), body: args }) as Promise<T>;
  }
}
