import { describe, expect, it } from "vitest";
import { checkConfig, loadTeamsConfig } from "./teams-config";

const jwt = (role: string) => `x.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.y`;
const ok = { supabaseUrl: "https://abcdefgh.supabase.co/", publishableKey: "sb_publishable_abc_123" };

describe("Teams configuration", () => {
  it("accepts a project URL with a publishable key", () => {
    const r = checkConfig(ok, "test");
    expect(r.ok && r.config).toMatchObject({ url: "https://abcdefgh.supabase.co", publishableKey: "sb_publishable_abc_123" });
    expect(checkConfig({ ...ok, publishableKey: jwt("anon") }, "test").ok).toBe(true);
    expect(checkConfig({ ...ok, supabaseUrl: "http://127.0.0.1:54321" }, "test").ok).toBe(true);
  });

  it("is simply not set up when both values are empty", () => {
    expect(checkConfig({ supabaseUrl: "", publishableKey: "" }, "test")).toEqual({ ok: false, problem: null });
  });

  it("refuses secret and service-role keys", () => {
    for (const key of ["sb_secret_abc_123", jwt("service_role")]) {
      const r = checkConfig({ ...ok, publishableKey: key }, "test");
      expect(r.ok).toBe(false);
      expect(!r.ok && r.problem).toMatch(/secret key/);
    }
  });

  it("refuses insecure or odd URLs and half a configuration", () => {
    for (const supabaseUrl of ["http://abc.supabase.co", "https://abc.supabase.co/rest/v1", "https://u:p@abc.supabase.co", "not a url"]) {
      expect(checkConfig({ ...ok, supabaseUrl }, "test").ok, supabaseUrl).toBe(false);
    }
    expect(checkConfig({ supabaseUrl: ok.supabaseUrl }, "test").ok).toBe(false);
    expect(checkConfig({ ...ok, publishableKey: "random" }, "test").ok).toBe(false);
  });

  it("prefers environment variables, then the user file, then the bundled file", () => {
    const files: Record<string, string> = { user: JSON.stringify({ supabaseUrl: "https://user.supabase.co", publishableKey: "sb_publishable_u" }), bundled: JSON.stringify(ok) };
    const readFile = (f: string) => files[f] ?? null;
    const env = { ORQESTRA_SUPABASE_URL: "https://env.supabase.co", ORQESTRA_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_e" };
    const load = (e: NodeJS.ProcessEnv) => loadTeamsConfig({ env: e, readFile, userFile: "user", bundledFile: "bundled" });
    expect((load(env) as { config: { url: string } }).config.url).toBe("https://env.supabase.co");
    expect((load({}) as { config: { url: string } }).config.url).toBe("https://user.supabase.co");
    files.user = JSON.stringify({ supabaseUrl: "", publishableKey: "" });
    expect((load({}) as { config: { url: string } }).config.url).toBe("https://abcdefgh.supabase.co");
    delete files.bundled;
    expect(load({})).toEqual({ ok: false, problem: null });
  });
});
