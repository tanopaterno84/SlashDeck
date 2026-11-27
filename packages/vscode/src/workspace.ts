/**
 * Which folder the view shows, the folders to watch and the state message of the view.
 * No `vscode` import.
 */
import path from 'node:path';
import type { ResolvedView } from '@slashdeck/core';
import type { Translate } from './l10n.js';
import type { WatchArea } from './refresh-policy.js';

export interface FolderInfo {
  name: string;
  /** File system path of the workspace folder. */
  path: string;
}

export interface Target {
  /** Folder passed to the core as `workspace`. */
  path: string;
  /** Shown as the view description; empty for a single folder. */
  label: string;
  /** No folder open: the home folder is scanned, so there are no project commands. */
  noFolder: boolean;
}

/**
 * - No folder open: the home folder. The core then lists personal, plugin and built-in
 *   commands (the project folder `~/.claude` is the user folder, scanned once).
 * - One folder: that folder.
 * - Several folders: the one chosen earlier with "Select Workspace Folder" if it is still
 *   open, else the first one, like Claude Code, which starts in the first folder.
 */
export function chooseTarget(
  folders: readonly FolderInfo[],
  remembered: string | undefined,
  homeDir: string,
): Target {
  const first = folders[0];
  if (!first) return { path: homeDir, label: '', noFolder: true };
  if (folders.length === 1) return { path: first.path, label: '', noFolder: false };
  const chosen = folders.find((f) => f.path === remembered) ?? first;
  return { path: chosen.path, label: chosen.name, noFolder: false };
}

/** The user's Claude Code folder: `CLAUDE_CONFIG_DIR` when set (as the core CLI does), else ~/.claude. */
export function userClaudeDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  return configured !== undefined && configured.trim() !== ''
    ? path.resolve(configured)
    : path.join(homeDir, '.claude');
}

export interface WatchSpec {
  /** Folder the glob is relative to. */
  base: string;
  glob: string;
  /** `scan`: commands may have changed; `reload`: only texts or pins did. */
  effect: 'scan' | 'reload';
  /** What the folder holds: decides which events are definition changes (refresh-policy.ts). */
  area: WatchArea;
  /** A watched folder may have appeared: the watchers are recreated. */
  rewatch?: boolean;
}

/**
 * What to watch (CLAUDE.md, "Scansione dei file"):
 * - workspace: `.claude/commands/**`, `.claude/skills/**` (scan), `.claude/slashdeck.json`
 *   (reload: the team override is applied when reading, no scan needed);
 * - user folder: `commands/**`, `skills/**` (synced skills included), the plugin registry
 *   and the synced plugins (scan);
 * - SlashDeck's user state, changed by another window or by the CLI (reload).
 * With no folder open the workspace is the home folder, whose `.claude` is the user folder.
 * The globs are wide; `isDefinitionChange` then drops the events that cannot change a
 * command (bookkeeping written by Claude Code when it starts, skill resources...).
 */
export function watchSpecs(target: Target, claudeDir: string, configDir: string): WatchSpec[] {
  const specs: WatchSpec[] = [];
  if (!target.noFolder) {
    specs.push(
      { base: target.path, glob: '.claude/{commands,skills}/**', effect: 'scan', area: 'project' },
      { base: target.path, glob: '.claude/slashdeck.json', effect: 'reload', area: 'file' },
    );
  }
  specs.push(
    { base: path.join(claudeDir, 'commands'), glob: '**', effect: 'scan', area: 'commands' },
    { base: path.join(claudeDir, 'skills'), glob: '**', effect: 'scan', area: 'skills' },
    // Non-recursive: notices `commands` or `skills` being created after activation, when
    // the recursive watchers above may have had nothing to watch.
    { base: claudeDir, glob: '{commands,skills}', effect: 'scan', area: 'roots', rewatch: true },
    {
      base: path.join(claudeDir, 'plugins'),
      glob: '{installed_plugins.json,synced/**}',
      effect: 'scan',
      area: 'plugins',
    },
    // Written by this extension too (pins, edits): a reload only reads, so it cannot loop.
    { base: configDir, glob: 'state.json', effect: 'reload', area: 'file' },
  );
  return specs;
}

export type ViewState = 'loading' | 'empty' | 'error' | 'ready';

export interface ViewStatusInput {
  view: ResolvedView | null;
  scanning: boolean;
  /** Message of the last failed scan; null after a successful one. */
  scanError: string | null;
  trusted: boolean;
  noFolder: boolean;
  /** Automatic refreshes paused by the safety net of the scheduler. */
  autoRefreshPaused?: boolean;
}

export interface ViewStatus {
  /** Drives the welcome content of the view (`slashdeck.viewState` context key). */
  state: ViewState;
  /** Shown above the tree; undefined for none. */
  message: string | undefined;
}

export function viewStatus(input: ViewStatusInput, t: Translate): ViewStatus {
  const { view } = input;
  if (!view) {
    return {
      state: input.scanError !== null && !input.scanning ? 'error' : 'loading',
      message: undefined,
    };
  }
  const notes: string[] = [];
  if (!input.trusted) {
    notes.push(
      t(
        'Restricted Mode: Claude Code is not started for an untrusted folder, so built-in commands are missing.',
      ),
    );
  } else if (view.source === 'files') {
    notes.push(
      t(
        'Claude Code did not answer, so built-in commands are missing: only command, skill and plugin files are shown.',
      ),
    );
    if (view.warnings.some((w) => w.code === 'cli-not-found')) {
      notes.push(t('Claude Code was not found: set "slashdeck.claudePath".'));
    }
  }
  if (input.noFolder) {
    notes.push(t('No folder open: personal, plugin and built-in commands only.'));
  }
  if (input.scanError !== null && !input.scanning) {
    notes.push(t('The last refresh failed: showing the saved list.'));
  }
  if (input.autoRefreshPaused) {
    notes.push(
      t('Automatic refresh is paused because changes kept coming: use Refresh List to update.'),
    );
  }
  return {
    state: Object.keys(view.commands).length === 0 ? 'empty' : 'ready',
    message: notes.length > 0 ? notes.join(' ') : undefined,
  };
}
