/**
 * When to scan and reload. No `vscode` import.
 *
 * - A file change asks for a scan (`requestScan`: a command, skill or plugin file may have
 *   changed) or only a reload (`requestReload`: team override or user state; no need to
 *   start Claude Code). Bursts of changes are debounced into one call.
 * - An automatic scan runs only if `isScanNeeded` says the definitions really changed
 *   (refresh-policy.ts). A reload never writes anything the watchers react to.
 * - Scans never overlap: a scan requested while one runs is queued once, and all the callers
 *   that asked meanwhile share it. A reload waits for the running scan, so that it never
 *   shows an older view after a newer.
 *
 * Safety net for automatic scans, independent of the filters and of `isScanNeeded`, so that
 * no mistake there can bring back an endless loop of scans (each one starts Claude Code):
 * - minimum interval: an automatic scan starts at least `minIntervalMs` after the end of the
 *   previous scan, whatever started it; requests in between are merged into one;
 * - backoff: an automatic scan requested less than `quietMs` after the end of the previous
 *   scan (or while it ran: the pattern of a scan triggering the next) extends a streak, and
 *   the interval doubles with each scan of the streak, up to `maxIntervalMs`; a request after
 *   a quiet period ends the streak;
 * - circuit breaker: when the streak reaches `maxStreak`, automatic scans are paused until
 *   the user refreshes by hand (`onPause` tells the view).
 * Explicit scans (`scanNow`: Refresh, startup, folder change, trust, settings) bypass all of
 * this and run at once; a manual Refresh also ends the streak and lifts the pause.
 */

export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly delayMs: number,
    private readonly fn: () => void,
  ) {}

  trigger(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.fn();
    }, this.delayMs);
  }

  get pending(): boolean {
    return this.timer !== undefined;
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.cancel();
  }
}

/** `auto`: file watchers; `event`: startup, folder, trust, settings; `manual`: Refresh. */
export type ScanKind = 'auto' | 'event' | 'manual';

export interface SafetyNet {
  /** Minimum time between the end of a scan and the start of an automatic one. */
  minIntervalMs: number;
  /** Cap of the doubled interval. */
  maxIntervalMs: number;
  /** A request this long after the end of the last scan ends the streak. */
  quietMs: number;
  /** Streak length at which automatic scans are paused. */
  maxStreak: number;
}

export const DEFAULT_SAFETY_NET: SafetyNet = {
  minIntervalMs: 10_000,
  maxIntervalMs: 300_000,
  quietMs: 60_000,
  maxStreak: 6,
};

export interface RefreshSchedulerOptions {
  scan: (kind: ScanKind) => Promise<void>;
  reload: () => Promise<void>;
  /** Debounce delay of `requestScan` and `requestReload`. */
  delayMs: number;
  /**
   * Asked before each automatic scan, after the debounce and the interval: false skips the
   * scan. A rejection counts as true (the safety net still applies).
   */
  isScanNeeded?: () => Promise<boolean>;
  safetyNet?: Partial<SafetyNet>;
  /** Clock, for tests; default Date.now. */
  now?: () => number;
  /** Called with any error thrown by `scan`, `reload` or `isScanNeeded`. */
  onError?: (err: unknown) => void;
  /** An automatic scan was skipped: nothing that defines a command changed. */
  onSkip?: () => void;
  /** Automatic scans were paused, or resumed (false) by a manual refresh. */
  onPauseChange?: (paused: boolean) => void;
}

interface Pending {
  /** When the first change of the batch arrived. */
  since: number;
}

export class RefreshScheduler {
  private readonly scanDebouncer: Debouncer;
  private readonly reloadDebouncer: Debouncer;
  private readonly net: SafetyNet;
  private readonly now: () => number;
  private inFlight: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private pending: Pending | null = null;
  private evaluating: Promise<void> | null = null;
  private wake: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;
  private lastScanEnd: number | null = null;
  private streakValue = 0;
  private pausedValue = false;
  private autoScans = 0;
  private skipped = 0;
  private disposed = false;

  constructor(private readonly options: RefreshSchedulerOptions) {
    this.net = { ...DEFAULT_SAFETY_NET, ...options.safetyNet };
    this.now = options.now ?? Date.now;
    this.scanDebouncer = new Debouncer(options.delayMs, () => this.evaluate());
    this.reloadDebouncer = new Debouncer(options.delayMs, () => void this.reloadNow());
  }

  /** A command, skill or plugin file may have changed: scan if needed, within the limits. */
  requestScan(): void {
    if (this.disposed || this.pausedValue) return;
    this.pending ??= { since: this.now() };
    this.scanDebouncer.trigger();
  }

  /** Only the team override or the user state changed: reload the view, no scan. */
  requestReload(): void {
    if (this.disposed) return;
    this.reloadDebouncer.trigger();
  }

  get scanning(): boolean {
    return this.inFlight !== null;
  }

