import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isNewCommand,
  nextCache,
  readCache,
  writeCache,
  type CacheFile,
} from '../src/cache/cache.js';
import type { Catalog, CatalogEntry } from '../src/types.js';
import { makeTempDir } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = '2026-11-01T10:00:00.000Z';
const at = (days: number) => new Date(Date.parse(T0) + days * DAY);
const iso = (days: number) => at(days).toISOString();

function entry(name: string): CatalogEntry {
  return {
    name,
    kind: 'builtin',
    sourcePath: null,
    hash: 'sha256:0',
    category: 'other',
    origins: {},
  };
}

function catalog(names: string[], days: number, source: Catalog['source'] = 'cli'): Catalog {
  return {
    schemaVersion: 1,
    claudeCodeVersion: source === 'cli' ? '2.1.318' : null,
    source,
    workspace: 'C:/repos/project',
    scannedAt: iso(days),
    warnings: [],
    commands: Object.fromEntries(names.map((n) => [n, entry(n)])),
  };
}

describe('nextCache and isNewCommand', () => {
  it('marks nothing as new at the first scan', () => {
    const cache = nextCache(null, catalog(['/a', '/b'], 0));
    expect(cache.firstScanAt).toBe(T0);
    expect(cache.seen['/a']).toEqual({ firstSeenAt: T0, lastSeenAt: T0 });
    expect(isNewCommand(cache, '/a', at(0))).toBe(false);
    expect(isNewCommand(cache, '/b', at(1))).toBe(false);
  });

  it('marks a command that appears later as new for 14 days', () => {
    const first = nextCache(null, catalog(['/a'], 0));
    const second = nextCache(first, catalog(['/a', '/b'], 2));
    expect(second.firstScanAt).toBe(T0);
    expect(second.seen['/a']).toEqual({ firstSeenAt: T0, lastSeenAt: iso(2) });
    expect(second.seen['/b']).toEqual({ firstSeenAt: iso(2), lastSeenAt: iso(2) });
    expect(isNewCommand(second, '/a', at(2))).toBe(false);
    expect(isNewCommand(second, '/b', at(2))).toBe(true);
    expect(isNewCommand(second, '/b', at(15.9))).toBe(true);
    expect(isNewCommand(second, '/b', at(16))).toBe(false);
    expect(isNewCommand(second, '/unknown', at(2))).toBe(false);
  });

  it('keeps a command that disappears, so it does not come back as new', () => {
    let cache = nextCache(null, catalog(['/a', '/b'], 0));
    cache = nextCache(cache, catalog(['/a'], 1));
    expect(cache.seen['/b']).toEqual({ firstSeenAt: T0, lastSeenAt: T0 });
    cache = nextCache(cache, catalog(['/a', '/b'], 3));
    expect(isNewCommand(cache, '/b', at(3))).toBe(false);
  });

  it('drops entries not seen for 30 days', () => {
    let cache = nextCache(null, catalog(['/a', '/b'], 0));
    cache = nextCache(cache, catalog(['/a'], 29));
    expect(cache.seen['/b']).toBeDefined();
    cache = nextCache(cache, catalog(['/a'], 30.01));
    expect(cache.seen['/b']).toBeUndefined();
    expect(cache.seen['/a']).toBeDefined();
  });

  it('does not let fallback scans touch seen or firstScanAt', () => {
    const fallback = nextCache(null, catalog(['/a'], 0, 'files'));
    expect(fallback.firstScanAt).toBeNull();
    expect(fallback.seen).toEqual({});
    expect(fallback.catalog.source).toBe('files');
    // The first scan answered by the CLI is the first scan: nothing is new.
    const cli = nextCache(fallback, catalog(['/a', '/b', '/c'], 1));
    expect(cli.firstScanAt).toBe(iso(1));
    expect(['/a', '/b', '/c'].some((n) => isNewCommand(cli, n, at(1)))).toBe(false);
    // A later fallback scan replaces the catalog but keeps seen.
    const again = nextCache(cli, catalog(['/a'], 2, 'files'));
    expect(again.seen).toEqual(cli.seen);
    expect(again.firstScanAt).toBe(iso(1));
    expect(Object.keys(again.catalog.commands)).toEqual(['/a']);
  });
});

describe('readCache / writeCache', () => {
  it('round-trips a cache atomically, leaving no temporary file', async () => {
    const dir = await makeTempDir('cache');
    const file = path.join(dir, 'workspaces', 'abc', 'catalog.json');
    const cache = nextCache(null, catalog(['/a'], 0));
    await writeCache(file, cache);
    await writeCache(file, cache);
    expect(await readdir(path.dirname(file))).toEqual(['catalog.json']);
    expect(await readCache(file)).toEqual({ status: 'ok', cache });
  });

  it('reports a missing, unreadable or unknown-version cache', async () => {
    const dir = await makeTempDir('cache');
    const file = path.join(dir, 'catalog.json');
    expect(await readCache(file)).toEqual({ status: 'missing' });
    await writeFile(file, '{ not json');
    expect((await readCache(file)).status).toBe('invalid');
    const future: Omit<CacheFile, 'schemaVersion'> & { schemaVersion: number } = {
      ...nextCache(null, catalog(['/a'], 0)),
      schemaVersion: 2,
    };
    await writeFile(file, JSON.stringify(future));
    expect((await readCache(file)).status).toBe('invalid');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, catalog: {} }));
    expect((await readCache(file)).status).toBe('invalid');
    expect(await readFile(file, 'utf8')).toContain('schemaVersion');
  });
});
