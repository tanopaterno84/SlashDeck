import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.js';
import { builtinDataSchema, loadBuiltinData } from '../src/data.js';
import { scan } from '../src/scan.js';
import type { Catalog, ResolvedView } from '../src/types.js';
import { toPosixPath } from '../src/util.js';
import {
  FIXTURES,
  FIXTURE_WORKSPACE,
  SAMPLE_COMMANDS,
  fakeLauncher,
  initializeLine,
  makeHome,
} from './helpers.js';

const fixedNow = () => new Date('2026-11-27T10:00:00.000Z');

function countBy(catalog: Catalog, field: 'kind' | 'category'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of Object.values(catalog.commands))
    out[entry[field]] = (out[entry[field]] ?? 0) + 1;
  return out;
}

describe('scan', () => {
  it('merges the CLI answer with the files', async () => {
    const homeDir = await makeHome();
    const launcher = fakeLauncher({ stdout: initializeLine(SAMPLE_COMMANDS, '2.1.318') + '\n' });
    const catalog = await scan({
      workspace: FIXTURE_WORKSPACE,
      homeDir,
      claudePath: '/fake/claude',
      launcher,
      now: fixedNow,
    });

    expect(catalog).toMatchObject({
      schemaVersion: 1,
      claudeCodeVersion: '2.1.318',
      source: 'cli',
      workspace: toPosixPath(FIXTURE_WORKSPACE),
      scannedAt: '2026-11-27T10:00:00.000Z',
    });
    expect(launcher.calls[0]!.options.cwd).toBe(path.resolve(FIXTURE_WORKSPACE));
    expect(countBy(catalog, 'kind')).toEqual({
      builtin: 3,
      'custom-user': 1,
      'custom-project': 1,
      'skill-user': 1,
      'skill-project': 1,
      'skill-synced': 2,
      plugin: 3,
      unknown: 1,
    });
    expect(catalog.commands['/compact']!.category).toBe('context');
    expect(catalog.commands['/clear']!.category).toBe('session');
    expect(catalog.commands['/heapdump']).toBeUndefined();
    expect(catalog.commands['/__internal']).toBeUndefined();
    expect(catalog.commands['/sync-plugin:helper']).toMatchObject({
      kind: 'plugin',
      category: 'plugin:sync-plugin',
    });
    expect(catalog.commands['/mcp__server__prompt']!.kind).toBe('unknown');
    // Only the malformed fixture frontmatter warns.
    expect(catalog.warnings.map((w) => w.code)).toEqual(['frontmatter-malformed']);
  });

  it('falls back to files when the CLI fails', async () => {
    const homeDir = await makeHome();
    const catalog = await scan({
      workspace: FIXTURE_WORKSPACE,
      homeDir,
      claudePath: '/fake/claude',
      launcher: fakeLauncher({ exitCode: 3 }),
      now: fixedNow,
    });
    expect(catalog.source).toBe('files');
    expect(catalog.claudeCodeVersion).toBeNull();
    expect(catalog.warnings[0]).toMatchObject({ code: 'cli-exit' });
    expect(Object.keys(catalog.commands)).toEqual([
      '/broken',
      '/deep-research',
      '/deploy-check',
      '/docx',
      '/hello',
      '/lint',
      '/my-skill',
      '/proj-skill',
      '/sync-plugin:helper',
      '/teamtools:deploy',
      '/teamtools:release',
    ]);
    expect(catalog.commands['/hello']).toMatchObject({
      description: 'Say hello to someone',
      origins: {
        description: 'local-metadata',
        argumentHint: 'local-metadata',
        category: 'derived',
      },
    });
  });
});

