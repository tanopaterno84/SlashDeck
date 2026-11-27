import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT, runCli, type CliIo } from '../src/cli.js';
import { orderCategories } from '../src/markdown.js';
import { workspaceId } from '../src/paths.js';
import type { ResolvedEntry, ResolvedView } from '../src/types.js';
import {
  FIXTURES,
  FIXTURE_WORKSPACE,
  SAMPLE_COMMANDS,
  fakeLauncher,
  initializeLine,
  makeHome,
  makeTempDir,
} from './helpers.js';

const NOW = () => new Date('2026-11-27T10:00:00.000Z');

/** A CLI environment whose cache and state live in temp folders, set through the env. */
async function cli() {
  const homeDir = await makeHome();
  const root = await makeTempDir('cli');
  const env = {
    SLASHDECK_CACHE_DIR: path.join(root, 'cache'),
    SLASHDECK_CONFIG_DIR: path.join(root, 'config'),
  };
  const stateFile = path.join(env.SLASHDECK_CONFIG_DIR, 'state.json');
  const run = async (args: string[], stdin?: string) => {
    const out = { stdout: '', stderr: '' };
    const io: CliIo = {
      stdout: { write: (s: string) => (out.stdout += s) },
      stderr: { write: (s: string) => (out.stderr += s) },
      env,
      cwd: FIXTURES,
      readStdin: async () => stdin ?? '',
      scanOverrides: {
        homeDir,
        claudePath: '/fake/claude',
        launcher: fakeLauncher({ stdout: initializeLine(SAMPLE_COMMANDS, '2.1.318') + '\n' }),
        now: NOW,
      },
    };
    const workspace = args.includes('--workspace') ? [] : ['--workspace', FIXTURE_WORKSPACE];
    const code = await runCli([...args, ...workspace], io);
    return { code, ...out, json: () => JSON.parse(out.stdout) as unknown };
  };
  return { run, env, stateFile };
}

const WRITE_KEYS = ['action', 'changed', 'command', 'entry', 'scope', 'workspaceId'];

describe('slashdeck scan --cached / get', () => {
  it('exits with 3 and prints nothing when there is no cache yet', async () => {
    const { run } = await cli();
    for (const args of [
      ['scan', '--cached'],
      ['scan', '--cached', '--markdown'],
      ['get', 'compact'],
    ]) {
      const r = await run(args);
      expect(r.code).toBe(EXIT.noCache);
      expect(r.code).toBe(3);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('no cached catalog');
    }
  });

  it('prints the cached view after a scan, and single commands with get', async () => {
    const { run } = await cli();
    const scanned = await run(['scan']);
    expect(scanned.code).toBe(0);
    const cached = await run(['scan', '--cached', '--json']);
    expect(cached.code).toBe(0);
    expect(cached.json()).toEqual(scanned.json());

    // The display order of the categories travels with the view, for the JetBrains plugin.
    const view = scanned.json() as ResolvedView;
    const categories = new Set(Object.values(view.commands).map((e) => e.category));
    expect(view.categoryOrder).toEqual(orderCategories(categories));
    expect(new Set(view.categoryOrder)).toEqual(categories);
    expect(view.categoryOrder[0]).toBe('project');
    expect(Object.keys(view).at(-1)).toBe('commands');

    const get = await run(['get', 'compact', '--json']);
    expect(get.code).toBe(0);
    expect(get.json()).toEqual((scanned.json() as ResolvedView).commands['/compact']);
    expect((await run(['get', '/compact'])).stdout).toBe(get.stdout);

    const missing = await run(['get', 'nope']);
    expect(missing.code).toBe(EXIT.notInCatalog);
    expect(missing.stdout).toBe('');
  });
});

