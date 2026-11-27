import { describe, expect, it } from 'vitest';
import { nextCache } from '../src/cache/cache.js';
import { resolveView } from '../src/state/resolve.js';
import { emptyUserState, type UserState } from '../src/state/user-state.js';
import type { Catalog, CatalogEntry } from '../src/types.js';

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-03T10:00:00.000Z';

function catalog(entries: CatalogEntry[], scannedAt: string): Catalog {
  return {
    schemaVersion: 1,
    claudeCodeVersion: '2.1.318',
    source: 'cli',
    workspace: 'C:/repos/project',
    scannedAt,
    warnings: [{ code: 'frontmatter-malformed', message: 'm' }],
    commands: Object.fromEntries(entries.map((e) => [e.name, e])),
  };
}

const compact: CatalogEntry = {
  name: '/compact',
  kind: 'builtin',
  sourcePath: null,
  hash: 'sha256:1',
  category: 'context',
  description: 'Free up context',
  argumentHint: '<instructions>',
  origins: { description: 'cli', argumentHint: 'cli', category: 'curated' },
};
const deploy: CatalogEntry = {
  name: '/deploy',
  kind: 'custom-project',
  sourcePath: 'C:/repos/project/.claude/commands/deploy.md',
  hash: 'sha256:2',
  category: 'project',
  description: 'Deploy',
  origins: { description: 'cli', category: 'derived' },
};
const bare: CatalogEntry = {
  name: '/bare',
  kind: 'unknown',
  sourcePath: null,
  hash: 'sha256:3',
  category: 'other',
  origins: { category: 'derived' },
};

const first = nextCache(null, catalog([compact, deploy], T0));
const cache = nextCache(first, catalog([compact, deploy, bare], T1));

function resolve(state: UserState = emptyUserState(), team = {}) {
  return resolveView({ cache, workspaceId: 'ws1', state, team, now: new Date(T1), warnings: [] });
}

describe('resolveView', () => {
  it('returns the catalog as it is when there are no overrides', () => {
    const view = resolve();
    expect(view).toMatchObject({
      schemaVersion: 1,
      claudeCodeVersion: '2.1.318',
      source: 'cli',
      workspace: 'C:/repos/project',
      workspaceId: 'ws1',
      scannedAt: T1,
      warnings: [{ code: 'frontmatter-malformed', message: 'm' }],
    });
    expect(view.commands['/compact']).toEqual({
      ...compact,
      pinned: false,
      isNew: false,
      firstSeenAt: T0,
    });
    expect(view.commands['/bare']).toMatchObject({ isNew: true, firstSeenAt: T1 });
    expect(view.commands['/bare']).not.toHaveProperty('description');
    expect(view.commands['/bare']).not.toHaveProperty('guide');
  });

  it('applies the team override then the user edits, field by field', () => {
    const team = {
      '/compact': {
        description: 'Team text',
        guide: { whenToUse: 'Team when', related: ['/context'] },
      },
      '/bare': { guide: { example: '/bare now' }, category: 'team-tools' },
    };
    const state: UserState = {
      ...emptyUserState(),
      pinned: ['/compact'],
      edits: { '/compact': { guide: { whenToUse: 'My when' } } },
    };
    const view = resolve(state, team);
    expect(view.commands['/compact']).toMatchObject({
      description: 'Team text',
      argumentHint: '<instructions>',
      category: 'context',
      guide: { whenToUse: 'My when', related: ['/context'] },
      origins: {
        description: 'team',
        argumentHint: 'cli',
        category: 'curated',
        'guide.whenToUse': 'user-edit',
        'guide.related': 'team',
      },
      pinned: true,
    });
    // A command with no guide gets one; an unknown category ID is kept as it is.
    expect(view.commands['/bare']).toMatchObject({
      category: 'team-tools',
      guide: { example: '/bare now' },
      origins: { category: 'team', 'guide.example': 'team' },
    });
  });

  it('lists the categories present, in display order, after the overrides', () => {
    expect(resolve().categoryOrder).toEqual(['project', 'context', 'other']);
    // The team moves /bare to an unknown category and /compact to the project group: the
    // order follows the resolved categories, and `context` is gone.
    const team = { '/bare': { category: 'team-tools' }, '/compact': { category: 'project' } };
    expect(resolve(emptyUserState(), team).categoryOrder).toEqual(['project', 'team-tools']);
    // A user edit wins over the team, also for the order.
    const state: UserState = {
      ...emptyUserState(),
      edits: { '/bare': { category: 'plugin:zeta' } },
    };
    expect(resolve(state, team).categoryOrder).toEqual(['project', 'plugin:zeta']);
  });

  it('reads the pins and edits of project commands under the workspace', () => {
    const state: UserState = {
      ...emptyUserState(),
      // Global entries do not apply to a project command...
      pinned: ['/deploy'],
      edits: { '/deploy': { description: 'global' } },
      workspaces: {
        ws1: { pinned: [], edits: { '/deploy': { description: 'ws1 text' } } },
        ws2: { pinned: ['/deploy'], edits: {} },
      },
    };
    const view = resolve(state);
    expect(view.commands['/deploy']).toMatchObject({
      description: 'ws1 text',
      origins: { description: 'user-edit' },
      pinned: false,
    });
    // ...and workspace entries do not apply to a global command.
    const other = resolve({
      ...emptyUserState(),
      workspaces: { ws1: { pinned: ['/compact'], edits: {} } },
    });
    expect(other.commands['/compact']!.pinned).toBe(false);
  });

  it('never changes the cached catalog', () => {
    const before = JSON.stringify(cache);
    resolve(
      { ...emptyUserState(), edits: { '/compact': { description: 'x', guide: { example: 'y' } } } },
      { '/compact': { guide: { related: ['/a'] } } },
    );
    expect(JSON.stringify(cache)).toBe(before);
  });
});
