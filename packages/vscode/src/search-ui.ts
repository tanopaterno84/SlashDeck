/**
 * "SlashDeck: Search Command": a quick pick over all the commands that matches the name and
 * what the command is for (search.ts ranks the items; VS Code's own filter is bypassed with
 * `alwaysShow`). Choosing a command opens the same actions as a click in the tree; the
 * buttons copy or run it directly.
 */
import * as vscode from 'vscode';
import { copyCommand, runCommand, showActions, type ActionContext } from './actions.js';
import { searchItems, type SearchItem } from './search.js';

const t = vscode.l10n.t;

interface PickItem extends vscode.QuickPickItem {
  item?: SearchItem;
}

export async function openSearch(ctx: ActionContext): Promise<void> {
  const qp = vscode.window.createQuickPick<PickItem>();
  qp.title = t('Search Claude Code commands');
  qp.placeholder = t('A name, or what you want to do (e.g. "review my changes")');
  // Matching is done by searchItems, on more fields than VS Code's filter would use.
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  const copyButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('copy'),
    tooltip: t('Copy'),
  };
  const runButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('play'),
    tooltip: t('Run in the Claude Code terminal'),
  };

  const update = (keepActive: boolean) => {
    const view = ctx.controller.view;
    qp.busy = ctx.controller.scheduler.scanning;
    if (!view) {
      qp.items = [];
      return;
    }
    const canRun = ctx.tracker.terminals().some((term) => term.exitStatus === undefined);
    const active = qp.activeItems[0]?.item;
    const activeName = active?.kind === 'command' ? active.entry.name : undefined;
    const items = searchItems(view, qp.value, t).map((item): PickItem => {
      if (item.kind === 'separator') {
        return { label: item.label, kind: vscode.QuickPickItemKind.Separator };
      }
      return {
        label: item.label,
        description: item.description,
        detail: item.detail,
        alwaysShow: true,
        buttons: canRun ? [copyButton, runButton] : [copyButton],
        item,
      };
    });
    qp.items = items;
    if (!keepActive || activeName === undefined) return;
    // A background refresh rebuilt the list: keep the highlighted command.
    const keep = items.find((i) => i.item?.kind === 'command' && i.item.entry.name === activeName);
    if (keep) qp.activeItems = [keep];
  };

  const disposables: vscode.Disposable[] = [
    qp.onDidChangeValue(() => update(false)),
    ctx.controller.onDidChange(() => update(true)),
    qp.onDidAccept(() => {
      const picked = qp.selectedItems[0]?.item;
      qp.hide();
      if (picked?.kind === 'command') void showActions(ctx, picked.entry);
    }),
    qp.onDidTriggerItemButton((e) => {
      const picked = e.item.item;
      if (picked?.kind !== 'command') return;
      qp.hide();
      void (e.button === runButton
        ? runCommand(ctx, picked.entry)
        : copyCommand(ctx, picked.entry));
    }),
    qp.onDidHide(() => {
      for (const d of disposables) d.dispose();
      qp.dispose();
    }),
  ];
  update(false);
  qp.show();
}
