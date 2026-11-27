/**
 * The actions on a command, shared by the tree (inline buttons, context menu, click) and by
 * the search: copy, run, open the source file, pin and unpin, edit and reset.
 * Writes go through the core (pinCommand, editCommand...), then the view is reloaded.
 */
import {
  editCommand,
  pinCommand,
  resetCommand,
  SlashDeckError,
  unpinCommand,
  type CommandEditInput,
  type ResolvedEntry,
  type StoreOptions,
  type WriteResult,
} from '@slashdeck/core';
import * as vscode from 'vscode';
import type { Controller } from './controller.js';
import { escapeIcons } from './search.js';
import { pickTerminal, runPlan, type ClaudeTerminalTracker } from './terminals.js';
import { hasUserEdits } from './tree.js';

const t = vscode.l10n.t;

/** Undocumented command of the official Claude Code extension (checked on 2.1.332). */
export const CLAUDE_CODE_FOCUS_COMMAND = 'claude-vscode.focus';
/** Pause between the typed command and Enter, so that Claude Code reads Enter as a key. */
const SUBMIT_DELAY_MS = 150;
const STATUS_MS = 4000;

export interface ActionContext {
  controller: Controller;
  tracker: ClaudeTerminalTracker<vscode.Terminal>;
  log: vscode.LogOutputChannel;
  /** `vscode.env.clipboard`; the integration test swaps it, so as not to touch the real one. */
  clipboard: { writeText(value: string): Thenable<void> };
}

/** A command argument: a tree node, an entry, or a command name (for tests and keybindings). */
export type CommandArg = { entry: ResolvedEntry } | ResolvedEntry | string | undefined;

/** The current entry of the command, from the view shown now. */
export function entryOf(controller: Controller, arg: CommandArg): ResolvedEntry | undefined {
  if (arg === undefined) return undefined;
  const name =
    typeof arg === 'string'
      ? arg.startsWith('/')
        ? arg
        : `/${arg}`
      : 'entry' in arg
        ? arg.entry.name
        : arg.name;
  return controller.view?.commands[name];
}

/** Claude terminals whose process is still alive. */
function liveClaudeTerminals(ctx: ActionContext): vscode.Terminal[] {
  return ctx.tracker.terminals().filter((term) => term.exitStatus === undefined);
}

async function claudeCodeFocusAvailable(): Promise<boolean> {
  try {
    return (await vscode.commands.getCommands(true)).includes(CLAUDE_CODE_FOCUS_COMMAND);
  } catch {
    return false;
  }
}

export async function copyCommand(ctx: ActionContext, entry: ResolvedEntry): Promise<void> {
  await ctx.clipboard.writeText(entry.name);
  vscode.window.setStatusBarMessage(
    t('Copied {0}: paste it into Claude Code.', entry.name),
    STATUS_MS,
  );
  // For users of the Claude Code panel: put the cursor in its input, so that they only have
  // to paste. Only when the official extension has registered its (undocumented) command,
  // and not for terminal users, who have "Run".
  const enabled = vscode.workspace
    .getConfiguration('slashdeck')
    .get<boolean>('focusClaudeCodeAfterCopy', true);
  if (!enabled || liveClaudeTerminals(ctx).length > 0) return;
  if (!(await claudeCodeFocusAvailable())) return;
  try {
    await vscode.commands.executeCommand(CLAUDE_CODE_FOCUS_COMMAND);
  } catch (err) {
    ctx.log.warn(`${CLAUDE_CODE_FOCUS_COMMAND} failed: ${String(err)}`);
  }
}

