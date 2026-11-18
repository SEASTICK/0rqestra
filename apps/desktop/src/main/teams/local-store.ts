import fs from "node:fs";
import path from "node:path";
import type { AuthSession } from "./supabase-api";

// What Teams keeps on this computer: the signed-in session (encrypted by the operating system) and
// which local checkout is linked to which shared project. Checkout paths are never sent anywhere.

export interface SecretBox {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface CheckoutLink {
  // The 0rqestra project on this computer.
  localProjectId: string;
  sharedProjectId: string;
  teamId: string;
  repoKey: string;
  path: string;
  // The Supabase account and project the link belongs to, so another account on this computer
  // does not see it.
  userId: string;
  server: string;
  linkedAt: string;
}

function writeAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class SessionStore {
  constructor(
    private readonly file: string,
    private readonly box: SecretBox,
  ) {}

  // False when the system offers no encryption (some Linux setups): the session then lasts only
  // until the app quits.
  canPersist(): boolean {
    return this.box.available();
  }

  load(server: string): AuthSession | null {
    if (!this.box.available()) return null;
    let data: Buffer;
    try {
      data = fs.readFileSync(this.file);
    } catch {
      return null;
    }
    try {
      const v = JSON.parse(this.box.decrypt(data)) as { server?: unknown; session?: AuthSession };
      const s = v.session;
      if (v.server !== server || !s || typeof s.accessToken !== "string" || typeof s.refreshToken !== "string" || typeof s.expiresAt !== "number" || typeof s.user?.id !== "string") return null;
      return { accessToken: s.accessToken, refreshToken: s.refreshToken, expiresAt: s.expiresAt, user: { id: s.user.id, email: typeof s.user.email === "string" ? s.user.email : "" } };
    } catch {
      return null;
    }
  }

  save(server: string, session: AuthSession): void {
    if (!this.box.available()) return;
    writeAtomic(this.file, this.box.encrypt(JSON.stringify({ server, session })));
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}

export class LinkStore {
  constructor(private readonly file: string) {}

  all(): CheckoutLink[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8")) as { links?: unknown };
      if (!Array.isArray(v.links)) return [];
      return v.links.filter((l): l is CheckoutLink => {
        const x = (l ?? {}) as Record<string, unknown>;
        return ["localProjectId", "sharedProjectId", "teamId", "repoKey", "path", "userId", "server", "linkedAt"].every((k) => typeof x[k] === "string");
      });
    } catch {
      return [];
    }
  }

  private write(links: CheckoutLink[]): void {
    writeAtomic(this.file, JSON.stringify({ version: 1, links }, null, 2));
  }

  // One link per local project, and per shared project for one account.
  put(link: CheckoutLink): void {
    const rest = this.all().filter(
      (l) => l.localProjectId !== link.localProjectId && !(l.sharedProjectId === link.sharedProjectId && l.userId === link.userId && l.server === link.server),
    );
    this.write([...rest, link]);
  }

  remove(predicate: (l: CheckoutLink) => boolean): void {
    const all = this.all();
    const keep = all.filter((l) => !predicate(l));
    if (keep.length !== all.length) this.write(keep);
  }
}
