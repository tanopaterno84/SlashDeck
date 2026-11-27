import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/discovery/frontmatter.js';
import { scanFiles, type FileItem } from '../src/discovery/file-source.js';
import { sha256, toPosixPath } from '../src/util.js';
import { FIXTURES, FIXTURE_WORKSPACE, makeHome } from './helpers.js';

function byName(items: FileItem[], name: string): FileItem {
  const item = items.find((i) => i.name === name);
  if (!item) throw new Error(`no item ${name}; have ${items.map((i) => i.name).join(', ')}`);
  return item;
}

describe('scanFiles', () => {
  it('finds every source type with kind, names and metadata', async () => {
    const home = await makeHome();
    const { items, plugins } = await scanFiles({ workspace: FIXTURE_WORKSPACE, homeDir: home });

    expect(items.map((i) => `${i.kind} ${i.name}`)).toEqual([
      'skill-user broken',
      'skill-user internal-skill',
      'skill-user my-skill',
      'skill-project proj-skill',
      'custom-user hello',
      'custom-user lint',
      'custom-project deploy-check',
      'skill-synced deep-research',
      'skill-synced docx',
      'plugin teamtools:deploy',
      'plugin teamtools:release',
      'plugin sync-plugin:helper',
    ]);
    expect(plugins).toEqual(['teamtools', 'sync-plugin']);

    const hello = byName(items, 'hello');
    expect(hello.description).toBe('Say hello to someone');
    expect(hello.argumentHint).toBe('[name]'); // YAML array turned back into the literal text
    expect(hello.userInvocable).toBe(true);

    const lint = byName(items, 'lint');
    expect(lint.matchNames).toEqual(['lint', 'tools:lint']);
    expect(lint.description).toBeUndefined();
    expect(lint.argumentHint).toBeUndefined();

    const deploy = byName(items, 'teamtools:deploy');
    expect(deploy.plugin).toBe('teamtools');
    expect(deploy.argumentHint).toBe('[env]');
    expect(deploy.description).toBe('Deploy the service.');

    expect(byName(items, 'proj-skill').description).toBe('A project skill.');
    expect(byName(items, 'sync-plugin:helper').plugin).toBe('sync-plugin');
  });

  it('marks skills with user-invocable: false', async () => {
    const home = await makeHome();
    const { items } = await scanFiles({ workspace: FIXTURE_WORKSPACE, homeDir: home });
    expect(byName(items, 'internal-skill').userInvocable).toBe(false);
    expect(byName(items, 'my-skill').userInvocable).toBe(true);
  });

  it('ignores .staging folders of synced skills', async () => {
    const home = await makeHome();
    const { items } = await scanFiles({ workspace: FIXTURE_WORKSPACE, homeDir: home });
    expect(items.some((i) => i.sourcePath.includes('.staging'))).toBe(false);
    expect(items.some((i) => i.name === 'staging-docx')).toBe(false);
    expect(items.filter((i) => i.name === 'docx')).toHaveLength(1);
  });

  it('degrades on malformed frontmatter with a warning', async () => {
    const home = await makeHome();
    const { items, warnings } = await scanFiles({ workspace: FIXTURE_WORKSPACE, homeDir: home });
    const broken = byName(items, 'broken');
    expect(broken.kind).toBe('skill-user');
    expect(
      warnings.some(
        (w) => w.code === 'frontmatter-malformed' && w.message.includes('broken/SKILL.md'),
      ),
    ).toBe(true);
  });

  it('writes sourcePath with forward slashes and hashes the file content', async () => {
    const home = await makeHome();
    const { items } = await scanFiles({ workspace: FIXTURE_WORKSPACE, homeDir: home });
    for (const item of items) {
      expect(item.sourcePath).not.toContain('\\');
      expect(item.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    const file = path.join(FIXTURE_WORKSPACE, '.claude', 'commands', 'deploy-check.md');
    const item = byName(items, 'deploy-check');
    expect(item.sourcePath).toBe(toPosixPath(file));
    expect(item.hash).toBe(sha256(await readFile(file)));
  });

  it('treats missing folders as empty, without warnings', async () => {
    const result = await scanFiles({
      workspace: path.join(FIXTURES, 'does-not-exist'),
      homeDir: path.join(FIXTURES, 'no-home-here'),
    });
    expect(result).toEqual({ items: [], plugins: [], warnings: [] });
  });

  it('warns on a malformed plugin registry and keeps the rest', async () => {
    const home = await makeHome({ registry: '{ not json' });
    const { items, plugins, warnings } = await scanFiles({
      workspace: FIXTURE_WORKSPACE,
      homeDir: home,
    });
    expect(warnings.map((w) => w.code)).toContain('plugin-registry-malformed');
    expect(plugins).toEqual(['sync-plugin']);
    expect(items.some((i) => i.name === 'my-skill')).toBe(true);
  });

  it('warns when a plugin install path is missing', async () => {
    const home = await makeHome({
      registry: {
        version: 2,
        plugins: { 'gone@mkt': [{ scope: 'user', installPath: path.join(FIXTURES, 'nope') }] },
      },
    });
    const { warnings, plugins } = await scanFiles({ workspace: FIXTURE_WORKSPACE, homeDir: home });
    expect(warnings.map((w) => w.code)).toContain('plugin-path-missing');
    expect(plugins).not.toContain('gone');
  });

  it('skips project-scoped plugins of other projects', async () => {
    const home = await makeHome();
    const installPath = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'teamtools', '1.0.0');
    const other = await makeHome({
      registry: {
        version: 2,
        plugins: {
          'teamtools@mkt': [
            { scope: 'project', projectPath: path.join(FIXTURES, 'elsewhere'), installPath },
          ],
        },
      },
    });
    const { plugins } = await scanFiles({ workspace: FIXTURE_WORKSPACE, homeDir: other });
    expect(plugins).not.toContain('teamtools');
  });
});

describe('parseFrontmatter', () => {
  it('handles no frontmatter, empty frontmatter and BOM', () => {
    expect(parseFrontmatter('just a body').data).toEqual({});
    expect(parseFrontmatter('---\n---\nbody').data).toEqual({});
    const bom = String.fromCharCode(0xfeff);
    expect(parseFrontmatter(`${bom}---\nname: x\n---\nbody`)).toMatchObject({
      data: { name: 'x' },
      body: 'body',
    });
  });

  it('reports an unterminated block', () => {
    expect(parseFrontmatter('---\nname: x\nbody').error).toBe('unterminated frontmatter');
  });

  it('reports a non-mapping frontmatter', () => {
    expect(parseFrontmatter('---\n- a\n- b\n---\n').error).toBe('frontmatter is not a mapping');
  });

  it('falls back to key: value lines on invalid YAML', () => {
    const fm = parseFrontmatter('---\nname: x\ndescription: a: [b\nuser-invocable: false\n---\n');
    expect(fm.error).toBeDefined();
    expect(fm.data).toMatchObject({ name: 'x', 'user-invocable': false });
  });
});
