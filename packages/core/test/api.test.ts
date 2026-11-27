import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearCache,
  editCommand,
  loadCachedView,
  normalizeCommandName,
  pinCommand,
  resetCommand,
  scanAndCache,
  unpinCommand,
  type ScanAndCacheOptions,
} from '../src/api.js';
import { SlashDeckError } from '../src/errors.js';
import { cacheFilePath, workspaceId } from '../src/paths.js';
import {
  FIXTURE_WORKSPACE,
  SAMPLE_COMMANDS,
  fakeLauncher,
  initializeLine,
  makeHome,
  makeTempDir,
  type SyntheticCommand,
} from './helpers.js';

const T0 = '2026-11-27T10:00:00.000Z';

interface Setup {
  options: ScanAndCacheOptions;
  cacheDir: string;
  configDir: string;
  stateFile: string;
  cacheFile: string;
}

async function setup(workspace = FIXTURE_WORKSPACE, commands = SAMPLE_COMMANDS): Promise<Setup> {
  const homeDir = await makeHome();
  const root = await makeTempDir('dirs');
  const cacheDir = path.join(root, 'cache');
  const configDir = path.join(root, 'config');
  return {
    options: {
      workspace,
      homeDir,
      cacheDir,
      configDir,
      env: {},
      claudePath: '/fake/claude',
      launcher: fakeLauncher({ stdout: initializeLine(commands, '2.1.318') + '\n' }),
      now: () => new Date(T0),
    },
    cacheDir,
    configDir,
    stateFile: path.join(configDir, 'state.json'),
    cacheFile: cacheFilePath(cacheDir, workspaceId(workspace)),
  };
}

async function errorOf(promise: Promise<unknown>): Promise<SlashDeckError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SlashDeckError);
  return err as SlashDeckError;
}

/** A copy of the fixture workspace, with an optional team override. */
async function workspaceCopy(team?: unknown): Promise<string> {
  const ws = await makeTempDir('workspace');
  await cp(FIXTURE_WORKSPACE, ws, { recursive: true });
  if (team !== undefined) {
    await writeFile(
      path.join(ws, '.claude', 'slashdeck.json'),
      typeof team === 'string' ? team : JSON.stringify(team, null, 2),
    );
  }
  return ws;
}

describe('scanAndCache / loadCachedView', () => {
  it('writes the cache of the workspace and returns the resolved view', async () => {
    const s = await setup();
    expect(await loadCachedView(s.options)).toBeNull();

    const view = await scanAndCache(s.options);
    expect(view.workspaceId).toBe(workspaceId(FIXTURE_WORKSPACE));
    expect(view.commands['/compact']).toMatchObject({
      pinned: false,
      isNew: false,
      firstSeenAt: T0,
    });

    const text = await readFile(s.cacheFile, 'utf8');
    const cache = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(cache).sort()).toEqual(['catalog', 'firstScanAt', 'schemaVersion', 'seen']);
    expect(cache).toMatchObject({ schemaVersion: 1, firstScanAt: T0 });
    // Only catalog fields: nothing else from the initialize answer, no resolved fields.
    expect(text).not.toContain('output_style');
    expect(text).not.toContain('"pinned"');
    expect(text).not.toContain('"isNew"');
    expect(await readdir(path.dirname(s.cacheFile))).toEqual(['catalog.json']);
    // The user state is not written by a scan.
    await expect(stat(s.stateFile)).rejects.toThrow();

    expect(await loadCachedView(s.options)).toEqual(view);
  });

  it('marks commands that appear in a later scan as new', async () => {
    const s = await setup();
    await scanAndCache(s.options);
    const added: SyntheticCommand = {
      name: 'fresh',
      description: 'A new command',
      argumentHint: '',
      builtin: true,
    };
    const later = await scanAndCache({
      ...s.options,
      launcher: fakeLauncher({ stdout: initializeLine([...SAMPLE_COMMANDS, added]) + '\n' }),
      now: () => new Date('2026-11-29T10:00:00.000Z'),
    });
    expect(later.commands['/fresh']).toMatchObject({
      isNew: true,
      firstSeenAt: '2026-11-29T10:00:00.000Z',
    });
    expect(later.commands['/compact']!.isNew).toBe(false);
    const cached = await loadCachedView({
      ...s.options,
      now: () => new Date('2026-12-20T10:00:00Z'),
    });
    expect(cached!.commands['/fresh']!.isNew).toBe(false);
  });

  it('ignores and rewrites an unreadable cache', async () => {
    const s = await setup();
    await mkdir(path.dirname(s.cacheFile), { recursive: true });
    await writeFile(s.cacheFile, '{"schemaVersion": 99}');
    expect(await loadCachedView(s.options)).toBeNull();
    const view = await scanAndCache(s.options);
    expect(view.warnings.map((w) => w.code)).toContain('cache-invalid');
    expect(await loadCachedView(s.options)).not.toBeNull();
  });

  it('still returns the view when the cache cannot be written', async () => {
    const s = await setup();
    await mkdir(path.dirname(s.cacheDir), { recursive: true });
    await writeFile(s.cacheDir, 'a file where the cache folder should be');
    const view = await scanAndCache(s.options);
    expect(view.warnings.map((w) => w.code)).toContain('cache-write-failed');
    expect(Object.keys(view.commands).length).toBeGreaterThan(0);
  });

  it('applies the team override of the workspace', async () => {
    const ws = await workspaceCopy({
      schemaVersion: 1,
      commands: {
        'deploy-check': { guide: { whenToUse: 'Before every release on dev01.' } },
        '/compact': { description: 'Team description', category: 'team-context' },
      },
    });
    const s = await setup(ws);
    const view = await scanAndCache(s.options);
    expect(view.commands['/deploy-check']).toMatchObject({
      guide: { whenToUse: 'Before every release on dev01.' },
      origins: { 'guide.whenToUse': 'team' },
    });
    expect(view.commands['/compact']).toMatchObject({
      description: 'Team description',
      category: 'team-context',
      origins: { description: 'team', category: 'team' },
    });
    // The core never writes the team file, and the cache holds no team text.
    expect(await readFile(s.cacheFile, 'utf8')).not.toContain('Team description');
  });

  it('warns about a malformed team override and ignores it', async () => {
    const s = await setup(await workspaceCopy('{ broken'));
    const view = await scanAndCache(s.options);
    expect(view.warnings.map((w) => w.code)).toContain('team-override-invalid');
    expect(view.commands['/compact']!.origins.description).toBe('cli');
  });
});

