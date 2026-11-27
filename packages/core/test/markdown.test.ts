import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { exitQuietlyOnBrokenPipe, runCli, type CliIo } from '../src/cli.js';
import {
  MAX_DESCRIPTION_CHARS,
  categoryLabel,
  orderCategories,
  renderMarkdown,
  truncateText,
} from '../src/markdown.js';
import type { Catalog, CatalogEntry, ResolvedEntry, ResolvedView } from '../src/types.js';
import {
  FIXTURES,
  FIXTURE_WORKSPACE,
  SAMPLE_COMMANDS,
  fakeLauncher,
  initializeLine,
  makeHome,
} from './helpers.js';

function entry(name: string, fields: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    name,
    kind: 'builtin',
    sourcePath: null,
    hash: 'sha256:0',
    category: 'other',
    origins: {},
    ...fields,
  };
}

function catalog(entries: CatalogEntry[], fields: Partial<Catalog> = {}): Catalog {
  return {
    schemaVersion: 1,
    claudeCodeVersion: '2.1.318',
    source: 'cli',
    workspace: 'C:/repos/project',
    scannedAt: '2026-11-27T10:00:00.000Z',
    warnings: [],
    commands: Object.fromEntries(entries.map((e) => [e.name, e])),
    ...fields,
  };
}

/** The "## ..." headings of a rendered catalog, in order. */
function headings(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3));
}

describe('orderCategories', () => {
  it('follows the display order of CLAUDE.md, unknown IDs before the builtin groups', () => {
    const ids = [
      'other',
      'config',
      'zeta-team',
      'session',
      'synced',
      'plugin:zed',
      'personal',
      'review-git',
      'alpha-team',
      'plugin:abc',
      'project',
      'context',
      'mcp-plugins',
      'model-permissions',
    ];
    expect(orderCategories(ids)).toEqual([
      'project',
      'plugin:abc',
      'plugin:zed',
      'personal',
      'synced',
      'alpha-team',
      'zeta-team',
      'session',
      'context',
      'model-permissions',
      'review-git',
      'mcp-plugins',
      'config',
      'other',
    ]);
  });

  it('skips missing categories', () => {
    expect(orderCategories(['other', 'personal'])).toEqual(['personal', 'other']);
  });
});

describe('categoryLabel', () => {
  it('gives English labels and shows unknown IDs as they are', () => {
    expect(categoryLabel('project')).toBe('Project');
    expect(categoryLabel('plugin:gxrr')).toBe('Plugin: gxrr');
    expect(categoryLabel('model-permissions')).toBe('Built-in: Model and permissions');
    expect(categoryLabel('other')).toBe('Other');
    expect(categoryLabel('team-stuff')).toBe('team-stuff');
  });
});

