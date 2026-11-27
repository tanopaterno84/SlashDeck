/**
 * Resolved view (CLAUDE.md, "Vista risolta"): the cached catalog, then the team override
 * field by field, then the user's edits field by field, plus `pinned`, `isNew` and
 * `firstSeenAt`. Precedence per field: user-edit > team > curated > cli > local-metadata >
 * derived; the catalog already holds the best of the last four.
 */
import { isNewCommand, type CacheFile } from '../cache/cache.js';
import { orderCategories } from '../markdown.js';
import type {
  CatalogEntry,
  CommandEdit,
  Guide,
  Origin,
  ResolvedEntry,
  ResolvedField,
  ResolvedView,
  ScanWarning,
} from '../types.js';
import { editIn, isPinnedIn, scopeForKind, type UserState } from './user-state.js';

export interface ResolveInput {
  cache: CacheFile;
  workspaceId: string;
  state: UserState;
  team: Record<string, CommandEdit>;
  /** Warnings found while loading (state, team, cache), added after the scan warnings. */
  warnings?: ScanWarning[];
  now: Date;
}

const GUIDE_FIELDS = ['whenToUse', 'example', 'related'] as const;

function applyLayer(
  target: { description?: string; category: string; guide?: Guide },
  origins: Partial<Record<ResolvedField, Origin>>,
  layer: CommandEdit | undefined,
  origin: Origin,
): void {
  if (!layer) return;
  if (layer.description !== undefined) {
    target.description = layer.description;
    origins.description = origin;
  }
  if (layer.category !== undefined) {
    target.category = layer.category;
    origins.category = origin;
  }
  for (const key of GUIDE_FIELDS) {
    const value = layer.guide?.[key];
    if (value === undefined) continue;
    target.guide = { ...target.guide, [key]: Array.isArray(value) ? [...value] : value };
    origins[`guide.${key}`] = origin;
  }
}

export function resolveEntry(
  entry: CatalogEntry,
  input: Omit<ResolveInput, 'warnings'>,
): ResolvedEntry {
  const scope =
    scopeForKind(entry.kind) === 'workspace'
      ? input.state.workspaces[input.workspaceId]
      : input.state;
  const fields: { description?: string; category: string; guide?: Guide } = {
    category: entry.category,
    ...(entry.description !== undefined && { description: entry.description }),
  };
  const origins: Partial<Record<ResolvedField, Origin>> = { ...entry.origins };
  applyLayer(fields, origins, input.team[entry.name], 'team');
  applyLayer(fields, origins, editIn(scope, entry.name), 'user-edit');

  // Fixed key order, for a stable JSON output.
  const orderedOrigins: Partial<Record<ResolvedField, Origin>> = {};
  for (const key of [
    'description',
    'argumentHint',
    'category',
    'guide.whenToUse',
    'guide.example',
    'guide.related',
  ] as const) {
    if (origins[key] !== undefined) orderedOrigins[key] = origins[key];
  }
  const guide: Guide | undefined = fields.guide && {
    ...(fields.guide.whenToUse !== undefined && { whenToUse: fields.guide.whenToUse }),
    ...(fields.guide.example !== undefined && { example: fields.guide.example }),
    ...(fields.guide.related !== undefined && { related: fields.guide.related }),
  };

  return {
    name: entry.name,
    kind: entry.kind,
    ...(entry.plugin !== undefined && { plugin: entry.plugin }),
    sourcePath: entry.sourcePath,
    hash: entry.hash,
    category: fields.category,
    ...(fields.description !== undefined && { description: fields.description }),
    ...(entry.argumentHint !== undefined && { argumentHint: entry.argumentHint }),
    ...(guide !== undefined && { guide }),
    origins: orderedOrigins,
    pinned: isPinnedIn(scope, entry.name),
    isNew: isNewCommand(input.cache, entry.name, input.now),
    firstSeenAt: input.cache.seen[entry.name]?.firstSeenAt ?? null,
  };
}

export function resolveView(input: ResolveInput): ResolvedView {
  const { catalog } = input.cache;
  const commands: Record<string, ResolvedEntry> = {};
  for (const [name, entry] of Object.entries(catalog.commands)) {
    commands[name] = resolveEntry(entry, input);
  }
  return {
    schemaVersion: 1,
    claudeCodeVersion: catalog.claudeCodeVersion,
    source: catalog.source,
    workspace: catalog.workspace,
    workspaceId: input.workspaceId,
    scannedAt: catalog.scannedAt,
    warnings: [...catalog.warnings, ...(input.warnings ?? [])],
    categoryOrder: orderCategories(Object.values(commands).map((e) => e.category)),
    commands,
  };
}
