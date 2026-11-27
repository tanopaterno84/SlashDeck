import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanFiles } from '@slashdeck/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  definitionFingerprint,
  isDefinitionChange,
  relativeSegments,
  type ChangeType,
  type WatchArea,
} from '../src/refresh-policy.js';
import { RefreshScheduler } from '../src/scheduler.js';

const seg = (p: string) => p.split('/');
const relevant = (area: WatchArea, p: string, type: ChangeType = 'change') =>
  isDefinitionChange(area, p === '' ? [] : seg(p), type);
const ALL: ChangeType[] = ['create', 'change', 'delete'];

describe('relativeSegments', () => {
  const base = path.resolve('/home/me/.claude/plugins');

  it('splits the path below the base', () => {
    expect(relativeSegments(base, path.join(base, 'synced', 'g', 'manifest.json'))).toEqual([
      'synced',
      'g',
      'manifest.json',
    ]);
    expect(relativeSegments(base, base)).toEqual([]);
  });

  it('is null outside the base', () => {
    expect(relativeSegments(base, path.resolve('/home/me/.claude/skills/x/SKILL.md'))).toBeNull();
  });
});

describe('isDefinitionChange: what Claude Code writes when it starts', () => {
  // Observed on the user's machine right after a scan, and similar files.
  const id = '32ab76b9_74d8befd';
  const bookkeeping: [WatchArea, string][] = [
    ['plugins', `synced/${id}/.last-complete-round`],
    ['plugins', `synced/${id}/manifest.json`],
    ['plugins', `synced/${id}/.marketplaces.json`],
    ['plugins', `synced/${id}/cowork~g2/.in_use`],
    ['plugins', `synced/${id}/cowork~g2/.in_use/12345`],
    ['plugins', `synced/${id}/cowork~g2.meta.json`],
    ['plugins', `synced/.bucket-${id}`],
    ['plugins', `synced/.bucket-${id}/x`],
    ['plugins', `synced/${id}/cowork~g2/LICENSE.txt`],
    ['plugins', `synced/${id}/cowork~g2/skills/s/reference.md`],
    ['plugins', 'known_marketplaces.json'],
    ['skills', '.staging'],
    ['skills', '.staging/abc/SKILL.md'],
    ['skills', `synced/${id}/manifest.json`],
    ['skills', `synced/${id}/.staging/s/SKILL.md`],
    ['skills', 'my-skill/scripts/run.py'],
    ['skills', 'my-skill/notes.md'],
    ['commands', '.DS_Store'],
    ['commands', '.hidden/x.md'],
    ['commands', 'notes.txt'],
    ['project', '.claude/skills/.staging/x/SKILL.md'],
    ['project', '.claude/commands/.git/HEAD'],
    ['project', '.claude/settings.local.json'],
  ];

  it.each(bookkeeping)('%s: %s is not a definition', (area, p) => {
    for (const type of ALL) expect(relevant(area, p, type), type).toBe(false);
  });

  it('ignores a folder that only "changed" (its content is reported on its own)', () => {
    expect(relevant('plugins', `synced/${id}`, 'change')).toBe(false);
    expect(relevant('plugins', `synced/${id}/cowork~g2`, 'change')).toBe(false);
    expect(relevant('skills', 'my-skill', 'change')).toBe(false);
    expect(relevant('roots', 'skills', 'change')).toBe(false);
    expect(relevant('commands', '', 'change')).toBe(false);
  });
});

describe('isDefinitionChange: definitions', () => {
  const definitions: [WatchArea, string][] = [
    ['commands', 'deploy.md'],
    ['commands', 'ops/deploy.md'],
    ['commands', 'README.MD'],
    ['skills', 'my-skill/SKILL.md'],
    ['skills', 'synced/g/s/skill.md'],
    ['project', '.claude/commands/a.md'],
    ['project', '.claude/commands/sub/a.md'],
    ['project', '.claude/skills/s/SKILL.md'],
    ['plugins', 'installed_plugins.json'],
    ['plugins', 'synced/g/p~g2/.claude-plugin/plugin.json'],
    ['plugins', 'synced/g/p~g2/skills/s/SKILL.md'],
    ['plugins', 'synced/g/p~g2/commands/c.md'],
    ['file', 'state.json'],
  ];

  it.each(definitions)('%s: %s is a definition', (area, p) => {
    for (const type of ALL) expect(relevant(area, p, type), type).toBe(true);
  });

  it('notices folders that appear or go away', () => {
    for (const type of ['create', 'delete'] as const) {
      expect(relevant('skills', 'new-skill', type)).toBe(true);
      expect(relevant('commands', 'ops', type)).toBe(true);
      expect(relevant('commands', '', type)).toBe(true);
      expect(relevant('roots', 'skills', type)).toBe(true);
      expect(relevant('roots', 'commands', type)).toBe(true);
      expect(relevant('project', '.claude', type)).toBe(true);
      expect(relevant('project', '.claude/skills', type)).toBe(true);
      expect(relevant('plugins', 'synced/g/p~g3', type)).toBe(true);
      expect(relevant('plugins', 'synced/g/p~g3/.claude-plugin', type)).toBe(true);
    }
  });

  it('only accepts plugin.json in .claude-plugin, and command files of plugins', () => {
    expect(relevant('plugins', 'synced/g/p/plugin.json')).toBe(false);
    expect(relevant('plugins', 'synced/g/p/README.md')).toBe(false);
    expect(relevant('plugins', 'synced/g/p/.claude-plugin/marketplace.json')).toBe(false);
  });

  it('lets the fingerprint decide for a path outside the base', () => {
    expect(isDefinitionChange('plugins', null, 'change')).toBe(true);
  });
});