describe('slashdeck write commands', () => {
  it('pin, unpin, edit, reset and cache clear print a uniform JSON result', async () => {
    const { run, stateFile } = await cli();
    expect((await run(['pin', 'compact'])).code).toBe(EXIT.noCache);
    await run(['scan']);

    const pin = await run(['pin', '/compact']);
    expect(pin.code).toBe(0);
    const pinned = pin.json() as Record<string, unknown>;
    expect(Object.keys(pinned).sort()).toEqual(WRITE_KEYS);
    expect(pinned).toMatchObject({
      action: 'pin',
      command: '/compact',
      workspaceId: workspaceId(FIXTURE_WORKSPACE),
      changed: true,
      scope: 'global',
      entry: { name: '/compact', pinned: true },
    });

    const edit = await run(
      ['edit', 'compact'],
      '{"guide": {"whenToUse": "When the context is full"}}',
    );
    expect(edit.code).toBe(0);
    expect(edit.json()).toMatchObject({
      action: 'edit',
      changed: true,
      entry: { guide: { whenToUse: 'When the context is full' } },
    });
    const get = (await run(['get', 'compact'])).json() as ResolvedEntry;
    expect(get.origins['guide.whenToUse']).toBe('user-edit');

    const reset = await run(['reset', 'compact']);
    expect(reset.json()).toMatchObject({ action: 'reset', changed: true, entry: { pinned: true } });
    expect((reset.json() as { entry: ResolvedEntry }).entry).not.toHaveProperty('guide');

    const unpin = await run(['unpin', 'compact']);
    expect(unpin.json()).toMatchObject({
      action: 'unpin',
      changed: true,
      entry: { pinned: false },
    });

    const clear = await run(['cache', 'clear']);
    expect(clear.code).toBe(0);
    expect(Object.keys(clear.json() as object).sort()).toEqual(WRITE_KEYS);
    expect(clear.json()).toMatchObject({
      action: 'cache-clear',
      changed: true,
      scope: 'workspace',
    });
    expect((await run(['scan', '--cached'])).code).toBe(EXIT.noCache);
    expect((await run(['cache', 'clear', '--all'])).json()).toMatchObject({ scope: 'all' });

    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({
      schemaVersion: 1,
      pinned: [],
      edits: {},
      workspaces: {},
    });
  });

  it('rejects an invalid edit with exit code 2', async () => {
    const { run } = await cli();
    await run(['scan']);
    for (const stdin of ['', 'not json', '{"descripton": "typo"}', '{"guide": {"example": ""}}']) {
      const r = await run(['edit', 'compact'], stdin);
      expect(r.code).toBe(EXIT.usage);
      expect(r.stdout).toBe('');
    }
    expect((await run(['edit', 'nope'], '{"description": "x"}')).code).toBe(EXIT.notInCatalog);
  });

  it('exits with 1 and leaves an unreadable state file untouched', async () => {
    const { run, env, stateFile } = await cli();
    await run(['scan']);
    await mkdir(env.SLASHDECK_CONFIG_DIR, { recursive: true });
    await writeFile(stateFile, 'garbage{');
    for (const args of [
      ['pin', 'compact'],
      ['unpin', 'compact'],
      ['reset', 'compact'],
    ]) {
      const r = await run(args);
      expect(r.code).toBe(EXIT.error);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('unreadable');
    }
    const edit = await run(['edit', 'compact'], '{"description": "x"}');
    expect(edit.code).toBe(EXIT.error);
    expect(await readFile(stateFile, 'utf8')).toBe('garbage{');
    // Reads still work, with a warning.
    const scan = await run(['scan', '--cached']);
    expect(scan.code).toBe(0);
    expect(scan.stderr).toContain('[state-unreadable]');
  });

  it('reports usage errors with exit code 2', async () => {
    const { run } = await cli();
    for (const args of [
      ['get'],
      ['pin'],
      ['pin', 'a', 'b'],
      ['cache'],
      ['cache', 'purge'],
      ['get', 'compact', '--cached'],
      ['get', 'compact', '--markdown'],
      ['scan', '--all'],
      ['get', '/'],
    ]) {
      const r = await run(args);
      expect([args, r.code]).toEqual([args, EXIT.usage]);
      expect(r.stdout).toBe('');
    }
  });
});

describe('slashdeck scan --markdown with a team override', () => {
  it('shows guide texts, their authors and the marks', async () => {
    const ws = await makeTempDir('ws');
    await cp(FIXTURE_WORKSPACE, ws, { recursive: true });
    await writeFile(
      path.join(ws, '.claude', 'slashdeck.json'),
      JSON.stringify({
        schemaVersion: 1,
        commands: { '/deploy-check': { guide: { whenToUse: 'Before every release.' } } },
      }),
    );
    const { run } = await cli();
    const runIn = (args: string[], stdin?: string) => run([...args, '--workspace', ws], stdin);
    expect((await runIn(['scan'])).code).toBe(0);
    await runIn(['pin', 'deploy-check']);
    await runIn(['edit', 'compact'], '{"description": "My own text"}');

    const md = (await runIn(['scan', '--markdown'])).stdout;
    expect(md).toContain('- Marks: [pinned]');
    expect(md).toContain('(team) = written by the team');
    expect(md).toContain(
      '- `/deploy-check` [pinned] - Check deploy (cli)\n  - when to use (team): Before every release.\n',
    );
    expect(md).toContain('- `/compact <instructions>` - My own text (user)\n');
  });
});
