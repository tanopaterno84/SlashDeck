import { describe, expect, it } from 'vitest';
import type { BuiltinData } from '../src/data.js';
import type { CliResult } from '../src/discovery/cli-source.js';
import type { FileItem, FileScanResult } from '../src/discovery/file-source.js';
import { categoryForKind, matchFileItem, mergeCatalog } from '../src/discovery/merge.js';
import { hashFields } from '../src/util.js';

function item(partial: Partial<FileItem> & Pick<FileItem, 'kind' | 'name'>): FileItem {
  return {
    matchNames: [partial.name],
    sourcePath: `/src/${partial.name}.md`,
    hash: `sha256:${partial.name}`,
    userInvocable: true,
    ...partial,
  };
}

const files: FileScanResult = {
  items: [
    item({ kind: 'skill-user', name: 'my-skill', description: 'fm' }),
    item({ kind: 'custom-project', name: 'deploy-check', argumentHint: '[env]' }),
    item({ kind: 'custom-user', name: 'lint', matchNames: ['lint', 'tools:lint'] }),
    item({ kind: 'skill-synced', name: 'docx' }),
    item({ kind: 'skill-synced', name: 'deep-research' }),
    item({ kind: 'skill-user', name: 'quiet', userInvocable: false }),
    item({ kind: 'plugin', name: 'teamtools:deploy', plugin: 'teamtools' }),
    item({ kind: 'plugin', name: 'teamtools:release', plugin: 'teamtools' }),
  ],
  plugins: ['teamtools'],
  warnings: [],
};

const data: BuiltinData = {
  schemaVersion: 1,
  categories: { compact: 'context', help: 'session' },
  hidden: ['heapdump'],
  extra: [],
};

function cli(commands: CliResult['commands']): CliResult {
  return { claudeCodeVersion: '9.9.9', commands };
}

describe('matchFileItem', () => {
  it('matches plugin commands only under their plugin namespace', () => {
    expect(matchFileItem('teamtools:deploy', files)?.sourcePath).toBe('/src/teamtools:deploy.md');
    expect(matchFileItem('teamtools:missing', files)).toBeUndefined();
    expect(matchFileItem('deploy', files)).toBeUndefined();
  });

  it('matches synced skills by bare name and by prefixed name', () => {
    expect(matchFileItem('docx', files)?.kind).toBe('skill-synced');
    expect(matchFileItem('anthropic-skills:deep-research', files)?.name).toBe('deep-research');
    expect(matchFileItem('anthropic-skills:docx', files)?.name).toBe('docx');
  });

  it('matches nested commands by any of their candidate names', () => {
    expect(matchFileItem('lint', files)?.name).toBe('lint');
    expect(matchFileItem('tools:lint', files)?.name).toBe('lint');
  });

  it('returns undefined for unknown names', () => {
    expect(matchFileItem('mcp__server__prompt', files)).toBeUndefined();
    expect(matchFileItem('nothing', files)).toBeUndefined();
  });

  it('prefers the first item on name clashes', () => {
    const clash: FileScanResult = {
      ...files,
      items: [item({ kind: 'skill-user', name: 'x' }), item({ kind: 'skill-synced', name: 'x' })],
    };
    expect(matchFileItem('x', clash)?.kind).toBe('skill-user');
  });
});

describe('categoryForKind', () => {
  it('maps kinds to category IDs', () => {
    expect(categoryForKind('custom-project')).toBe('project');
    expect(categoryForKind('skill-project')).toBe('project');
    expect(categoryForKind('custom-user')).toBe('personal');
    expect(categoryForKind('skill-user')).toBe('personal');
    expect(categoryForKind('skill-synced')).toBe('synced');
    expect(categoryForKind('plugin', 'gxrr')).toBe('plugin:gxrr');
    expect(categoryForKind('unknown')).toBe('other');
  });
});

