/**
 * Tree model of the view, built from a resolved view of the core: "Favourites" first (pinned
 * commands, absent when there are none), then one group per category in the display order of
 * CLAUDE.md ("Categorie"). No `vscode` import: the provider turns these nodes into TreeItems.
 */
import {
  orderCategories,
  truncateText,
  type ResolvedEntry,
  type ResolvedView,
} from '@slashdeck/core';
import { BUILTIN_CATEGORY_IDS, categoryLabel } from './labels.js';
import type { Translate } from './l10n.js';

/** Characters of the description shown next to the name (VS Code cuts it to the width). */
export const ITEM_DESCRIPTION_CHARS = 120;

export const FAVOURITES_ID = 'group:favourites';

export interface CommandNode {
  type: 'command';
  /** Unique in the tree: a pinned command appears twice (Favourites and its category). */
  id: string;
  label: string;
  description: string;
  /** Codicon name. */
  icon: string;
  /** Space-separated flags matched by the `when` clauses of package.json. */
  contextValue: string;
  entry: ResolvedEntry;
}

export interface GroupNode {
  type: 'group';
  id: string;
  /** Category ID; null for Favourites. */
  categoryId: string | null;
  label: string;
  description: string;
  expanded: boolean;
  children: CommandNode[];
}

export type TreeNode = GroupNode | CommandNode;

function compareNames(a: ResolvedEntry, b: ResolvedEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Codicon for a command: new ones stand out, the others show where they come from. */
export function commandIcon(entry: ResolvedEntry): string {
  if (entry.isNew) return 'sparkle';
  switch (entry.kind) {
    case 'custom-project':
    case 'skill-project':
      return 'repo';
    case 'plugin':
      return 'extensions';
    case 'custom-user':
    case 'skill-user':
      return 'account';
    case 'skill-synced':
      return 'cloud';
    case 'builtin':
      return 'terminal';
    case 'unknown':
      return 'question';
  }
}

/** Whether the user has edited any text of the command. */
export function hasUserEdits(entry: ResolvedEntry): boolean {
  return Object.values(entry.origins).includes('user-edit');
}

export function commandContextValue(entry: ResolvedEntry): string {
  return [
    'command',
    entry.pinned ? 'pinned' : 'unpinned',
    ...(entry.sourcePath !== null ? ['hasSource'] : []),
    ...(hasUserEdits(entry) ? ['edited'] : []),
    ...(entry.isNew ? ['new'] : []),
  ].join(' ');
}

/** "New · <argument hint> · <description>": enough to recognise the command at a glance. */
export function commandDescription(entry: ResolvedEntry, t: Translate): string {
  const parts: string[] = [];
  if (entry.isNew) parts.push(t('New'));
  const hint = entry.argumentHint?.trim();
  if (hint) parts.push(truncateText(hint, 40));
  const description = entry.description?.trim();
  if (description) parts.push(truncateText(description, ITEM_DESCRIPTION_CHARS));
  return parts.join(' · ');
}

function commandNode(entry: ResolvedEntry, idPrefix: string, t: Translate): CommandNode {
  return {
    type: 'command',
    id: `${idPrefix}${entry.name}`,
    label: entry.name,
    description: commandDescription(entry, t),
    icon: commandIcon(entry),
    contextValue: commandContextValue(entry),
    entry,
  };
}

export function buildTree(view: ResolvedView, t: Translate): GroupNode[] {
  const entries = Object.values(view.commands).sort(compareNames);
  const groups: GroupNode[] = [];

  const pinned = entries.filter((e) => e.pinned);
  if (pinned.length > 0) {
    groups.push({
      type: 'group',
      id: FAVOURITES_ID,
      categoryId: null,
      label: t('Favourites'),
      description: String(pinned.length),
      expanded: true,
      children: pinned.map((e) => commandNode(e, 'favourite:', t)),
    });
  }

  const byCategory = new Map<string, ResolvedEntry[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.category);
    if (list) list.push(entry);
    else byCategory.set(entry.category, [entry]);
  }
  for (const id of orderCategories(byCategory.keys())) {
    const members = byCategory.get(id)!;
    const builtin = BUILTIN_CATEGORY_IDS.has(id);
    groups.push({
      type: 'group',
      id: `group:${id}`,
      categoryId: id,
      label: categoryLabel(id, t),
      description: builtin ? t('built-in · {0}', members.length) : String(members.length),
      // The project's and the team's commands are what the view is for: open by default.
      expanded: !builtin,
      children: members.map((e) => commandNode(e, 'command:', t)),
    });
  }
  return groups;
}

/** Number of commands marked as new, for the view badge. */
export function countNew(view: ResolvedView | null): number {
  if (!view) return 0;
  return Object.values(view.commands).filter((e) => e.isNew).length;
}