  /** Automatic scans are paused by the circuit breaker until a manual refresh. */
  get paused(): boolean {
    return this.pausedValue;
  }

  /** Length of the current streak of back-to-back automatic scans. */
  get streak(): number {
    return this.streakValue;
  }

  /** Automatic scans started so far (for tests and the log). */
  get automaticScans(): number {
    return this.autoScans;
  }

  /** Automatic scans skipped because nothing that defines a command changed. */
  get skippedScans(): number {
    return this.skipped;
  }

  /** Interval required before the next automatic scan, after the end of the last scan. */
  currentIntervalMs(): number {
    return Math.min(this.net.minIntervalMs * 2 ** this.streakValue, this.net.maxIntervalMs);
  }

  /**
   * Scans now, or once more after the running scan, bypassing the debounce, the check and the
   * safety net. `manual` (the Refresh command) also ends the streak and lifts the pause.
   * Never rejects.
   */
  scanNow(kind: Exclude<ScanKind, 'auto'> = 'manual'): Promise<void> {
    this.scanDebouncer.cancel();
    if (this.disposed) return Promise.resolve();
    // This scan starts after every change seen so far: it covers them.
    this.pending = null;
    this.wakeUp();
    if (kind === 'manual') {
      this.streakValue = 0;
      if (this.pausedValue) {
        this.pausedValue = false;
        this.options.onPauseChange?.(false);
      }
    }
    return this.runScan(kind);
  }

  /** Reloads the view after the running scan, if any. Never rejects. */
  reloadNow(): Promise<void> {
    this.reloadDebouncer.cancel();
    if (this.disposed) return Promise.resolve();
    const after = this.queued ?? this.inFlight ?? Promise.resolve();
    return after.then(() => this.safely(this.options.reload));
  }

  private runScan(kind: ScanKind): Promise<void> {
    if (!this.inFlight) return this.startScan(kind);
    this.queued ??= this.inFlight.then(() => {
      this.queued = null;
      return this.disposed ? undefined : this.startScan(kind);
    });
    return this.queued;
  }

  private startScan(kind: ScanKind): Promise<void> {
    // The scan starts on the next microtask, so that `scanning` is already true when it runs.
    const run = Promise.resolve()
      .then(() => this.safely(() => this.options.scan(kind)))
      .finally(() => {
        this.inFlight = null;
        this.lastScanEnd = this.now();
      });
    this.inFlight = run;
    return run;
  }

  /** After the debounce: one evaluation loop at a time handles the pending request. */
  private evaluate(): void {
    if (this.evaluating || this.disposed) return;
    this.evaluating = this.evaluationLoop().finally(() => {
      this.evaluating = null;
    });
  }

  private async evaluationLoop(): Promise<void> {
    while (this.pending && !this.disposed && !this.pausedValue) {
      // The end of the running scan moves the earliest start of the next one.
      if (this.inFlight || this.queued) {
        await (this.queued ?? this.inFlight);
        continue;
      }
      const wait =
        this.lastScanEnd === null ? 0 : this.lastScanEnd + this.currentIntervalMs() - this.now();
      if (wait > 0) {
        await this.sleep(wait);
        continue;
      }
      const request = this.pending;
      this.pending = null;
      let needed = true;
      if (this.options.isScanNeeded) {
        try {
          needed = await this.options.isScanNeeded();
        } catch (err) {
          this.options.onError?.(err);
        }
      }
      if (this.disposed || this.pausedValue) return;
      if (!needed) {
        this.skipped++;
        this.options.onSkip?.();
        continue;
      }
      // An explicit scan started during the check: it covers this change.
      if (this.inFlight || this.queued) continue;
      const backToBack =
        this.lastScanEnd !== null && request.since - this.lastScanEnd < this.net.quietMs;
      this.streakValue = backToBack ? this.streakValue + 1 : 0;
      if (this.streakValue >= this.net.maxStreak) {
        this.pausedValue = true;
        this.pending = null;
        this.options.onPauseChange?.(true);
        return;
      }
      this.autoScans++;
      await this.runScan('auto');
    }
  }

  /** Waits `ms`, or less if woken up by an explicit scan or dispose. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = { timer, resolve };
    });
  }

  private wakeUp(): void {
    if (!this.wake) return;
    clearTimeout(this.wake.timer);
    const { resolve } = this.wake;
    this.wake = null;
    resolve();
  }

  /**
   * Resolves when no scan is running or queued and no automatic request is being evaluated
   * (for tests and the integration test). Does not wait for a debounce still pending.
   */
  async idle(): Promise<void> {
    while (this.inFlight || this.queued || this.evaluating) {
      await (this.queued ?? this.inFlight ?? this.evaluating);
    }
  }

  private async safely(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.options.onError?.(err);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.scanDebouncer.dispose();
    this.reloadDebouncer.dispose();
    this.wakeUp();
  }
}
