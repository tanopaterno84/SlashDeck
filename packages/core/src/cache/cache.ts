/**
 * Workspace cache (CLAUDE.md, "Cache (M3)"): the last catalog of a workspace plus the
 * `seen` table behind the "new" badge. Deletable at any time; only the core writes it.
 */
import { rm, stat } from 'node:fs/promises';
import { z } from 'zod';
import { readTextIfExists, writeFileAtomic } from '../fs-util.js';
import type { Catalog } from '../types.js';
import { errorMessage, issuesMessage, stripBom } from '../util.js';

export const CACHE_SCHEMA_VERSION = 1;
/** A command is "new" for this long after it first appeared. */
export const NEW_FOR_DAYS = 14;
/** `seen` entries not seen for this long are dropped. */
export const PRUNE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const catalogOriginSchema = z.enum(['cli', 'local-metadata', 'curated', 'derived']);

const catalogEntrySchema = z.object({
  name: z.string().min(1),
  kind: z.enum([
    'builtin',
    'custom-user',
    'custom-project',
    'skill-user',
    'skill-synced',
    'skill-project',
    'plugin',
    'unknown',
  ]),
  plugin: z.string().optional(),
  sourcePath: z.string().nullable(),
  hash: z.string(),
  category: z.string().min(1),
  description: z.string().optional(),
  argumentHint: z.string().optional(),
  origins: z.object({
    description: catalogOriginSchema.optional(),
    argumentHint: catalogOriginSchema.optional(),
    category: catalogOriginSchema.optional(),
  }),
});

export const catalogSchema = z.object({
  schemaVersion: z.literal(1),
  claudeCodeVersion: z.string().nullable(),
  source: z.enum(['cli', 'files']),
  workspace: z.string(),
  scannedAt: z.string(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  commands: z.record(z.string(), catalogEntrySchema),
});

const seenEntrySchema = z.object({ firstSeenAt: z.string(), lastSeenAt: z.string() });

export const cacheFileSchema = z.object({
  schemaVersion: z.literal(CACHE_SCHEMA_VERSION),
  firstScanAt: z.string().nullable(),
  catalog: catalogSchema,
  seen: z.record(z.string(), seenEntrySchema),
});

export interface SeenEntry {
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface CacheFile {
  schemaVersion: 1;
  /**
   * First scan of this workspace answered by the Claude Code CLI; null while there has been
   * none (fallback scans do not count, see `nextCache`).
   */
  firstScanAt: string | null;
  catalog: Catalog;
  seen: Record<string, SeenEntry>;
}

export type CacheRead =
  | { status: 'ok'; cache: CacheFile }
  | { status: 'missing' }
  | { status: 'invalid'; message: string };

/** Reads a cache file. An unreadable file or an unknown `schemaVersion` is `invalid`. */
export async function readCache(file: string): Promise<CacheRead> {
  let text: string | null;
  try {
    text = await readTextIfExists(file);
  } catch (err) {
    return { status: 'invalid', message: errorMessage(err) };
  }
  if (text === null) return { status: 'missing' };
  let json: unknown;
  try {
    json = JSON.parse(stripBom(text));
  } catch (err) {
    return { status: 'invalid', message: `not valid JSON (${errorMessage(err)})` };
  }
  const parsed = cacheFileSchema.safeParse(json);
  if (!parsed.success) {
    return { status: 'invalid', message: issuesMessage(parsed.error.issues) };
  }
  return { status: 'ok', cache: parsed.data as CacheFile };
}

/**
 * The cache after a scan. The catalog is always replaced by the new one. `seen` and
 * `firstScanAt` are updated only by scans answered by the CLI: a fallback scan has no
 * builtins and may use different names, so it would make commands look new later.
 * `seen` never loses a command that disappears, except after PRUNE_AFTER_DAYS.
 */
export function nextCache(previous: CacheFile | null, catalog: Catalog): CacheFile {
  if (catalog.source !== 'cli') {
    return {
      schemaVersion: CACHE_SCHEMA_VERSION,
      firstScanAt: previous?.firstScanAt ?? null,
      catalog,
      seen: previous?.seen ?? {},
    };
  }
  const at = catalog.scannedAt;
  const seen: Record<string, SeenEntry> = { ...previous?.seen };
  for (const name of Object.keys(catalog.commands)) {
    seen[name] = { firstSeenAt: seen[name]?.firstSeenAt ?? at, lastSeenAt: at };
  }
  const limit = Date.parse(at) - PRUNE_AFTER_DAYS * DAY_MS;
  for (const [name, entry] of Object.entries(seen)) {
    if (Date.parse(entry.lastSeenAt) < limit) delete seen[name];
  }
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    firstScanAt: previous?.firstScanAt ?? at,
    catalog,
    seen: Object.fromEntries(Object.entries(seen).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/**
 * A command is new if it first appeared after the first scan of the workspace and less
 * than NEW_FOR_DAYS ago. At the first scan nothing is new.
 */
export function isNewCommand(cache: CacheFile, name: string, now: Date): boolean {
  const seen = cache.seen[name];
  if (cache.firstScanAt === null || seen === undefined) return false;
  const first = Date.parse(seen.firstSeenAt);
  return first > Date.parse(cache.firstScanAt) && now.getTime() - first < NEW_FOR_DAYS * DAY_MS;
}

export async function writeCache(file: string, cache: CacheFile): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(cache, null, 2) + '\n');
}

/** Removes a folder of the cache; returns whether it existed. */
export async function removeCacheDir(dir: string): Promise<boolean> {
  let existed = true;
  try {
    await stat(dir);
  } catch {
    existed = false;
  }
  await rm(dir, { recursive: true, force: true });
  return existed;
}