describe('definitionFingerprint (with the core file scan)', () => {
  let root: string;
  let home: string;
  let workspace: string;
  let claudeDir: string;

  const fingerprint = async () =>
    definitionFingerprint(await scanFiles({ workspace, homeDir: home, claudeDir }));

  async function put(file: string, text: string) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }

  /** What Claude Code writes in the user folder when it starts. */
  async function bookkeeping(round: number) {
    const group = path.join(claudeDir, 'plugins', 'synced', 'group-a');
    await put(path.join(group, '.last-complete-round'), String(round));
    await put(path.join(group, 'manifest.json'), JSON.stringify({ round }));
    await put(path.join(group, 'tools~g2', '.in_use', String(round)), '');
    await put(path.join(group, 'tools~g2.meta.json'), JSON.stringify({ round }));
    await put(
      path.join(claudeDir, 'skills', '.staging', `s${round}`, 'SKILL.md'),
      `round ${round}`,
    );
    await put(path.join(claudeDir, 'skills', 'synced', 'g', 'manifest.json'), String(round));
    await put(path.join(claudeDir, 'plugins', 'known_marketplaces.json'), String(round));
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'slashdeck-fp-'));
    home = path.join(root, 'home');
    workspace = path.join(root, 'ws');
    claudeDir = path.join(home, '.claude');
    await put(path.join(workspace, '.claude', 'commands', 'deploy.md'), 'deploy');
    await put(path.join(claudeDir, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n');
    await put(
      path.join(
        claudeDir,
        'plugins',
        'synced',
        'group-a',
        'tools~g2',
        '.claude-plugin',
        'plugin.json',
      ),
      JSON.stringify({ name: 'tools' }),
    );
    await put(
      path.join(
        claudeDir,
        'plugins',
        'synced',
        'group-a',
        'tools~g2',
        'skills',
        'lint',
        'SKILL.md',
      ),
      'lint',
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does not change when only bookkeeping files are written', async () => {
    const before = await fingerprint();
    await bookkeeping(1);
    await bookkeeping(2);
    expect(await fingerprint()).toBe(before);
  });

  it('changes when a command is added, edited or deleted', async () => {
    const a = await fingerprint();
    await put(path.join(workspace, '.claude', 'commands', 'new.md'), 'new');
    const b = await fingerprint();
    expect(b).not.toBe(a);
    await put(path.join(workspace, '.claude', 'commands', 'new.md'), 'new, edited');
    const c = await fingerprint();
    expect(c).not.toBe(b);
    await unlink(path.join(workspace, '.claude', 'commands', 'new.md'));
    expect(await fingerprint()).toBe(a);
  });

  it('changes when a skill of the user folder or of a plugin is edited', async () => {
    const a = await fingerprint();
    await put(path.join(claudeDir, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\nmore');
    const b = await fingerprint();
    expect(b).not.toBe(a);
    await put(
      path.join(
        claudeDir,
        'plugins',
        'synced',
        'group-a',
        'tools~g2',
        'skills',
        'lint',
        'SKILL.md',
      ),
      'lint v2',
    );
    expect(await fingerprint()).not.toBe(b);
  });

  it('changes when a plugin is installed', async () => {
    const a = await fingerprint();
    const installPath = path.join(claudeDir, 'plugins', 'cache', 'mk', 'review', '1.0.0');
    await put(path.join(installPath, '.claude-plugin', 'plugin.json'), '{"name":"review"}');
    expect(await fingerprint()).toBe(a); // not registered yet
    await put(
      path.join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'review@mk': [{ scope: 'user', installPath }] } }),
    );
    expect(await fingerprint()).not.toBe(a);
  });

  it('with the scheduler: Claude Code bookkeeping never causes a scan, a real change one', async () => {
    let baseline: string | null = null;
    let round = 0;

    const kinds: string[] = [];
    const scheduler: RefreshScheduler = new RefreshScheduler({
      // As the controller does: baseline first, then "start Claude Code", which writes its
      // bookkeeping files; the watchers (no filter here) report every write.
      scan: async (kind) => {
        kinds.push(kind);
        baseline = await fingerprint();
        await bookkeeping(++round);
        scheduler.requestScan();
      },
      reload: async () => {},
      delayMs: 20,
      isScanNeeded: async () => baseline === null || (await fingerprint()) !== baseline,
      safetyNet: { minIntervalMs: 50, maxIntervalMs: 400, quietMs: 1000, maxStreak: 6 },
    });
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await scheduler.idle();
    };
    await scheduler.scanNow('event');
    await settle();
    expect(kinds).toEqual(['event']);

    // Another window's Claude Code writes the same files: still no scan.
    await bookkeeping(100);
    scheduler.requestScan();
    await settle();
    expect(kinds).toEqual(['event']);

    // A real change: exactly one scan, though it writes bookkeeping again.
    await put(path.join(workspace, '.claude', 'commands', 'new.md'), 'new');
    for (let i = 0; i < 5; i++) scheduler.requestScan();
    await settle();
    expect(kinds).toEqual(['event', 'auto']);
    scheduler.dispose();
  });

  it('is independent of the order of the items', () => {
    const item = (name: string) => ({
      kind: 'custom-user' as const,
      name,
      matchNames: [name],
      sourcePath: `/x/${name}.md`,
      hash: `sha256:${name}`,
      userInvocable: true,
    });
    expect(definitionFingerprint({ items: [item('a'), item('b')], plugins: ['p', 'q'] })).toBe(
      definitionFingerprint({ items: [item('b'), item('a')], plugins: ['q', 'p'] }),
    );
  });
});
