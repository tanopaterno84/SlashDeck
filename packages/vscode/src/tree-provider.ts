/** Turns the tree model (tree.ts) into VS Code TreeItems. */
import * as vscode from 'vscode';
import type { Controller } from './controller.js';
import { tooltipMarkdown } from './tooltip.js';
import { buildTree, type GroupNode, type TreeNode } from './tree.js';

const t = vscode.l10n.t;

/**
 * Tooltips show text written by others: no command links, no HTML, no theme icons. The
 * text itself is escaped by tooltipMarkdown.
 */
export function inertMarkdown(value: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(value, false);
  md.isTrusted = false;
  md.supportHtml = false;
  return md;
}

export class CommandTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private groups: GroupNode[] = [];
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly controller: Controller) {}

  /** Rebuilds the model from the controller's view. */
  refresh(): void {
    const view = this.controller.view;
    this.groups = view ? buildTree(view, t) : [];
    this.emitter.fire(undefined);
  }

  get roots(): readonly GroupNode[] {
    return this.groups;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.groups;
    return node.type === 'group' ? node.children : [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.type === 'group') {
      const item = new vscode.TreeItem(
        node.label,
        node.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = node.id;
      item.description = node.description;
      item.contextValue = node.categoryId === null ? 'favourites' : 'group';
      if (node.categoryId === null) item.iconPath = new vscode.ThemeIcon('star-full');
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.description = node.description;
    item.contextValue = node.contextValue;
    item.iconPath = node.entry.isNew
      ? new vscode.ThemeIcon(node.icon, new vscode.ThemeColor('charts.yellow'))
      : new vscode.ThemeIcon(node.icon);
    item.tooltip = inertMarkdown(tooltipMarkdown(node.entry, t));
    item.command = {
      command: 'slashdeck.showActions',
      title: t('Show actions'),
      arguments: [node],
    };
    item.accessibilityInformation = {
      label: node.description ? `${node.label}, ${node.description}` : node.label,
    };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
