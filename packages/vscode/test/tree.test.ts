import { describe, expect, it } from 'vitest';
import {
  buildTree,
  commandContextValue,
  commandDescription,
  countNew,
  FAVOURITES_ID,
} from '../src/tree.js';
import { en, entry, italian, view } from './helpers.js';

const sample = view([
  entry('/compact', {
    category: 'context',
    description: 'Free up context',
    argumentHint: '<instructions>',
  }),
  entry('/clear', { category: 'session', description: 'Start a new session' }),
  entry('/mystery', { category: 'other' }),
  entry('/deploy-check', {
    kind: 'custom-project',
    category: 'project',
    sourcePath: 'C:/repo/.claude/commands/deploy-check.md',
    description: 'Check the deploy',
  }),
  entry('/teamtools:release', {
    kind: 'plugin',
    plugin: 'teamtools',
    category: 'plugin:teamtools',
  }),
  entry('/alpha:x', { kind: 'plugin', plugin: 'alpha', category: 'plugin:alpha' }),
  entry('/my-skill', { kind: 'skill-user', category: 'personal' }),
  entry('/docx', { kind: 'skill-synced', category: 'synced' }),
  entry('/team-thing', { kind: 'custom-project', category: 'team-special' }),
]);

describe('buildTree', () => {
  it('orders the groups like CLAUDE.md, project and team first, built-ins last', () => {
    const groups = buildTree(sample, en);
    expect(groups.map((g) => g.label)).toEqual([
      'Project',
      'Plugin: alpha',
      'Plugin: teamtools',
      'Personal',
      'Synced',
      'team-special', // unknown category ID: shown as it is
      'Session',
      'Context',
      'Other',
    ]);
  });

  it('has no Favourites group when nothing is pinned', () => {
    expect(buildTree(sample, en).some((g) => g.id === FAVOURITES_ID)).toBe(false);
  });

  it('puts pinned commands in Favourites, first, and keeps them in their group', () => {
    const v = view([
      entry('/b', { category: 'session', pinned: true }),
      entry('/a', { category: 'project', kind: 'custom-project', pinned: true }),
      entry('/c', { category: 'session' }),
    ]);
    const groups = buildTree(v, en);
    expect(groups[0]).toMatchObject({ id: FAVOURITES_ID, label: 'Favourites', description: '2' });
    expect(groups[0]!.children.map((c) => c.label)).toEqual(['/a', '/b']);
    expect(groups.find((g) => g.categoryId === 'session')!.children.map((c) => c.label)).toEqual([
      '/b',
      '/c',
    ]);
    const ids = groups.flatMap((g) => [g.id, ...g.children.map((c) => c.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('opens the custom groups and closes the built-in ones', () => {
    const groups = buildTree(sample, en);
    const expanded = Object.fromEntries(groups.map((g) => [g.label, g.expanded]));
    expect(expanded).toMatchObject({
      Project: true,
      'Plugin: alpha': true,
      Session: false,
      Other: false,
    });
    expect(groups.find((g) => g.label === 'Session')!.description).toBe('built-in · 1');
    expect(groups.find((g) => g.label === 'Project')!.description).toBe('1');
  });

  it('translates the category labels', async () => {
    const it_ = await italian();
    expect(buildTree(sample, it_).map((g) => g.label)).toEqual([
      'Progetto',
      'Plugin: alpha',
      'Plugin: teamtools',
      'Personali',
      'Sincronizzate',
      'team-special',
      'Sessione',
      'Contesto',
      'Altro',
    ]);
  });
});

describe('command items', () => {
  it('shows the argument hint and the description next to the name', () => {
    const e = sample.commands['/compact']!;
    expect(commandDescription(e, en)).toBe('<instructions> · Free up context');
    expect(commandDescription(sample.commands['/mystery']!, en)).toBe('');
  });

  it('cuts long descriptions', () => {
    const e = entry('/long', { description: 'word '.repeat(100) });
    expect(commandDescription(e, en).length).toBeLessThanOrEqual(120);
  });

  it('marks new commands in the text, the icon and the context value', () => {
    const e = entry('/fresh', {
      isNew: true,
      description: 'Fresh',
      category: 'project',
      kind: 'custom-project',
    });
    const node = buildTree(view([e]), en)[0]!.children[0]!;
    expect(node.description).toBe('New · Fresh');
    expect(node.icon).toBe('sparkle');
    expect(node.contextValue).toContain('new');
  });

  it('uses an icon per kind', () => {
    const icons = Object.fromEntries(
      buildTree(sample, en).flatMap((g) => g.children.map((c) => [c.label, c.icon])),
    );
    expect(icons).toMatchObject({
      '/deploy-check': 'repo',
      '/teamtools:release': 'extensions',
      '/my-skill': 'account',
      '/docx': 'cloud',
      '/clear': 'terminal',
    });
  });

  it('builds the context value matched by the menus', () => {
    expect(commandContextValue(entry('/a'))).toBe('command unpinned');
    expect(
      commandContextValue(
        entry('/b', {
          pinned: true,
          sourcePath: 'C:/x.md',
          origins: { description: 'user-edit' },
        }),
      ),
    ).toBe('command pinned hasSource edited');
    // The menu regexes of package.json tell "pinned" from "unpinned".
    expect(/^command\b.*\bpinned\b/.test('command unpinned')).toBe(false);
    expect(/^command\b.*\bunpinned\b/.test('command unpinned')).toBe(true);
  });
});

describe('countNew', () => {
  it('counts the new commands for the badge', () => {
    expect(countNew(null)).toBe(0);
    expect(
      countNew(view([entry('/a', { isNew: true }), entry('/b'), entry('/c', { isNew: true })])),
    ).toBe(2);
  });
});