async function chooseTerminal(candidates: vscode.Terminal[]): Promise<vscode.Terminal | null> {
  const chosen = pickTerminal(candidates, vscode.window.activeTerminal);
  if (chosen) return chosen;
  const picked = await vscode.window.showQuickPick(
    candidates.map((terminal) => ({ label: escapeIcons(terminal.name), terminal })),
    {
      title: t('Which Claude Code terminal?'),
      placeHolder: t('Several terminals run Claude Code'),
    },
  );
  return picked?.terminal ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends the command to an integrated terminal in which `claude` runs. Never creates a
 * terminal: a new one would be a new Claude Code session. With no such terminal the command
 * is copied instead.
 */
export async function runCommand(ctx: ActionContext, entry: ResolvedEntry): Promise<void> {
  const candidates = liveClaudeTerminals(ctx);
  if (candidates.length === 0) {
    await ctx.clipboard.writeText(entry.name);
    vscode.window.setStatusBarMessage(
      t('No terminal running Claude Code was found: {0} was copied instead.', entry.name),
      STATUS_MS,
    );
    return;
  }
  const terminal = await chooseTerminal(candidates);
  if (!terminal) return;
  const plan = runPlan(entry);
  // Claude Code may have exited while the user was choosing.
  if (!ctx.tracker.has(terminal) || terminal.exitStatus !== undefined) return;
  terminal.show(false);
  terminal.sendText(plan.text, false);
  if (plan.submit) {
    await delay(SUBMIT_DELAY_MS);
    if (ctx.tracker.has(terminal) && terminal.exitStatus === undefined) {
      terminal.sendText('\r', false);
    }
  } else {
    vscode.window.setStatusBarMessage(
      t('{0} takes arguments: complete it in Claude Code and press Enter.', entry.name),
      STATUS_MS,
    );
  }
}

export async function openSource(entry: ResolvedEntry): Promise<void> {
  if (entry.sourcePath === null) return;
  await vscode.window.showTextDocument(vscode.Uri.file(entry.sourcePath), { preview: true });
}

function writeErrorMessage(err: unknown): string {
  if (err instanceof SlashDeckError) {
    switch (err.code) {
      case 'no-cache':
      case 'not-in-catalog':
        return t('The command is not in the saved list: refresh the list and try again.');
      case 'state-unreadable':
        return t(
          'Your SlashDeck settings file cannot be read, so it was not changed: {0}',
          err.message,
        );
      case 'state-busy':
        return t('Your SlashDeck settings file is being changed by another window: try again.');
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** Runs a write of the core, then reloads the view. Errors: one non-modal message. */
async function write(
  ctx: ActionContext,
  fn: (options: StoreOptions) => Promise<WriteResult>,
): Promise<void> {
  try {
    await fn(ctx.controller.storeOptions());
  } catch (err) {
    ctx.log.error(`write failed: ${err instanceof Error ? err.message : String(err)}`);
    void vscode.window.showWarningMessage(writeErrorMessage(err));
  }
  await ctx.controller.scheduler.reloadNow();
}

export function pin(ctx: ActionContext, entry: ResolvedEntry): Promise<void> {
  return write(ctx, (o) => pinCommand(o, entry.name));
}

export function unpin(ctx: ActionContext, entry: ResolvedEntry): Promise<void> {
  return write(ctx, (o) => unpinCommand(o, entry.name));
}

export function resetEdits(ctx: ActionContext, entry: ResolvedEntry): Promise<void> {
  return write(ctx, (o) => resetCommand(o, entry.name));
}

/** Asks for a text; empty removes the user's own value. Undefined when cancelled. */
async function askText(
  title: string,
  value: string | undefined,
): Promise<string | null | undefined> {
  const input = await vscode.window.showInputBox({
    title,
    value: value ?? '',
    prompt: t('Leave empty to remove your edit and show the original text again.'),
    ignoreFocusOut: true,
  });
  if (input === undefined) return undefined;
  const trimmed = input.trim();
  return trimmed === '' ? null : trimmed;
}

async function edit(
  ctx: ActionContext,
  entry: ResolvedEntry,
  input: CommandEditInput,
): Promise<void> {
  await write(ctx, (o) => editCommand(o, entry.name, input));
}

export async function editDescription(ctx: ActionContext, entry: ResolvedEntry): Promise<void> {
  const value = await askText(t('Description of {0}', entry.name), entry.description);
  if (value === undefined || value === (entry.description ?? null)) return;
  await edit(ctx, entry, { description: value });
}

export async function editWhenToUse(ctx: ActionContext, entry: ResolvedEntry): Promise<void> {
  const current = entry.guide?.whenToUse;
  const value = await askText(t('When to use {0}', entry.name), current);
  if (value === undefined || value === (current ?? null)) return;
  await edit(ctx, entry, { guide: { whenToUse: value } });
}

interface ActionItem extends vscode.QuickPickItem {
  run: () => Promise<void>;
}

/** The actions of one command, as a quick pick: what a click on the tree and the search open. */
export async function showActions(ctx: ActionContext, entry: ResolvedEntry): Promise<void> {
  const terminals = liveClaudeTerminals(ctx);
  const items: ActionItem[] = [
    {
      label: `$(copy) ${t('Copy {0}', escapeIcons(entry.name))}`,
      detail: t('Then paste it into Claude Code.'),
      run: () => copyCommand(ctx, entry),
    },
  ];
  if (terminals.length > 0) {
    items.push({
      label: `$(play) ${t('Run in the Claude Code terminal')}`,
      detail: escapeIcons(terminals.map((term) => term.name).join(', ')),
      run: () => runCommand(ctx, entry),
    });
  }
  if (entry.sourcePath !== null) {
    items.push({
      label: `$(go-to-file) ${t('Open the source file')}`,
      detail: escapeIcons(entry.sourcePath),
      run: () => openSource(entry),
    });
  }
  items.push(
    entry.pinned
      ? { label: `$(pinned) ${t('Remove from Favourites')}`, run: () => unpin(ctx, entry) }
      : { label: `$(pin) ${t('Add to Favourites')}`, run: () => pin(ctx, entry) },
    { label: `$(edit) ${t('Edit the description...')}`, run: () => editDescription(ctx, entry) },
    { label: `$(edit) ${t('Edit "when to use"...')}`, run: () => editWhenToUse(ctx, entry) },
  );
  if (hasUserEdits(entry)) {
    items.push({ label: `$(discard) ${t('Reset my edits')}`, run: () => resetEdits(ctx, entry) });
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: escapeIcons(entry.name),
    placeHolder: escapeIcons(
      entry.description?.replace(/\s+/g, ' ').trim() || t('Choose an action'),
    ),
  });
  if (picked) await picked.run();
}
