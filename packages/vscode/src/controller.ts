/**
 * Holds what the view shows and talks to the core: the cached view at startup, scans in the
 * background, reloads after a write or a team override change. All discovery, cache and
 * state logic is the core's; this class only decides when to call it.
 *
 * An automatic scan (after a file change) runs only when the fingerprint of the command,
 * skill and plugin files differs from the one taken when the last scan started: starting
 * Claude Code rewrites bookkeeping files in the watched folders, and must not cause another
 * scan (see refresh-policy.ts and the safety net in scheduler.ts).
 */
import os from 'node:os';
import {
  loadCachedView,
  scanAndCache,
  scanFiles,
  type Launcher,
  type ResolvedView,
  type ScanAndCacheOptions,
  type StoreOptions,
} from '@slashdeck/core';
import * as vscode from 'vscode';
import { definitionFingerprint } from './refresh-policy.js';
import { RefreshScheduler, type ScanKind } from './scheduler.js';
import {
  chooseTarget,
  userClaudeDir,
  viewStatus,
  type Target,
  type ViewStatus,
} from './workspace.js';

export const VIEW_ID = 'slashdeck.commands';
const FOLDER_KEY = 'slashdeck.folder';
/** Debounce of file-change refreshes. */
export const REFRESH_DELAY_MS = 1500;

/**
 * Used instead of starting Claude Code in an untrusted workspace: the core then falls back to
 * the command and skill files, which are only read.
 */