describe('mergeCatalog with the CLI', () => {
  const result = mergeCatalog({
    cli: cli([
      { name: 'compact', description: 'Free up context', argumentHint: '<i>', builtin: true },
      { name: 'mystery', description: 'No category', argumentHint: '', builtin: true },
      { name: '__remote', description: 'internal', argumentHint: '', builtin: true },
      { name: 'heapdump', description: 'internal', argumentHint: '', builtin: true },
      { name: 'my-skill', description: 'From CLI', argumentHint: '', builtin: false },
      { name: 'teamtools:deploy', description: 'Deploy', builtin: false },
      {
        name: 'anthropic-skills:deep-research',
        description: 'R',
        argumentHint: '',
        builtin: false,
      },
      { name: 'mcp__srv__p', description: 'MCP prompt', argumentHint: '', builtin: false },
      { name: 'quiet', description: 'CLI lists it anyway', argumentHint: '', builtin: false },
    ]),
    files,
    data,
  });

  it('uses the CLI as the authority on which commands exist', () => {
    expect(result.source).toBe('cli');
    expect(result.claudeCodeVersion).toBe('9.9.9');
    expect(Object.keys(result.commands)).toEqual([
      '/anthropic-skills:deep-research',
      '/compact',
      '/mcp__srv__p',
      '/my-skill',
      '/mystery',
      '/quiet',
      '/teamtools:deploy',
    ]);
  });

  it('hides names starting with __ and names in the hidden list', () => {
    expect(result.commands['/__remote']).toBeUndefined();
    expect(result.commands['/heapdump']).toBeUndefined();
  });

  it('builds builtin entries with curated or derived categories', () => {
    expect(result.commands['/compact']).toEqual({
      name: '/compact',
      kind: 'builtin',
      sourcePath: null,
      hash: hashFields('/compact', 'Free up context', '<i>'),
      category: 'context',
      description: 'Free up context',
      argumentHint: '<i>',
      origins: { description: 'cli', argumentHint: 'cli', category: 'curated' },
    });
    expect(result.commands['/mystery']).toMatchObject({
      category: 'other',
      origins: { category: 'derived' },
    });
  });

  it('attaches kind, sourcePath and hash from files but keeps CLI texts', () => {
    expect(result.commands['/my-skill']).toEqual({
      name: '/my-skill',
      kind: 'skill-user',
      sourcePath: '/src/my-skill.md',
      hash: 'sha256:my-skill',
      category: 'personal',
      description: 'From CLI',
      argumentHint: '',
      origins: { description: 'cli', argumentHint: 'cli', category: 'derived' },
    });
  });

  it('namespaces plugin entries and omits fields the CLI did not send', () => {
    const entry = result.commands['/teamtools:deploy']!;
    expect(entry).toMatchObject({
      kind: 'plugin',
      plugin: 'teamtools',
      category: 'plugin:teamtools',
    });
    expect('argumentHint' in entry).toBe(false);
    expect(entry.origins).toEqual({ description: 'cli', category: 'derived' });
  });

  it('matches prefixed synced skills', () => {
    expect(result.commands['/anthropic-skills:deep-research']).toMatchObject({
      kind: 'skill-synced',
      category: 'synced',
    });
  });

  it('keeps unmatched non-builtin entries as unknown', () => {
    expect(result.commands['/mcp__srv__p']).toEqual({
      name: '/mcp__srv__p',
      kind: 'unknown',
      sourcePath: null,
      hash: hashFields('/mcp__srv__p', 'MCP prompt', ''),
      category: 'other',
      description: 'MCP prompt',
      argumentHint: '',
      origins: { description: 'cli', argumentHint: 'cli', category: 'derived' },
    });
    expect(result.commands['/mcp__srv__p']!.plugin).toBeUndefined();
  });
});

describe('extra entries', () => {
  const withExtra: BuiltinData = {
    ...data,
    extra: [
      { name: 'help', description: 'Show help' },
      {
        name: '/resume',
        description: 'Resume a session',
        argumentHint: '[id]',
        category: 'session',
      },
      { name: 'compact', description: 'Curated text that must lose to the CLI' },
      { name: 'heapdump', description: 'Hidden extra' },
    ],
  };
  const result = mergeCatalog({
    cli: cli([
      { name: 'compact', description: 'Free up context', argumentHint: '', builtin: true },
    ]),
    files,
    data: withExtra,
  });

  it('adds interactive-only builtins with curated texts', () => {
    expect(result.commands['/help']).toEqual({
      name: '/help',
      kind: 'builtin',
      sourcePath: null,
      hash: hashFields('/help', 'Show help', undefined),
      category: 'session',
      description: 'Show help',
      origins: { description: 'curated', category: 'curated' },
    });
    expect(result.commands['/resume']).toMatchObject({
      argumentHint: '[id]',
      category: 'session',
      origins: { description: 'curated', argumentHint: 'curated', category: 'curated' },
    });
  });

  it('lets the CLI win over an extra with the same name, and hides hidden extras', () => {
    expect(result.commands['/compact']!.description).toBe('Free up context');
    expect(result.commands['/heapdump']).toBeUndefined();
  });

  it('is not used in file-only mode', () => {
    const fallback = mergeCatalog({ cli: null, files, data: withExtra });
    expect(fallback.commands['/help']).toBeUndefined();
  });
});

describe('mergeCatalog without the CLI', () => {
  const result = mergeCatalog({ cli: null, files, data });

  it('builds the catalog from files with local-metadata origins', () => {
    expect(result.source).toBe('files');
    expect(result.claudeCodeVersion).toBeNull();
    expect(result.commands['/my-skill']).toEqual({
      name: '/my-skill',
      kind: 'skill-user',
      sourcePath: '/src/my-skill.md',
      hash: 'sha256:my-skill',
      category: 'personal',
      description: 'fm',
      origins: { description: 'local-metadata', category: 'derived' },
    });
    expect(result.commands['/deploy-check']).toMatchObject({
      argumentHint: '[env]',
      origins: { argumentHint: 'local-metadata', category: 'derived' },
    });
    expect(result.commands['/teamtools:deploy']).toMatchObject({ plugin: 'teamtools' });
  });

  it('skips skills with user-invocable: false', () => {
    expect(result.commands['/quiet']).toBeUndefined();
  });

  it('warns on duplicate names and keeps the first', () => {
    const dup = mergeCatalog({
      cli: null,
      files: {
        ...files,
        items: [
          item({ kind: 'skill-user', name: 'x' }),
          item({ kind: 'custom-project', name: 'x', sourcePath: '/b.md' }),
        ],
      },
      data,
    });
    expect(dup.commands['/x']!.kind).toBe('skill-user');
    expect(dup.warnings.map((w) => w.code)).toEqual(['duplicate-name']);
  });
});

describe('hashFields', () => {
  it('is stable and depends on every field', () => {
    expect(hashFields('/a', 'd', 'h')).toBe(hashFields('/a', 'd', 'h'));
    expect(hashFields('/a', 'd', 'h')).not.toBe(hashFields('/a', 'd', ''));
    expect(hashFields('/a', 'd', 'h')).not.toBe(hashFields('/a', 'D', 'h'));
    expect(hashFields('/a', 'dh', '')).not.toBe(hashFields('/a', 'd', 'h'));
    expect(hashFields('/a')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
