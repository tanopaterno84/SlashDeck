import { orderCategories, type ResolvedEntry, type ResolvedView } from '@slashdeck/core';
import type { Translate } from '../src/l10n.js';
import { format } from '../src/l10n.js';

export function entry(name: string, fields: Partial<ResolvedEntry> = {}): ResolvedEntry {
  return {
    name,
    kind: 'builtin',
    sourcePath: null,
    hash: 'sha256:0',
    category: 'other',
    origins: { description: 'cli', category: 'derived' },
    pinned: false,
    isNew: false,
    firstSeenAt: null,
    ...fields,
  };
}

export function view(entries: ResolvedEntry[], fields: Partial<ResolvedView> = {}): ResolvedView {
  return {
    schemaVersion: 1,
    claudeCodeVersion: '9.9.9',
    source: 'cli',
    workspace: 'C:/repo',
    workspaceId: '0123456789abcdef',
    scannedAt: '2026-11-27T00:00:00.000Z',
    warnings: [],
    categoryOrder: orderCategories(entries.map((e) => e.category)),
    commands: Object.fromEntries(entries.map((e) => [e.name, e])),
    ...fields,
  };
}

/** English (no translation): the identity with {n} substitution. */
export const en: Translate = format;

/** A translator that uses the Italian bundle, as VS Code does with an Italian display language. */
export async function italian(): Promise<Translate> {
  const { readFile } = await import('node:fs/promises');
  const bundle = JSON.parse(
    await readFile(new URL('../l10n/bundle.l10n.it.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;
  return (message, ...args) => format(bundle[message] ?? message, ...args);
}
