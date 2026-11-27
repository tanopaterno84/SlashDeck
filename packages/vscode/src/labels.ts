/**
 * Translated labels of category IDs, origins and command kinds (CLAUDE.md, "Categorie" and
 * "Trasparenza"). Category IDs are stable: unknown ones (e.g. added by a team) are shown as
 * they are.
 */
import type { CommandKind, Origin } from '@slashdeck/core';
import type { Translate } from './l10n.js';

const PLUGIN_PREFIX = 'plugin:';

/** Category IDs of the built-in commands. */
export const BUILTIN_CATEGORY_IDS: ReadonlySet<string> = new Set([
  'session',
  'context',
  'model-permissions',
  'review-git',
  'mcp-plugins',
  'config',
  'other',
]);

export function categoryLabel(id: string, t: Translate): string {
  if (id.startsWith(PLUGIN_PREFIX)) return t('Plugin: {0}', id.slice(PLUGIN_PREFIX.length));
  switch (id) {
    case 'project':
      return t('Project');
    case 'personal':
      return t('Personal');
    case 'synced':
      return t('Synced');
    case 'session':
      return t('Session');
    case 'context':
      return t('Context');
    case 'model-permissions':
      return t('Model and permissions');
    case 'review-git':
      return t('Review and Git');
    case 'mcp-plugins':
      return t('MCP and plugins');
    case 'config':
      return t('Configuration');
    case 'other':
      return t('Other');
    default:
      return id;
  }
}

/** Who wrote a text: shown next to every text, as the transparency rule requires. */
export function originLabel(origin: Origin | undefined, t: Translate): string {
  switch (origin) {
    case 'cli':
      return t('From Claude Code');
    case 'local-metadata':
      return t('From the command file');
    case 'curated':
      return t('From the SlashDeck list');
    case 'derived':
      return t('Assigned by SlashDeck');
    case 'team':
      return t('From the team');
    case 'user-edit':
      return t('Edited by you');
    default:
      return t('Origin unknown');
  }
}

export function kindLabel(kind: CommandKind, t: Translate): string {
  switch (kind) {
    case 'builtin':
      return t('Built-in command');
    case 'custom-user':
      return t('Personal command');
    case 'custom-project':
      return t('Project command');
    case 'skill-user':
      return t('Personal skill');
    case 'skill-synced':
      return t('Skill synced from your account');
    case 'skill-project':
      return t('Project skill');
    case 'plugin':
      return t('Plugin command or skill');
    case 'unknown':
      return t('Not built-in, source file not found');
  }
}
