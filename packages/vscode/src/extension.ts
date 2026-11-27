/**
 * SlashDeck for VS Code: shows the Claude Code slash commands of the open folder, the
 * project's and the team's first. Everything about commands (discovery, cache, state) is
 * done by @slashdeck/core, bundled in.
 *
 * Activation (onStartupFinished) only reads the cache and subscribes to events; the scan
 * runs in the background, so VS Code startup is not slowed down.
 */
import { resolveDirs, type ResolvedEntry } from '@slashdeck/core';
import * as vscode from 'vscode';
import {
  copyCommand,
  editDescription,
  editWhenToUse,
  entryOf,
  openSource,
  pin,
  resetEdits,
  runCommand,
  showActions,
  unpin,
  type ActionContext,
  type CommandArg,
} from './actions.js';
import { Controller, VIEW_ID } from './controller.js';
import { openSearch } from './search-ui.js';
import { trackClaudeTerminals } from './terminal-wiring.js';
import { countNew, type TreeNode } from './tree.js';
import { CommandTreeProvider } from './tree-provider.js';
import { Watchers } from './watchers.js';
import { watchSpecs } from './workspace.js';

const t = vscode.l10n.t;

/** Returned by activate(); used by the integration test only. */
export interface SlashDeckTestApi {
  idle(): Promise<void>;
  snapshot(): {
    state: string;
    message: string | undefined;
    description: string | undefined;
    badge: number;
    source: string | null;
    groups: { label: string; commands: string[] }[];
  };
  claudeTerminalCount(): number;
  /** Automatic scans started and skipped, file events, and the state of the safety net. */
  refreshState(): {
    automaticScans: number;
    skippedScans: number;
    eventsIgnored: number;
    eventsAccepted: number;
    streak: number;
    paused: boolean;
  };
  /** Replaces the clipboard used by Copy and Run, so that the test leaves the system one alone. */
  setClipboard(clipboard: ActionContext['clipboard']): void;
}

export function activate(context: vscode.ExtensionContext): SlashDeckTestApi {
  const log = vscode.window.createOutputChannel('SlashDeck', { log: true });
  const controller = new Controller(context, log);
  const provider = new CommandTreeProvider(controller);
  const treeView = vscode.window.createTreeView<TreeNode>(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const { tracker, disposables: terminalDisposables } = trackClaudeTerminals(log);
  const ctx: ActionContext = { controller, tracker, log, clipboard: vscode.env.clipboard };
  const watchers = new Watchers(controller.scheduler, log);
  const configDir = resolveDirs().configDir;
  let viewState = 'loading';

  const render = () => {
    provider.refresh();
    const status = controller.status(t);
    viewState = status.state;
    void vscode.commands.executeCommand('setContext', 'slashdeck.viewState', status.state);
    treeView.message = status.message;
    treeView.description = controller.target.label || undefined;
    const fresh = countNew(controller.view);
    treeView.badge =
      fresh > 0
        ? { value: fresh, tooltip: fresh === 1 ? t('1 new command') : t('{0} new commands', fresh) }
        : undefined;
  };
  const rewatch = () =>
    watchers.watch(watchSpecs(controller.target, controller.claudeDir(), configDir));

  /** Registers a command that acts on one slash command (tree node, entry or name). */
  const onCommand = (id: string, fn: (entry: ResolvedEntry) => unknown) =>
    vscode.commands.registerCommand(id, async (arg: CommandArg) => {
      const entry = entryOf(controller, arg);
      if (!entry) {
        log.warn(
          `${id}: command not found in the list: ${String(typeof arg === 'string' ? arg : '')}`,
        );
        return;
      }
      await fn(entry);
    });

  context.subscriptions.push(
    log,
    controller,
    provider,
    treeView,
    watchers,
    ...terminalDisposables,
    controller.onDidChange(render),
    controller.onDidChangeTarget(rewatch),
    vscode.commands.registerCommand('slashdeck.search', () => openSearch(ctx)),
    // Manual: always runs at once, and lifts a pause of the automatic refresh.
    vscode.commands.registerCommand('slashdeck.refresh', () =>
      controller.scheduler.scanNow('manual'),
    ),
    vscode.commands.registerCommand('slashdeck.showLog', () => log.show()),
    vscode.commands.registerCommand('slashdeck.selectFolder', async () => {
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(
        (f) => f.uri.scheme === 'file',
      );
      if (folders.length < 2) return;
      const picked = await vscode.window.showWorkspaceFolderPick({
        placeHolder: t('Folder whose commands SlashDeck shows'),
      });
      if (picked) await controller.updateTarget(picked.uri.fsPath);
    }),
    onCommand('slashdeck.showActions', (e) => showActions(ctx, e)),
    onCommand('slashdeck.copy', (e) => copyCommand(ctx, e)),
    onCommand('slashdeck.run', (e) => runCommand(ctx, e)),
    onCommand('slashdeck.openSource', (e) => openSource(e)),
    onCommand('slashdeck.pin', (e) => pin(ctx, e)),
    onCommand('slashdeck.unpin', (e) => unpin(ctx, e)),
    onCommand('slashdeck.editDescription', (e) => editDescription(ctx, e)),
    onCommand('slashdeck.editWhenToUse', (e) => editWhenToUse(ctx, e)),
    onCommand('slashdeck.resetEdits', (e) => resetEdits(ctx, e)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => controller.updateTarget()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => controller.scheduler.scanNow('event')),
    // Only a setting that changes the result; the extension itself never writes settings.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('slashdeck.claudePath'))
        void controller.scheduler.scanNow('event');
    }),
  );

  render();
  rewatch();
  void controller.start();

  return {
    idle: async () => {
      await controller.scheduler.idle();
      await controller.scheduler.reloadNow();
    },
    snapshot: () => ({
      state: viewState,
      message: treeView.message,
      description: treeView.description,
      badge: treeView.badge?.value ?? 0,
      source: controller.view?.source ?? null,
      groups: provider.roots.map((g) => ({
        label: g.label,
        commands: g.children.map((c) => c.label),
      })),
    }),
    claudeTerminalCount: () => tracker.terminals().length,
    refreshState: () => ({
      automaticScans: controller.scheduler.automaticScans,
      skippedScans: controller.scheduler.skippedScans,
      eventsIgnored: watchers.ignored,
      eventsAccepted: watchers.accepted,
      streak: controller.scheduler.streak,
      paused: controller.scheduler.paused,
    }),
    setClipboard: (clipboard) => {
      ctx.clipboard = clipboard;
    },
  };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