describe('pin / unpin / edit / reset', () => {
  it('needs a cache and a command of the catalog to pin or edit', async () => {
    const s = await setup();
    expect((await errorOf(pinCommand(s.options, 'compact'))).code).toBe('no-cache');
    expect((await errorOf(editCommand(s.options, 'compact', { description: 'x' }))).code).toBe(
      'no-cache',
    );
    await scanAndCache(s.options);
    expect((await errorOf(pinCommand(s.options, '/nope'))).code).toBe('not-in-catalog');
    expect((await errorOf(pinCommand(s.options, ' / '))).code).toBe('invalid-command-name');
    await expect(stat(s.stateFile)).rejects.toThrow();
  });

  it('pins and unpins, globally or under the workspace', async () => {
    const s = await setup();
    await scanAndCache(s.options);
    const id = workspaceId(FIXTURE_WORKSPACE);

    const pinned = await pinCommand(s.options, 'compact');
    expect(pinned).toMatchObject({
      action: 'pin',
      command: '/compact',
      workspaceId: id,
      changed: true,
      scope: 'global',
      entry: { name: '/compact', pinned: true },
    });
    expect((await pinCommand(s.options, '/compact')).changed).toBe(false);
    const project = await pinCommand(s.options, '/deploy-check');
    expect(project).toMatchObject({ scope: 'workspace', entry: { pinned: true } });

    const state = JSON.parse(await readFile(s.stateFile, 'utf8')) as Record<string, unknown>;
    expect(state).toEqual({
      schemaVersion: 1,
      pinned: ['/compact'],
      edits: {},
      workspaces: { [id]: { pinned: ['/deploy-check'], edits: {} } },
    });
    const view = await loadCachedView(s.options);
    expect(view!.commands['/compact']!.pinned).toBe(true);
    expect(view!.commands['/deploy-check']!.pinned).toBe(true);

    expect(await unpinCommand(s.options, '/deploy-check')).toMatchObject({
      changed: true,
      scope: 'workspace',
      entry: { pinned: false },
    });
    const after = JSON.parse(await readFile(s.stateFile, 'utf8')) as Record<string, unknown>;
    expect(after['workspaces']).toEqual({});
  });

  it('edits and resets, with user-edit winning over the team', async () => {
    const ws = await workspaceCopy({
      schemaVersion: 1,
      commands: { '/compact': { guide: { whenToUse: 'Team when', example: '/compact team' } } },
    });
    const s = await setup(ws);
    await scanAndCache(s.options);
    await pinCommand(s.options, 'compact');

    const edited = await editCommand(s.options, '/compact', {
      description: 'My description',
      guide: { whenToUse: 'My when' },
    });
    expect(edited).toMatchObject({ action: 'edit', changed: true, scope: 'global' });
    expect(edited.entry).toMatchObject({
      description: 'My description',
      guide: { whenToUse: 'My when', example: '/compact team' },
      origins: {
        description: 'user-edit',
        'guide.whenToUse': 'user-edit',
        'guide.example': 'team',
      },
    });
    // null removes the user's value: the team text shows again.
    const removed = await editCommand(s.options, 'compact', { guide: { whenToUse: null } });
    expect(removed.entry!.guide!.whenToUse).toBe('Team when');

    const reset = await resetCommand(s.options, 'compact');
    expect(reset).toMatchObject({ action: 'reset', changed: true, scope: 'global' });
    expect(reset.entry).toMatchObject({ description: 'Free up context', pinned: true });
    expect(reset.entry!.origins.description).toBe('cli');
    expect((await resetCommand(s.options, 'compact')).changed).toBe(false);
  });

  it('rejects an edit that is not an edits entry', async () => {
    const s = await setup();
    await scanAndCache(s.options);
    for (const bad of [
      null,
      [],
      { descripton: 'typo' },
      { description: '' },
      { guide: { whenToUse: 3 } },
      { guide: { related: 'not a list' } },
      { argumentHint: 'not editable' },
    ]) {
      expect((await errorOf(editCommand(s.options, 'compact', bad as never))).code).toBe(
        'invalid-edit',
      );
    }
    await expect(stat(s.stateFile)).rejects.toThrow();
  });

  it('unpins and resets commands that are no longer in the catalog, in both scopes', async () => {
    const s = await setup();
    const id = workspaceId(FIXTURE_WORKSPACE);
    await mkdir(s.configDir, { recursive: true });
    await writeFile(
      s.stateFile,
      JSON.stringify({
        schemaVersion: 1,
        pinned: ['/gone', '/kept'],
        edits: { '/gone': { description: 'x' } },
        workspaces: { [id]: { pinned: ['/gone'], edits: {} }, other: { pinned: ['/gone'] } },
      }),
    );
    // No cache at all.
    expect(await unpinCommand(s.options, 'gone')).toMatchObject({
      changed: true,
      scope: 'both',
      entry: null,
    });
    expect(await resetCommand(s.options, '/gone')).toMatchObject({ changed: true, scope: 'both' });
    const state = JSON.parse(await readFile(s.stateFile, 'utf8')) as Record<string, unknown>;
    expect(state).toEqual({
      schemaVersion: 1,
      pinned: ['/kept'],
      edits: {},
      // Another workspace is never touched.
      workspaces: { other: { pinned: ['/gone'], edits: {} } },
    });
  });

  it('never overwrites an unreadable user state', async () => {
    const s = await setup();
    await scanAndCache(s.options);
    await mkdir(s.configDir, { recursive: true });
    const bytes = '{"schemaVersion": 7, "pinned": ["/compact"], "somethingNew": {}}';
    await writeFile(s.stateFile, bytes);

    const view = await scanAndCache(s.options);
    expect(view.warnings.map((w) => w.code)).toContain('state-unreadable');
    expect(view.commands['/compact']!.pinned).toBe(false);

    for (const call of [
      () => pinCommand(s.options, 'compact'),
      () => unpinCommand(s.options, 'compact'),
      () => editCommand(s.options, 'compact', { description: 'x' }),
      () => resetCommand(s.options, 'compact'),
    ]) {
      expect((await errorOf(call())).code).toBe('state-unreadable');
    }
    expect(await readFile(s.stateFile, 'utf8')).toBe(bytes);
    expect(await readdir(s.configDir)).toEqual(['state.json']);

    // Clearing the cache does not touch it either.
    await clearCache(s.options);
    expect(await readFile(s.stateFile, 'utf8')).toBe(bytes);
  });
});

