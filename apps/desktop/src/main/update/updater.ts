import { type PlatformKey, type UpdateConfig, parseManifest } from "./manifest";
import { verifyUpdateSignature } from "./signature";
import { isNewerVersion, parseSnooze, shouldCheckOnFocus, shouldPrompt, SNOOZE_MS } from "./version";

// The update flow, free of Electron so every path is unit-tested with fakes.
//
//   1. check     read latest.json from the public update site.
//   2. compare   only a strictly newer version is offered.
//   3. download  fetched in the background right away, then verified against the public key
//                built into the app. A file that fails verification is deleted and never offered.
//   4. install   only when the user chooses "Restart now".

export const text = {
  upToDate: "You have the latest version.",
  ready: "The update is downloaded and verified. The app restarts when you install it.",
  signature: "The update could not be verified and was not installed.",
  networkCheck: "Could not check for updates. Check your internet connection.",
  networkDownload: "The download was interrupted. Check your internet connection and try again.",
  platform: "The latest version is not available for this computer yet.",
  install: "The update could not be installed.",
  prepare: "Your projects could not be saved, so the update was not installed. Try again.",
} as const;

export type UpdateStatus = "idle" | "checking" | "current" | "downloading" | "ready" | "installing" | "error";

// What the window shows. Sent to the renderer on every change (index.ts).
export interface UpdateSnapshot {
  status: UpdateStatus;
  currentVersion: string;
  version?: string;
  notes?: string;
  // 0..1 while downloading when the size is known, otherwise null.
  progress: number | null;
}

export interface ReadyUpdate {
  version: string;
  notes: string;
  filePath: string;
}

export interface UpdateDiagnostics {
  checkedAt: number;
  result: "current" | "ready" | "error";
  version?: string;
  message?: string;
  detail?: string;
}

export interface UpdaterUi {
  promptReady(update: { version: string; currentVersion: string; notes: string }): Promise<"restart" | "later">;
  info(message: string): void;
  error(message: string, detail: string): void;
}

export interface UpdaterDeps {
  currentVersion: string;
  config: UpdateConfig;
  platform: PlatformKey | null;
  fetchText(url: string): Promise<string>;
  download(url: string, onProgress?: (fraction: number | null) => void): Promise<{ filePath: string; sha512Hex: string }>;
  discard(filePath: string): Promise<void>;
  // Installs the verified file and restarts the app.
  install(filePath: string): Promise<void>;
  // Returns null when installing may proceed, otherwise a message for the user.
  beforeInstall?(): Promise<string | null>;
  readSnooze(): string | null;
  writeSnooze(raw: string): void;
  now(): number;
  ui: UpdaterUi;
  // Called whenever the snapshot changes.
  onState?(snapshot: UpdateSnapshot): void;
}

const detailOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class Updater {
  status: UpdateStatus = "idle";
  diagnostics: UpdateDiagnostics | null = null;
  private ready: ReadyUpdate | null = null;
  private busy = false;
  private prompting = false;
  private lastCheck: number | null = null;
  private pending: { version: string; notes: string } | null = null;
  private progress: number | null = null;

  constructor(private readonly deps: UpdaterDeps) {}

  snapshot(): UpdateSnapshot {
    const shown = this.ready ?? this.pending;
    return {
      status: this.status,
      currentVersion: this.deps.currentVersion,
      progress: this.status === "downloading" ? this.progress : null,
      ...(shown ? { version: shown.version, notes: shown.notes } : {}),
    };
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status;
    this.deps.onState?.(this.snapshot());
  }

  // silent: started by the app itself (startup, timer, focus). Errors are then recorded, not shown.
  // A silent check also runs while an update is already downloaded: it picks up an even newer
  // release, and it asks again once a "Later" for the downloaded version has expired.
  async check(silent: boolean): Promise<void> {
    if (this.ready && !silent) {
      await this.prompt();
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      await this.checkAndDownload(silent);
    } finally {
      this.busy = false;
    }
    // Read through a method: checkAndDownload sets this.ready, which TypeScript cannot see here.
    const ready = this.readyUpdate();
    if (ready && (!silent || this.maySilentlyPrompt(ready.version))) await this.prompt();
  }

  private readyUpdate(): ReadyUpdate | null {
    return this.ready;
  }

  async checkOnFocus(): Promise<void> {
    if (shouldCheckOnFocus(this.lastCheck, this.deps.now())) await this.check(true);
  }

  private maySilentlyPrompt(version: string): boolean {
    return shouldPrompt(version, parseSnooze(this.deps.readSnooze()), this.deps.now());
  }

  private fail(silent: boolean, message: string, detail: string, version?: string): void {
    // A failed background check never hides an update that is already downloaded and verified.
    this.setStatus(this.ready ? "ready" : "error");
    this.diagnostics = {
      checkedAt: this.deps.now(),
      result: "error",
      message,
      detail,
      ...(version === undefined ? {} : { version }),
    };
    if (!silent) this.deps.ui.error(message, detail);
  }

  private async checkAndDownload(silent: boolean): Promise<void> {
    const { config, currentVersion } = this.deps;
    if (!this.ready) this.setStatus("checking");
    this.lastCheck = this.deps.now();
    // A version already downloaded is the baseline: only something newer than it is fetched.
    const baseline = this.ready?.version ?? currentVersion;

    let manifest;
    try {
      manifest = parseManifest(await this.deps.fetchText(`${config.feedUrl}/latest.json`), config.downloadBase);
    } catch (error) {
      this.fail(silent, text.networkCheck, detailOf(error));
      return;
    }
    if (!isNewerVersion(manifest.version, baseline)) {
      if (this.ready) return;
      this.setStatus("current");
      this.diagnostics = { checkedAt: this.deps.now(), result: "current" };
      if (!silent) this.deps.ui.info(text.upToDate);
      return;
    }
    const entry = this.deps.platform ? manifest.platforms[this.deps.platform] : undefined;
    if (!entry) {
      this.fail(silent, text.platform, `no ${this.deps.platform ?? "supported"} file in latest.json`, manifest.version);
      return;
    }

    // A newer release replaces an update that was downloaded earlier but not installed.
    if (this.ready) {
      await this.deps.discard(this.ready.filePath).catch(() => undefined);
      this.ready = null;
    }
    this.pending = { version: manifest.version, notes: manifest.notes };
    this.progress = null;
    this.setStatus("downloading");
    let file;
    try {
      file = await this.deps.download(entry.url, (fraction) => {
        this.progress = fraction === null ? null : Math.max(0, Math.min(1, fraction));
        this.deps.onState?.(this.snapshot());
      });
    } catch (error) {
      this.pending = null;
      this.fail(silent, text.networkDownload, detailOf(error), manifest.version);
      return;
    }
    if (!verifyUpdateSignature(config.publicKey, manifest.version, file.sha512Hex, entry.signature)) {
      await this.deps.discard(file.filePath).catch(() => undefined);
      this.pending = null;
      this.fail(silent, text.signature, "signature does not match the downloaded file", manifest.version);
      return;
    }
    this.ready = { version: manifest.version, notes: manifest.notes, filePath: file.filePath };
    this.pending = null;
    this.diagnostics = { checkedAt: this.deps.now(), result: "ready", version: manifest.version };
    this.setStatus("ready");
  }

  private async prompt(): Promise<void> {
    const ready = this.ready;
    if (!ready || this.prompting) return;
    this.prompting = true;
    try {
      const choice = await this.deps.ui.promptReady({
        version: ready.version,
        currentVersion: this.deps.currentVersion,
        notes: ready.notes,
      });
      if (choice === "later") {
        this.deps.writeSnooze(JSON.stringify({ version: ready.version, untilUnixMs: this.deps.now() + SNOOZE_MS }));
        return;
      }
      // Saves project state and refuses while work is active. Anything unexpected also blocks:
      // the update is never installed without a confirmed save.
      let blocked: string | null;
      try {
        blocked = (await this.deps.beforeInstall?.()) ?? null;
      } catch (error) {
        blocked = `${text.prepare} (${detailOf(error)})`;
      }
      if (blocked) {
        this.deps.ui.error(blocked, "");
        return;
      }
      this.setStatus("installing");
      try {
        await this.deps.install(ready.filePath);
      } catch (error) {
        // The downloaded file is kept, so "Restart now" can be tried again.
        this.setStatus("ready");
        this.deps.ui.error(text.install, detailOf(error));
      }
    } finally {
      this.prompting = false;
    }
  }
}
