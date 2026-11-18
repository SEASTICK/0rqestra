// Whether the person is active on this computer, from the operating system's idle time (keyboard
// and mouse anywhere, not only in 0rqestra), so working in an editor counts as active.
// Ten minutes without input means inactive; any input makes them active again.

export const IDLE_THRESHOLD_SECONDS = 10 * 60;
export const POLL_MS = 15_000;

export function isActive(idleSeconds: number, thresholdSeconds = IDLE_THRESHOLD_SECONDS): boolean {
  return !(Number.isFinite(idleSeconds) && idleSeconds >= thresholdSeconds);
}

type Timer = unknown;

export class ActivityMonitor {
  private timer: Timer | null = null;
  private active = true;

  constructor(
    private readonly opts: {
      idleSeconds: () => number;
      onChange: (active: boolean) => void;
      thresholdSeconds?: number;
      pollMs?: number;
      setTimer?: (fn: () => void, ms: number) => Timer;
      clearTimer?: (timer: Timer) => void;
    },
  ) {}

  isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.timer) return;
    this.check();
    this.schedule();
  }

  stop(): void {
    if (this.timer) (this.opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  // Also called on system events (resume, unlock) for a quick answer.
  check(): void {
    const next = isActive(this.opts.idleSeconds(), this.opts.thresholdSeconds);
    if (next !== this.active) {
      this.active = next;
      this.opts.onChange(next);
    }
  }

  private schedule(): void {
    const set = this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      this.check();
      this.schedule();
    }, this.opts.pollMs ?? POLL_MS);
  }
}