const refuseToLaunch: Launcher = () => {
  throw Object.assign(new Error('workspace not trusted'), { code: 'EPERM' });
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Controller implements vscode.Disposable {
  private targetValue: Target;
  private viewValue: ResolvedView | null = null;
  private scanError: string | null = null;
  /** Bumped when the target changes: results for an older target are dropped. */
  private generation = 0;
  private lastWarnings = '';
  /** Fingerprint of the definitions when the last scan started; null when unknown. */
  private baseline: string | null = null;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly targetEmitter = new vscode.EventEmitter<Target>();
  readonly onDidChangeTarget = this.targetEmitter.event;
  readonly scheduler: RefreshScheduler;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.targetValue = this.computeTarget();
    this.scheduler = new RefreshScheduler({
      scan: (kind) => this.scan(kind),
      reload: () => this.reload(),
      delayMs: REFRESH_DELAY_MS,
      isScanNeeded: () => this.definitionsChanged(),
      onError: (err) => this.log.error(`refresh failed: ${errorText(err)}`),
      onSkip: () => this.log.trace('no command, skill or plugin file changed: no scan'),
      onPauseChange: (paused) => {
        if (paused) {
          this.log.warn(
            'automatic refresh paused: scans kept being requested right after each other; ' +
              'use Refresh List to update the list and resume',
          );
        } else {
          this.log.info('automatic refresh resumed');
        }
        this.changeEmitter.fire();
      },
    });
  }

  get target(): Target {
    return this.targetValue;
  }

  get view(): ResolvedView | null {
    return this.viewValue;
  }

  status(t: (message: string, ...args: (string | number | boolean)[]) => string): ViewStatus {
    return viewStatus(
      {
        view: this.viewValue,
        scanning: this.scheduler.scanning,
        scanError: this.scanError,
        trusted: vscode.workspace.isTrusted,
        noFolder: this.targetValue.noFolder,
        autoRefreshPaused: this.scheduler.paused,
      },
      t,
    );
  }

  private computeTarget(): Target {
    const folders = (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => ({ name: f.name, path: f.uri.fsPath }));
    return chooseTarget(folders, this.context.workspaceState.get<string>(FOLDER_KEY), os.homedir());
  }

  storeOptions(): StoreOptions {
    return { workspace: this.targetValue.path };
  }

  private scanOptions(): ScanAndCacheOptions {
    const claudePath = vscode.workspace
      .getConfiguration('slashdeck')
      .get<string>('claudePath', '')
      .trim();
    const claudeDir = process.env.CLAUDE_CONFIG_DIR;
    return {
      workspace: this.targetValue.path,
      ...(claudePath !== '' && { claudePath }),
      ...(claudeDir !== undefined && claudeDir.trim() !== '' && { claudeDir }),
      ...(!vscode.workspace.isTrusted && { launcher: refuseToLaunch }),
    };
  }

  claudeDir(): string {
    return userClaudeDir(process.env, os.homedir());
  }

  /** Fingerprint of the command, skill and plugin files: reads files, starts no process. */
  private async fingerprint(): Promise<string> {
    const files = await scanFiles({
      workspace: this.targetValue.path,
      homeDir: os.homedir(),
      claudeDir: this.claudeDir(),
    });
    return definitionFingerprint(files);
  }

  private async fingerprintOrNull(): Promise<string | null> {
    try {
      return await this.fingerprint();
    } catch (err) {
      this.log.error(`cannot read the command files: ${errorText(err)}`);
      return null;
    }
  }

  /** Whether the definitions changed since the last scan started (unknown: true). */
  private async definitionsChanged(): Promise<boolean> {
    const baseline = this.baseline;
    if (baseline === null) return true;
    return (await this.fingerprint()) !== baseline;
  }

  /** Shows the cached view at once, then scans in the background when asked to. */
  async start(): Promise<void> {
    await this.reload();
    const refresh = vscode.workspace
      .getConfiguration('slashdeck')
      .get<boolean>('refreshOnStartup', true);
    if (refresh || this.viewValue === null) void this.scheduler.scanNow('event');
    // No scan: the saved list stands for the files as they are now.
    else this.baseline = await this.fingerprintOrNull();
  }

  /** Recomputes the folder to show (folders added or removed, or a new choice). */
  async updateTarget(remember?: string): Promise<void> {
    if (remember !== undefined) await this.context.workspaceState.update(FOLDER_KEY, remember);
    const next = this.computeTarget();
    if (next.path === this.targetValue.path && next.label === this.targetValue.label) return;
    this.generation++;
    this.targetValue = next;
    this.viewValue = null;
    this.scanError = null;
    this.lastWarnings = '';
    this.baseline = null;
    this.targetEmitter.fire(next);
    this.changeEmitter.fire();
    await this.reload();
    void this.scheduler.scanNow('event');
  }

  private async scan(kind: ScanKind): Promise<void> {
    const generation = this.generation;
    const options = this.scanOptions();
    // Taken before Claude Code starts: what it writes while starting is then compared with
    // the files as they were, and a real change made during the scan is not lost.
    const fingerprint = await this.fingerprintOrNull();
    if (generation !== this.generation) return;
    this.baseline = fingerprint;
    // A list is shown: a background refresh keeps it and shows no progress bar, which would
    // look like the view is still loading. A manual refresh shows it, as feedback.
    const showProgress = kind === 'manual' || this.viewValue === null;
    if (showProgress) this.changeEmitter.fire(); // scanning: the view may show "loading"
    const started = Date.now();
    try {
      const view = showProgress
        ? await vscode.window.withProgress({ location: { viewId: VIEW_ID } }, () =>
            scanAndCache(options),
          )
        : await scanAndCache(options);
      if (generation !== this.generation) return;
      this.viewValue = view;
      this.scanError = null;
      this.log.info(
        `scanned ${options.workspace} (${kind}): ${Object.keys(view.commands).length} ` +
          `commands, source ${view.source}, ${Date.now() - started} ms`,
      );
      this.logWarnings(view);
    } catch (err) {
      if (generation !== this.generation) return;
      this.scanError = errorText(err);
      this.log.error(`scan of ${options.workspace} failed: ${this.scanError}`);
    } finally {
      if (generation === this.generation) this.changeEmitter.fire();
    }
  }

  /** Reads the cached view again (after a write, or a team override or state change). */
  async reload(): Promise<void> {
    const generation = this.generation;
    try {
      const view = await loadCachedView(this.storeOptions());
      if (generation !== this.generation) return;
      // No cache (cleared by hand?): keep what is shown until the next scan.
      if (view) {
        this.viewValue = view;
        this.logWarnings(view);
      }
    } catch (err) {
      this.log.error(`cannot read the saved list: ${errorText(err)}`);
    }
    if (generation === this.generation) this.changeEmitter.fire();
  }

  /** Warnings go to the log only, and only when they change: never a notification. */
  private logWarnings(view: ResolvedView): void {
    const text = view.warnings.map((w) => `[${w.code}] ${w.message}`).join('\n');
    if (text === this.lastWarnings) return;
    this.lastWarnings = text;
    for (const w of view.warnings) this.log.warn(`[${w.code}] ${w.message}`);
  }

  dispose(): void {
    this.scheduler.dispose();
    this.changeEmitter.dispose();
    this.targetEmitter.dispose();
  }
}
