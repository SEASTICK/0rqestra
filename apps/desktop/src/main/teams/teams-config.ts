// Where Teams finds its Supabase project. Only the project URL and the publishable key belong in
// the app; both are designed to be public. A secret or service-role key is refused outright.
//
// Sources, first match wins:
//   1. ORQESTRA_SUPABASE_URL and ORQESTRA_SUPABASE_PUBLISHABLE_KEY (for development)
//   2. teams-config.json in the app's user-data folder (to configure an installed app)
//   3. teams-config.json next to the app (shipped with a build)

export interface TeamsConfig {
  url: string;
  publishableKey: string;
  source: string;
}

export type ConfigResult = { ok: true; config: TeamsConfig } | { ok: false; problem: string | null };

interface RawConfig {
  supabaseUrl?: unknown;
  publishableKey?: unknown;
}

function jwtRole(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

export function checkConfig(raw: RawConfig, source: string): ConfigResult {
  const url = typeof raw.supabaseUrl === "string" ? raw.supabaseUrl.trim().replace(/\/+$/, "") : "";
  const key = typeof raw.publishableKey === "string" ? raw.publishableKey.trim() : "";
  // Both empty: Teams is simply not set up.
  if (!url && !key) return { ok: false, problem: null };
  if (!url || !key) return { ok: false, problem: `${source} needs both supabaseUrl and publishableKey.` };
  if (!URL.canParse(url)) return { ok: false, problem: `${source}: supabaseUrl is not a URL.` };
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    return { ok: false, problem: `${source}: supabaseUrl must use https (http only for a local Supabase).` };
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    return { ok: false, problem: `${source}: supabaseUrl must be the project URL only, such as https://<project-ref>.supabase.co.` };
  }
  if (key.startsWith("sb_secret_") || jwtRole(key) === "service_role") {
    return { ok: false, problem: `${source} contains a secret key. Remove it now and rotate it in the Supabase dashboard; the app only takes the publishable key.` };
  }
  if (!key.startsWith("sb_publishable_") && jwtRole(key) !== "anon") {
    return { ok: false, problem: `${source}: publishableKey must be the project's publishable key (sb_publishable_…).` };
  }
  return { ok: true, config: { url: parsed.origin, publishableKey: key, source } };
}

export function parseConfigFile(text: string, source: string): ConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: `${source} is not valid JSON.` };
  }
  if (!raw || typeof raw !== "object") return { ok: false, problem: `${source} is not a JSON object.` };
  return checkConfig(raw as RawConfig, source);
}

export function loadTeamsConfig(opts: { env: NodeJS.ProcessEnv; readFile: (file: string) => string | null; userFile: string; bundledFile: string }): ConfigResult {
  const { env } = opts;
  if (env.ORQESTRA_SUPABASE_URL || env.ORQESTRA_SUPABASE_PUBLISHABLE_KEY) {
    return checkConfig({ supabaseUrl: env.ORQESTRA_SUPABASE_URL, publishableKey: env.ORQESTRA_SUPABASE_PUBLISHABLE_KEY }, "The ORQESTRA_SUPABASE_* environment variables");
  }
  for (const [file, label] of [[opts.userFile, "teams-config.json in the user-data folder"], [opts.bundledFile, "the app's teams-config.json"]] as const) {
    const text = opts.readFile(file);
    if (text === null) continue;
    const result = parseConfigFile(text, label);
    // An empty file means "not set here"; look further.
    if (result.ok || result.problem) return result;
  }
  return { ok: false, problem: null };
}