describe('truncateText', () => {
  it('leaves short text alone and collapses whitespace', () => {
    expect(truncateText('  Free up\n  context  ')).toBe('Free up context');
  });

  it('cuts long text on a word boundary with an ellipsis', () => {
    const text = 'word '.repeat(200);
    const cut = truncateText(text, 50);
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(cut.endsWith('word...')).toBe(true);
  });

  it('does not leave trailing punctuation before the ellipsis', () => {
    expect(truncateText('alpha beta, gamma delta epsilon', 16)).toBe('alpha beta...');
  });

  it('cuts inside a word when there is no boundary close enough', () => {
    const cut = truncateText('x'.repeat(100), 20);
    expect(cut).toBe('x'.repeat(17) + '...');
  });

  it('uses MAX_DESCRIPTION_CHARS by default', () => {
    expect(truncateText('a '.repeat(1000)).length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
  });
});

describe('renderMarkdown', () => {
  const sample = catalog([
    entry('/compact', {
      category: 'context',
      description: 'Free up context',
      argumentHint: '<instructions>',
    }),
    entry('/clear', { category: 'session', description: 'Start a new session', argumentHint: '' }),
    entry('/mystery', { category: 'other', description: 'No category' }),
    entry('/mcp__srv__prompt', { kind: 'unknown', category: 'other', description: 'MCP prompt' }),
    entry('/deploy-check', {
      kind: 'custom-project',
      category: 'project',
      sourcePath: 'C:/repos/project/.claude/commands/deploy-check.md',
      description: 'Check the deploy\nbefore a release',
    }),
    entry('/team:release', {
      kind: 'plugin',
      plugin: 'team',
      category: 'plugin:team',
      sourcePath: 'C:/home/.claude/plugins/cache/mkt/team/1.0.0/commands/release.md',
      description: 'x '.repeat(400),
      argumentHint: '[version]',
    }),
    entry('/my-skill', {
      kind: 'skill-user',
      category: 'personal',
      sourcePath: 'C:/home/.claude/skills/my-skill/SKILL.md',
    }),
    entry('/team-thing', { kind: 'unknown', category: 'team-custom', description: 'Team' }),
  ]);
  const md = renderMarkdown(sample);

  it('prints a header with version, source and count', () => {
    expect(md.startsWith('# Slash command catalog\n')).toBe(true);
    expect(md).toContain('- Claude Code version: 2.1.318\n');
    expect(md).toContain('- Source: cli');
    expect(md).toContain('- Commands: 8\n');
    expect(md).not.toContain('Warnings:');
    expect(md).not.toContain('Built-in commands are missing');
  });

  it('groups by category in display order, with counts', () => {
    expect(headings(md)).toEqual([
      'Project (1)',
      'Plugin: team (1)',
      'Personal (1)',
      'team-custom (1)',
      'Built-in: Session (1)',
      'Built-in: Context (1)',
      'Other (2)',
    ]);
  });

  it('prints name, argument hint, description and source file', () => {
    expect(md).toContain('- `/compact <instructions>` - Free up context\n');
    expect(md).toContain('- `/clear` - Start a new session\n');
    expect(md).toContain(
      '- `/deploy-check` - Check the deploy before a release\n' +
        '  - file: C:/repos/project/.claude/commands/deploy-check.md\n',
    );
    expect(md).toContain('- `/my-skill` - (no description)\n');
    expect(md).toContain(
      '- `/mcp__srv__prompt` - MCP prompt\n  - file: not found (not a built-in command)\n',
    );
  });

  it('cuts long descriptions', () => {
    const line = md.split('\n').find((l) => l.startsWith('- `/team:release [version]`'))!;
    expect(line.endsWith('...')).toBe(true);
    const description = line.slice('- `/team:release [version]` - '.length);
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
  });

  it('uses ASCII only for its own text', () => {
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(md)).toBe(true);
  });

  it('says that builtins are missing in files mode, and lists warnings', () => {
    const files = renderMarkdown(
      catalog([entry('/hello', { kind: 'custom-user', category: 'personal' })], {
        source: 'files',
        claudeCodeVersion: null,
        warnings: [{ code: 'cli-not-found', message: 'Claude Code executable not found' }],
      }),
    );
    expect(files).toContain('- Claude Code version: unknown\n');
    expect(files).toContain('- Source: files');
    expect(files).toContain('> Built-in commands are missing');
    expect(files).toContain('Warnings:\n- [cli-not-found] Claude Code executable not found\n');
  });

  it('renders an empty catalog', () => {
    const empty = renderMarkdown(catalog([]));
    expect(empty).toContain('- Commands: 0\n');
    expect(headings(empty)).toEqual([]);
  });
});

