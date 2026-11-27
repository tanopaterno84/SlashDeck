import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Debouncer, RefreshScheduler, type ScanKind } from '../src/scheduler.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A promise that the test resolves by hand. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe('Debouncer', () => {
  it('runs once after a burst of triggers, delay counted from the last one', () => {
    const fn = vi.fn();
    const d = new Debouncer(100, fn);
    d.trigger();
    vi.advanceTimersByTime(60);
    d.trigger();
    vi.advanceTimersByTime(60);
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending).toBe(true);
    vi.advanceTimersByTime(40);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.pending).toBe(false);
  });

  it('can be cancelled and disposed', () => {
    const fn = vi.fn();
    const d = new Debouncer(100, fn);
    d.trigger();
    d.cancel();
    d.trigger();
    d.dispose();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('RefreshScheduler', () => {
  function make() {
    const scan = vi.fn(async () => {});
    const reload = vi.fn(async () => {});
    const onError = vi.fn();
    const scheduler = new RefreshScheduler({ scan, reload, delayMs: 1000, onError });
    return { scan, reload, onError, scheduler };
  }

  it('turns a burst of file changes into one scan', async () => {
    const { scan, reload, scheduler } = make();
    for (let i = 0; i < 5; i++) {
      scheduler.requestScan();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(scan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads without scanning when only the team override changed', async () => {
    const { scan, reload, scheduler } = make();
    scheduler.requestReload();
    scheduler.requestReload();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(scan).not.toHaveBeenCalled();
  });

  it('still reloads when a scan was requested too (the scan may be skipped)', async () => {
    const { scan, reload, scheduler } = make();
    scheduler.requestReload();
    scheduler.requestScan();
    scheduler.requestReload();
    await vi.advanceTimersByTimeAsync(1000);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never runs two scans at once and queues one more at most', async () => {
    const { scan, scheduler } = make();
    let running = 0;
    let maxRunning = 0;
    const gates = [gate(), gate()];
    scan.mockImplementation(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await gates[scan.mock.calls.length - 1]!.promise;
      running--;
    });
    const first = scheduler.scanNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.scanning).toBe(true);
    const second = scheduler.scanNow();
    const third = scheduler.scanNow();
    expect(second).toBe(third); // callers during a scan share the queued one
    gates[0]!.open();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(scan).toHaveBeenCalledTimes(2);
    gates[1]!.open();
    await second;
    expect(scan).toHaveBeenCalledTimes(2);
    expect(maxRunning).toBe(1);
    expect(scheduler.scanning).toBe(false);
  });

  it('is "scanning" from the moment the scan starts', async () => {
    const { scan, scheduler } = make();
    const seen: boolean[] = [];
    scan.mockImplementation(async () => {
      seen.push(scheduler.scanning);
    });
    await scheduler.scanNow();
    expect(seen).toEqual([true]);
    await scheduler.idle();
  });

  it('reloads after the running scan, never before it ends', async () => {
    const { scan, reload, scheduler } = make();
    const g = gate();
    const order: string[] = [];
    scan.mockImplementation(async () => {
      await g.promise;
      order.push('scan');
    });
    reload.mockImplementation(async () => {
      order.push('reload');
    });
    void scheduler.scanNow();
    const reloaded = scheduler.reloadNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([]);
    g.open();
    await reloaded;
    expect(order).toEqual(['scan', 'reload']);
  });

  it('reports errors without rejecting', async () => {
    const { scan, onError, scheduler } = make();
    scan.mockRejectedValueOnce(new Error('boom'));
    await expect(scheduler.scanNow()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(scheduler.scanning).toBe(false);
  });

  it('does nothing after dispose', async () => {
    const { scan, reload, scheduler } = make();
    scheduler.requestScan();
    scheduler.dispose();
    scheduler.requestScan();
    scheduler.requestReload();
    await scheduler.scanNow();
    await scheduler.reloadNow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(scan).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('RefreshScheduler: automatic scans only when something changed', () => {
  it('skips the scan when the check says nothing changed (bookkeeping only)', async () => {
    const scan = vi.fn(async () => {});
    const onSkip = vi.fn();
    const scheduler = new RefreshScheduler({
      scan,
      reload: async () => {},
      delayMs: 1000,
      isScanNeeded: async () => false,
      onSkip,
    });
    for (let i = 0; i < 20; i++) {
      scheduler.requestScan();
      await vi.advanceTimersByTimeAsync(3000);
    }
    expect(scan).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledTimes(20);
    expect(scheduler.skippedScans).toBe(20);
    expect(scheduler.automaticScans).toBe(0);
  });

  it('scans exactly once for a real change, and once for a burst', async () => {
    let changed = true;
    const scan = vi.fn(async (_kind: ScanKind) => {
      changed = false; // the scan takes the new baseline
    });
    const scheduler = new RefreshScheduler({
      scan,
      reload: async () => {},
      delayMs: 1000,
      isScanNeeded: async () => changed,
    });
    for (let i = 0; i < 10; i++) {
      scheduler.requestScan();
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith('auto');
    // Bookkeeping events afterwards: no scan.
    scheduler.requestScan();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('counts a failed check as a change', async () => {
    const scan = vi.fn(async () => {});
    const onError = vi.fn();
    const scheduler = new RefreshScheduler({
      scan,
      reload: async () => {},
      delayMs: 1000,
      isScanNeeded: async () => {
        throw new Error('unreadable');
      },
      onError,
    });
    scheduler.requestScan();
    await vi.advanceTimersByTimeAsync(1000);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalled();
  });
});

describe('RefreshScheduler: safety net', () => {
  const net = { minIntervalMs: 10_000, maxIntervalMs: 300_000, quietMs: 60_000, maxStreak: 6 };
  const SCAN_MS = 4000;

  /** Scans that, like Claude Code starting, cause a file event while they run. */
  function loop(check: () => Promise<boolean> = async () => true) {
    const started: number[] = [];

    const scan = vi.fn(async (_kind: ScanKind) => {
      started.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, SCAN_MS));
      scheduler.requestScan();
    });
    const onPauseChange = vi.fn();
    const scheduler: RefreshScheduler = new RefreshScheduler({
      scan,
      reload: async () => {},
      delayMs: 1500,
      // The default: a broken check that always says "changed".
      isScanNeeded: check,
      safetyNet: net,
      onPauseChange,
    });
    return { scheduler, scan, started, onPauseChange };
  }

  it('keeps the minimum interval after any scan', async () => {
    const scan = vi.fn(async () => {});
    const scheduler = new RefreshScheduler({
      scan,
      reload: async () => {},
      delayMs: 1000,
      isScanNeeded: async () => true,
      safetyNet: net,
    });
    await scheduler.scanNow('event');
    const end = Date.now();
    scheduler.requestScan();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(Date.now() - end).toBe(10_000);
  });

  it('backs off, then pauses, under a continuous stream of scan-triggered events', async () => {
    const { scheduler, scan, started, onPauseChange } = loop();
    void scheduler.scanNow('event'); // startup
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000); // three hours
    // The startup scan, then 5 automatic scans with doubling gaps, then the breaker.
    expect(scheduler.automaticScans).toBe(5);
    expect(scan).toHaveBeenCalledTimes(6);
    expect(scheduler.paused).toBe(true);
    expect(onPauseChange).toHaveBeenCalledWith(true);
    const gaps = started.slice(1).map((t, i) => t - started[i]! - SCAN_MS);
    expect(gaps).toEqual([10_000, 20_000, 40_000, 80_000, 160_000]);
    // Events keep coming: nothing more runs.
    for (let i = 0; i < 50; i++) {
      scheduler.requestScan();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(scan).toHaveBeenCalledTimes(6);
  });

  it('caps the interval', async () => {
    const started: number[] = [];

    const scheduler: RefreshScheduler = new RefreshScheduler({
      scan: async () => {
        started.push(Date.now());
        scheduler.requestScan();
      },
      reload: async () => {},
      delayMs: 1000,
      safetyNet: { ...net, maxStreak: 100 },
    });
    void scheduler.scanNow('event');
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    const gaps = started.slice(1).map((t, i) => t - started[i]!);
    expect(gaps.slice(0, 7)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    expect(Math.max(...gaps)).toBe(300_000);
    expect(scheduler.currentIntervalMs()).toBe(300_000);
    scheduler.dispose();
  });

  it('a quiet period ends the streak', async () => {
    const scan = vi.fn(async () => {});
    const scheduler = new RefreshScheduler({
      scan,
      reload: async () => {},
      delayMs: 1000,
      safetyNet: net,
    });
    await scheduler.scanNow('event');
    scheduler.requestScan(); // right after the scan: back to back
    await vi.advanceTimersByTimeAsync(15_000);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scheduler.streak).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    scheduler.requestScan(); // after a quiet period
    await vi.advanceTimersByTimeAsync(2_000);
    expect(scan).toHaveBeenCalledTimes(3);
    expect(scheduler.streak).toBe(0);
  });

  it('a manual refresh runs at once, during a pause or an interval, and resumes', async () => {
    const { scheduler, scan, onPauseChange } = loop();
    void scheduler.scanNow('event');
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(scheduler.paused).toBe(true);
    const paused = scan.mock.calls.length;

    void scheduler.scanNow('manual');
    await vi.advanceTimersByTimeAsync(0);
    expect(scan).toHaveBeenCalledTimes(paused + 1);
    expect(scan).toHaveBeenLastCalledWith('manual');
    expect(scheduler.paused).toBe(false);
    expect(scheduler.streak).toBe(0);
    expect(onPauseChange).toHaveBeenLastCalledWith(false);

    // The manual scan ends and triggers an event: the next automatic scan waits 10 s.
    await vi.advanceTimersByTimeAsync(SCAN_MS + 3000);
    expect(scan).toHaveBeenCalledTimes(paused + 1);
    void scheduler.scanNow('manual');
    await vi.advanceTimersByTimeAsync(0);
    expect(scan).toHaveBeenCalledTimes(paused + 2);
    expect(scan).toHaveBeenLastCalledWith('manual');
    scheduler.dispose();
  });

  it('an explicit non-manual scan runs at once but does not lift a pause', async () => {
    const { scheduler, scan } = loop();
    void scheduler.scanNow('event');
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(scheduler.paused).toBe(true);
    const paused = scan.mock.calls.length;
    void scheduler.scanNow('event');
    await vi.advanceTimersByTimeAsync(0);
    expect(scan).toHaveBeenCalledTimes(paused + 1);
    expect(scheduler.paused).toBe(true);
    scheduler.dispose();
  });

  it('with a working check, scan-triggered events cause no scan at all', async () => {
    const { scheduler, scan } = loop(async () => false);
    void scheduler.scanNow('event');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scheduler.automaticScans).toBe(0);
    expect(scheduler.paused).toBe(false);
  });

  it('stops waiting when disposed', async () => {
    const scan = vi.fn(async () => {});
    const scheduler = new RefreshScheduler({
      scan,
      reload: async () => {},
      delayMs: 1000,
      safetyNet: net,
    });
    await scheduler.scanNow('event');
    scheduler.requestScan();
    await vi.advanceTimersByTimeAsync(2000); // now waiting for the interval
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.idle();
    expect(scan).toHaveBeenCalledTimes(1);
  });
});
