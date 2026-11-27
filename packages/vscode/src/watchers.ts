/**
 * File watchers from the specs of workspace.ts. Events that cannot change a command
 * (refresh-policy.ts) are dropped here; the others go to the scheduler, which debounces them
 * and scans only if the definitions really changed.
 */
import * as vscode from 'vscode';
import { isDefinitionChange, relativeSegments, type ChangeType } from './refresh-policy.js';
import type { RefreshScheduler } from './scheduler.js';
import type { WatchSpec } from './workspace.js';

export class Watchers implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  /** Events dropped by the name filter, and passed on (for the log and the tests). */
  ignored = 0;
  accepted = 0;

  constructor(
    private readonly scheduler: RefreshScheduler,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Replaces the watchers with those of `specs`. */
  watch(specs: readonly WatchSpec[]): void {
    this.clear();
    for (const spec of specs) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(spec.base), spec.glob),
      );
      const on = (type: ChangeType) => (uri: vscode.Uri) => {
        const segments = relativeSegments(spec.base, uri.fsPath);
        if (!isDefinitionChange(spec.area, segments, type)) {
          this.ignored++;
          this.log.trace(`ignored (${type}): ${uri.fsPath}`);
          return;
        }
        this.accepted++;
        this.log.trace(`changed (${type}): ${uri.fsPath}`);
        if (spec.rewatch && type !== 'change') this.watch(specs);
        if (spec.effect === 'scan') this.scheduler.requestScan();
        else this.scheduler.requestReload();
      };
      this.disposables.push(
        watcher,
        watcher.onDidCreate(on('create')),
        watcher.onDidChange(on('change')),
        watcher.onDidDelete(on('delete')),
      );
    }
  }

  private clear(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  dispose(): void {
    this.clear();
  }
}