describe('clearCache', () => {
  it('deletes the cache of the workspace, or of all workspaces, never the state', async () => {
    const s = await setup();
    await scanAndCache(s.options);
    await pinCommand(s.options, 'compact');
    const other = { ...s.options, workspace: await workspaceCopy() };
    await scanAndCache(other);

    expect(await clearCache(s.options)).toEqual({
      action: 'cache-clear',
      command: null,
      workspaceId: workspaceId(FIXTURE_WORKSPACE),
      changed: true,
      scope: 'workspace',
      entry: null,
    });
    expect(await loadCachedView(s.options)).toBeNull();
    expect(await loadCachedView(other)).not.toBeNull();
    expect((await clearCache(s.options)).changed).toBe(false);

    expect(await clearCache({ ...s.options, all: true })).toMatchObject({
      workspaceId: null,
      changed: true,
      scope: 'all',
    });
    expect(await loadCachedView(other)).toBeNull();
    expect(JSON.parse(await readFile(s.stateFile, 'utf8'))).toMatchObject({ pinned: ['/compact'] });
  });
});

describe('normalizeCommandName', () => {
  it('accepts names with or without the leading slash', () => {
    expect(normalizeCommandName('compact')).toBe('/compact');
    expect(normalizeCommandName('/gxrr:wiki')).toBe('/gxrr:wiki');
    expect(normalizeCommandName('  /x ')).toBe('/x');
    expect(() => normalizeCommandName('/')).toThrow(SlashDeckError);
  });
});