describe('builtin data file', () => {
  it('is valid and lists the hidden entries', () => {
    const data = loadBuiltinData();
    expect(builtinDataSchema.safeParse(data).success).toBe(true);
    expect(data.hidden).toEqual(expect.arrayContaining(['heapdump', 'workflow-launch-exec']));
  });

  it('uses only builtin category IDs', () => {
    const allowed = [
      'session',
      'context',
      'model-permissions',
      'review-git',
      'mcp-plugins',
      'config',
      'other',
    ];
    const data = loadBuiltinData();
    for (const id of [
      ...Object.values(data.categories),
      ...data.extra.flatMap((e) => e.category ?? []),
    ]) {
      expect(allowed).toContain(id);
    }
  });
});

describe('slashdeck CLI', () => {
  function io(overrides: Partial<CliIo> = {}) {
    const out = { stdout: '', stderr: '' };
    const value: CliIo = {
      stdout: { write: (s: string) => (out.stdout += s) },
      stderr: { write: (s: string) => (out.stderr += s) },
      env: {},
      cwd: FIXTURES,
      ...overrides,
    };
    return { io: value, out };
  }

  it('prints the resolved view as JSON on stdout only', async () => {
    const homeDir = await makeHome();
    const launcher = fakeLauncher({ stdout: initializeLine(SAMPLE_COMMANDS) + '\n' });
    const { io: cliIo, out } = io({
      scanOverrides: { homeDir, launcher, claudePath: '/fake/claude', now: fixedNow },
    });
    const code = await runCli(['--', 'scan', '--workspace', 'workspace', '--json'], cliIo);

    expect(code).toBe(0);
    const view = JSON.parse(out.stdout) as ResolvedView;
    expect(view.source).toBe('cli');
    expect(view.workspace).toBe(toPosixPath(FIXTURE_WORKSPACE));
    expect(Object.keys(view).sort()).toEqual(
      [
        'schemaVersion',
        'claudeCodeVersion',
        'source',
        'workspace',
        'workspaceId',
        'scannedAt',
        'warnings',
        'categoryOrder',
        'commands',
      ].sort(),
    );
    expect(view.commands['/teamtools:deploy']).toMatchObject({
      name: '/teamtools:deploy',
      kind: 'plugin',
      plugin: 'teamtools',
      category: 'plugin:teamtools',
    });
    for (const entry of Object.values(view.commands)) {
      // No team override and no user state in this test; first scan, so nothing is new.
      expect(entry).not.toHaveProperty('guide');
      expect(entry).toMatchObject({ pinned: false, isNew: false });
      expect(entry.firstSeenAt).toBe('2026-11-27T10:00:00.000Z');
      if (entry.sourcePath !== null) expect(entry.sourcePath).not.toContain('\\');
    }
    // Warnings are also logged on stderr, never on stdout.
    expect(out.stderr).toContain('frontmatter-malformed');
  });

  it('exits with 0 and source "files" when the CLI is missing', async () => {
    const homeDir = await makeHome();
    const { io: cliIo, out } = io({
      scanOverrides: {
        homeDir,
        launcher: fakeLauncher({ errorCode: 'ENOENT' }),
        claudePath: '/fake/claude',
      },
    });
    const code = await runCli(['scan', '-w', FIXTURE_WORKSPACE], cliIo);
    expect(code).toBe(0);
    const catalog = JSON.parse(out.stdout) as Catalog;
    expect(catalog.source).toBe('files');
    expect(catalog.warnings[0]!.code).toBe('cli-not-found');
  });

  it('fails with exit code 2 on usage errors and 1 on a bad workspace', async () => {
    const a = io();
    expect(await runCli([], a.io)).toBe(2);
    expect(a.out.stdout).toBe('');
    const b = io();
    expect(await runCli(['frobnicate'], b.io)).toBe(2);
    const c = io();
    expect(await runCli(['scan', '--nope'], c.io)).toBe(2);
    const d = io();
    expect(await runCli(['scan', '--workspace', 'does-not-exist'], d.io)).toBe(1);
    expect(d.out.stdout).toBe('');
    expect(d.out.stderr).toContain('workspace is not a directory');
  });
});
