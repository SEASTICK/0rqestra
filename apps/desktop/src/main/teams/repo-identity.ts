// The identity of a GitHub repository, read from a Git remote URL. SSH and HTTPS clones of the same
// repository give the same key, so two people's checkouts can be matched without comparing paths.

export interface RepoIdentity {
  host: "github.com";
  // As written in the remote, for display.
  owner: string;
  name: string;
  // Lower case "github.com/owner/name": GitHub owner and repository names are case-insensitive.
  key: string;
}

export type RemoteParse = { ok: true; identity: RepoIdentity } | { ok: false; problem: string };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
// github.com itself, and its documented SSH-over-HTTPS host.
const GITHUB_HOSTS = new Set(["github.com", "www.github.com", "ssh.github.com"]);

export function makeIdentity(owner: string, name: string): RepoIdentity | null {
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
  return { host: "github.com", owner, name, key: `github.com/${owner}/${name}`.toLowerCase() };
}

function fromPath(host: string, rawPath: string, original: string): RemoteParse {
  if (!GITHUB_HOSTS.has(host.toLowerCase())) {
    return { ok: false, problem: `${shortUrl(original)} is not a GitHub repository. Teams works with repositories on github.com.` };
  }
  let p = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (p.toLowerCase().endsWith(".git")) p = p.slice(0, -4);
  const [owner, name, ...extra] = p.split("/");
  if (extra.length || !owner || !name) {
    return { ok: false, problem: `${shortUrl(original)} does not name one repository (expected github.com/owner/repository).` };
  }
  const identity = makeIdentity(owner, name);
  return identity ? { ok: true, identity } : { ok: false, problem: `${shortUrl(original)} has an owner or repository name GitHub does not allow.` };
}

// Never show a password or token that someone put into a remote URL.
export function shortUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
}

export function parseGitHubRemote(input: string): RemoteParse {
  const url = input.trim();
  if (!url) return { ok: false, problem: "The remote has no URL." };
  // scp-like SSH: git@github.com:owner/repo.git (no scheme, a colon before any slash).
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)([^\s]+)$/.exec(url);
  if (scp?.[1] && scp[2] && !/^[a-z]:[\\/]/i.test(url)) return fromPath(scp[1], scp[2], url);
  if (!URL.canParse(url)) return { ok: false, problem: `${shortUrl(url)} is not a URL Git can fetch from GitHub.` };
  const parsed = new URL(url);
  if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol)) {
    return { ok: false, problem: `${shortUrl(url)} is a local or unsupported remote. Use the GitHub URL of the repository.` };
  }
  if (parsed.search || parsed.hash) return { ok: false, problem: `${shortUrl(url)} does not name one repository.` };
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return { ok: false, problem: `${shortUrl(url)} is not a valid URL.` };
  }
  return fromPath(parsed.hostname, pathname, url);
}

export interface RemoteInfo {
  name: string;
  url: string;
}

export interface RemoteChoice {
  name: string;
  // Credentials removed.
  url: string;
  identity: RepoIdentity | null;
  problem: string | null;
}

export type IdentityResolution =
  | { status: "ok"; remote: string; identity: RepoIdentity; remotes: RemoteChoice[] }
  | { status: "missing" | "ambiguous" | "unsupported"; problem: string; remotes: RemoteChoice[] };

export function describeRemotes(remotes: RemoteInfo[]): RemoteChoice[] {
  return remotes.map((r) => {
    const parsed = parseGitHubRemote(r.url);
    return { name: r.name, url: shortUrl(r.url), identity: parsed.ok ? parsed.identity : null, problem: parsed.ok ? null : parsed.problem };
  });
}

// Picks the repository a checkout belongs to. With a chosen remote, only that remote counts. Without
// one, all GitHub remotes must agree; if they name different repositories the user has to choose.
export function resolveIdentity(remotes: RemoteInfo[], chosen?: string | null): IdentityResolution {
  const choices = describeRemotes(remotes);
  if (choices.length === 0) {
    return { status: "missing", remotes: choices, problem: "This folder has no Git remote. Add the GitHub repository as a remote (for example: git remote add origin https://github.com/owner/repo.git) and try again." };
  }
  if (chosen) {
    const c = choices.find((r) => r.name === chosen);
    if (!c) return { status: "missing", remotes: choices, problem: `This folder has no remote called "${chosen}".` };
    if (!c.identity) return { status: "unsupported", remotes: choices, problem: c.problem ?? "That remote is not a GitHub repository." };
    return { status: "ok", remote: c.name, identity: c.identity, remotes: choices };
  }
  const github = choices.filter((c) => c.identity);
  if (github.length === 0) {
    return { status: "unsupported", remotes: choices, problem: choices.length === 1 ? (choices[0]?.problem ?? "The remote is not a GitHub repository.") : "None of this folder's remotes is a GitHub repository. Add the GitHub repository as a remote and try again." };
  }
  const keys = new Set(github.map((c) => c.identity!.key));
  if (keys.size > 1) {
    return { status: "ambiguous", remotes: choices, problem: `This folder's remotes point to ${keys.size} different GitHub repositories (${github.map((c) => c.name).join(", ")}). Choose the remote that is the shared repository.` };
  }
  const pick = github.find((c) => c.name === "origin") ?? github[0]!;
  return { status: "ok", remote: pick.name, identity: pick.identity!, remotes: choices };
}

// For linking to an existing shared project: any remote that names the shared repository is enough
// (for example "upstream" in a fork). Returns that remote, or null.
export function remoteMatching(remotes: RemoteInfo[], key: string): RemoteChoice | null {
  const k = key.toLowerCase();
  const all = describeRemotes(remotes).filter((c) => c.identity?.key === k);
  return all.find((c) => c.name === "origin") ?? all[0] ?? null;
}
