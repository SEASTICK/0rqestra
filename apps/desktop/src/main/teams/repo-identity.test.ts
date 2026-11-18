import { describe, expect, it } from "vitest";
import { parseGitHubRemote, remoteMatching, resolveIdentity, shortUrl } from "./repo-identity";

const key = (url: string) => {
  const r = parseGitHubRemote(url);
  return r.ok ? r.identity.key : `ERROR: ${r.problem}`;
};

describe("parseGitHubRemote", () => {
  it("gives SSH and HTTPS clones of one repository the same key", () => {
    const urls = [
      "git@github.com:SEASTICK/0rqestra.git",
      "git@github.com:seastick/0rqestra",
      "ssh://git@github.com/SEASTICK/0rqestra.git",
      "ssh://git@ssh.github.com:443/SEASTICK/0rqestra.git",
      "git+ssh://git@github.com/SEASTICK/0rqestra.git",
      "https://github.com/SEASTICK/0rqestra.git",
      "https://github.com/SEASTICK/0rqestra",
      "https://github.com/SEASTICK/0rqestra/",
      "https://user:token@github.com/SEASTICK/0rqestra.git",
      "http://www.github.com/SEASTICK/0rqestra.GIT",
      "git://github.com/SEASTICK/0rqestra.git",
      "  https://GitHub.com/Seastick/0RQESTRA.git\n",
    ];
    for (const url of urls) expect(key(url), url).toBe("github.com/seastick/0rqestra");
  });

  it("keeps the owner and name as written, for display", () => {
    const r = parseGitHubRemote("git@github.com:SEASTICK/Repo.Name-1.git");
    expect(r.ok && r.identity).toMatchObject({ owner: "SEASTICK", name: "Repo.Name-1", key: "github.com/seastick/repo.name-1" });
  });

  it("tells different repositories apart", () => {
    expect(key("https://github.com/seastick/a.git")).not.toBe(key("https://github.com/seastick/b.git"));
    expect(key("https://github.com/one/repo.git")).not.toBe(key("https://github.com/two/repo.git"));
  });

  it("refuses remotes that are not one GitHub repository", () => {
    for (const url of [
      "",
      "https://gitlab.com/seastick/0rqestra.git",
      "git@bitbucket.org:seastick/0rqestra.git",
      "https://github.com/seastick",
      "https://github.com/seastick/0rqestra/tree/main",
      "https://github.com/seastick/0rqestra?tab=readme",
      "C:\\repos\\0rqestra",
      "/home/me/repos/0rqestra.git",
      "file:///C:/repos/0rqestra",
      "https://github.com/-bad/repo",
      "https://github.com/owner/..",
    ]) {
      expect(parseGitHubRemote(url).ok, url).toBe(false);
    }
  });

  it("never repeats credentials from a remote URL", () => {
    expect(shortUrl("https://user:secret@github.com/a/b.git")).toBe("https://github.com/a/b.git");
    const r = parseGitHubRemote("https://user:secret@gitlab.com/a/b.git");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});

describe("resolveIdentity", () => {
  it("explains a checkout without remotes", () => {
    const r = resolveIdentity([]);
    expect(r.status).toBe("missing");
    if (r.status !== "ok") expect(r.problem).toMatch(/git remote add/);
  });

  it("uses the one repository all GitHub remotes agree on, preferring origin", () => {
    const r = resolveIdentity([
      { name: "mirror", url: "git@github.com:seastick/demo.git" },
      { name: "origin", url: "https://github.com/seastick/demo.git" },
      { name: "backup", url: "https://gitlab.com/seastick/demo.git" },
    ]);
    expect(r.status === "ok" && [r.remote, r.identity.key]).toEqual(["origin", "github.com/seastick/demo"]);
  });

  it("asks the user to choose when remotes point to different repositories", () => {
    const remotes = [
      { name: "origin", url: "git@github.com:me/demo-fork.git" },
      { name: "upstream", url: "https://github.com/seastick/demo.git" },
    ];
    const r = resolveIdentity(remotes);
    expect(r.status).toBe("ambiguous");
    if (r.status !== "ok") expect(r.problem).toMatch(/Choose the remote/);
    const chosen = resolveIdentity(remotes, "upstream");
    expect(chosen.status === "ok" && chosen.identity.key).toBe("github.com/seastick/demo");
  });

  it("refuses a chosen remote that is missing or not on GitHub", () => {
    expect(resolveIdentity([{ name: "origin", url: "https://github.com/a/b" }], "nope").status).toBe("missing");
    expect(resolveIdentity([{ name: "origin", url: "https://gitlab.com/a/b" }], "origin").status).toBe("unsupported");
    expect(resolveIdentity([{ name: "origin", url: "https://gitlab.com/a/b" }]).status).toBe("unsupported");
  });
});

describe("remoteMatching", () => {
  it("accepts any remote that names the shared repository", () => {
    const remotes = [
      { name: "origin", url: "git@github.com:me/demo-fork.git" },
      { name: "upstream", url: "https://github.com/SEASTICK/demo.git" },
    ];
    expect(remoteMatching(remotes, "github.com/seastick/demo")?.name).toBe("upstream");
    expect(remoteMatching(remotes, "github.com/seastick/other")).toBeNull();
  });
});