describe('renderMarkdown of a resolved view', () => {
  function resolved(name: string, fields: Partial<ResolvedEntry> = {}): ResolvedEntry {
    return { ...entry(name), pinned: false, isNew: false, firstSeenAt: null, ...fields };
  }
  const view: ResolvedView = {
    ...catalog([]),
    workspaceId: '0123456789abcdef',
    categoryOrder: ['context'],
    commands: {
      '/compact': resolved('/compact', {
        category: 'context',
        description: 'Team text',
        guide: { whenToUse: 'When full', example: '/compact keep tests', related: ['/context'] },
        origins: {
          description: 'team',
          'guide.whenToUse': 'user-edit',
          'guide.example': 'team',
          'guide.related': 'team',
        },
        pinned: true,
      }),
      '/fresh': resolved('/fresh', { category: 'context', description: 'New one', isNew: true }),
    },
  };
  const md = renderMarkdown(view);

  it('prints the marks, the guide and who wrote each text', () => {
    expect(md).toContain(
      '- Marks: [pinned] = pinned by the user; [new] = appeared in the last 14 days\n',
    );
    expect(md).toContain(
      '- (team) = written by the team in .claude/slashdeck.json; (user) = edited by the user\n',
    );
    expect(md).toContain(
      '- `/compact` [pinned] - Team text (team)\n' +
        '  - when to use (user): When full\n' +
        '  - example (team): /compact keep tests\n' +
        '  - related (team): /context\n',
    );
    expect(md).toContain('- `/fresh` [new] - New one\n');
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(md)).toBe(true);
  });

  it('prints no legend when nothing is marked or annotated', () => {
    const plain = renderMarkdown({ ...view, commands: { '/fresh': resolved('/fresh') } });
    expect(plain).not.toContain('Marks:');
    expect(plain).not.toContain('(team) =');
  });
});

describe('slashdeck scan --markdown', () => {
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

  it('prints the catalog as Markdown', async () => {
    const homeDir = await makeHome();
    const launcher = fakeLauncher({ stdout: initializeLine(SAMPLE_COMMANDS, '2.1.318') + '\n' });
    const { io: cliIo, out } = io({
      scanOverrides: { homeDir, launcher, claudePath: '/fake/claude' },
    });
    const code = await runCli(['scan', '--workspace', FIXTURE_WORKSPACE, '--markdown'], cliIo);

    expect(code).toBe(0);
    expect(out.stdout.startsWith('# Slash command catalog\n')).toBe(true);
    expect(out.stdout).toContain('- Claude Code version: 2.1.318\n');
    expect(headings(out.stdout)).toEqual([
      'Project (2)',
      'Plugin: sync-plugin (1)',
      'Plugin: teamtools (2)',
      'Personal (2)',
      'Synced (2)',
      'Built-in: Session (1)',
      'Built-in: Context (1)',
      'Other (2)',
    ]);
    expect(out.stdout).toContain('- `/teamtools:deploy [env]` - Deploy (cli)\n  - file: ');
    // Warnings go to stderr too, unless --quiet.
    expect(out.stderr).toContain('frontmatter-malformed');
  });

  it('does not log warnings with --quiet', async () => {
    const homeDir = await makeHome();
    const { io: cliIo, out } = io({
      scanOverrides: {
        homeDir,
        launcher: fakeLauncher({ errorCode: 'ENOENT' }),
        claudePath: '/fake/claude',
      },
    });
    const code = await runCli(['scan', '-w', FIXTURE_WORKSPACE, '--markdown', '-q'], cliIo);
    expect(code).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain('- Source: files');
    expect(out.stdout).toContain('> Built-in commands are missing');
    expect(out.stdout).toContain('- [cli-not-found]');
  });

  it('rejects --json together with --markdown', async () => {
    const { io: cliIo, out } = io({
      scanOverrides: { launcher: fakeLauncher({ errorCode: 'ENOENT' }) },
    });
    const code = await runCli(['scan', '--json', '--markdown'], cliIo);
    expect(code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('--json and --markdown cannot be used together');
  });
});

describe('exitQuietlyOnBrokenPipe', () => {
  it('exits with 0 on EPIPE', () => {
    const stream = new EventEmitter();
    const exit = vi.fn();
    exitQuietlyOnBrokenPipe(stream, exit);
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('rethrows other errors', () => {
    const stream = new EventEmitter();
    const exit = vi.fn();
    exitQuietlyOnBrokenPipe(stream, exit);
    expect(() => stream.emit('error', Object.assign(new Error('boom'), { code: 'EIO' }))).toThrow(
      'boom',
    );
    expect(exit).not.toHaveBeenCalled();
  });
});
