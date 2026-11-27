import { describe, expect, it } from 'vitest';
import { escapeIcons, queryTokens, rankCommands, searchItems } from '../src/search.js';
import { en, entry, view } from './helpers.js';

const sample = view([
  entry('/code-review', {
    category: 'review-git',
    description: 'Review the current diff, or a pull request, for correctness bugs',
  }),
  entry('/review', { category: 'review-git', description: 'Review a pull request' }),
  entry('/compact', {
    category: 'context',
    description: 'Clear conversation history but keep a summary in context',
    argumentHint: '<instructions>',
  }),
  entry('/gxrr:wiki', {
    kind: 'plugin',
    category: 'plugin:gxrr',
    description: "Documenta un'analisi nel wiki di architettura",
  }),
  entry('/deploy-check', {
    kind: 'custom-project',
    category: 'project',
    description: 'Checks the release',
    guide: { whenToUse: 'Before every deployment to dev01' },
    origins: { 'guide.whenToUse': 'team' },
  }),
  entry('/commit', {
    kind: 'custom-user',
    category: 'personal',
    description: 'Create a git commit',
  }),
]);

const names = (query: string) => rankCommands(sample, query, en).map((r) => r.entry.name);

describe('queryTokens', () => {
  it('drops stop words, accents, case and the leading slash', () => {
    expect(queryTokens('How do I review a Pull Request?')).toEqual(['review', 'pull', 'request']);
    expect(queryTokens("Voglio documentare un'analisi")).toEqual(['documentare', 'analisi']);
    expect(queryTokens('/gxrr:wiki')).toEqual(['gxrr:wiki']);
    expect(queryTokens('Già')).toEqual(['gia']);
  });

  it('keeps a query made only of stop words', () => {
    expect(queryTokens('do')).toEqual(['do']);
    expect(queryTokens('   ')).toEqual([]);
  });
});

describe('rankCommands', () => {
  it('finds a command by what it is for, with several words', () => {
    expect(names('review pull request').slice(0, 2)).toEqual(['/review', '/code-review']);
  });

  it('ranks matches in the name first', () => {
    expect(names('review')[0]).toBe('/review');
    expect(names('comp')[0]).toBe('/compact');
  });

  it('searches the team text "when to use"', () => {
    expect(names('deployment')).toContain('/deploy-check');
    expect(names('dev01')).toEqual(['/deploy-check']);
  });

  it('matches word forms and Italian queries', () => {
    expect(names('commits')).toContain('/commit');
    expect(names("voglio documentare un'analisi")[0]).toBe('/gxrr:wiki');
  });

  it('matches a full command name, with or without the slash', () => {
    expect(names('/gxrr:wiki')[0]).toBe('/gxrr:wiki');
    expect(names('wiki')[0]).toBe('/gxrr:wiki');
  });

  it('returns nothing for an empty query or no match', () => {
    expect(names('')).toEqual([]);
    expect(names('zzzz')).toEqual([]);
  });
});

describe('searchItems', () => {
  it('groups every command like the tree when the query is empty', () => {
    const v = view([
      entry('/b', { category: 'session' }),
      entry('/a', { category: 'project', kind: 'custom-project', pinned: true }),
      entry('/c', { category: 'session', pinned: true }),
    ]);
    const items = searchItems(v, '', en);
    expect(items.map((i) => (i.kind === 'separator' ? `-- ${i.label}` : i.label))).toEqual([
      '-- Favourites',
      '/a',
      '/c',
      // "Project" has no separator: its only command is in Favourites.
      '-- Session',
      '/b',
    ]);
  });

  it('lists the matches without groups, with hint, marks and description', () => {
    const items = searchItems(sample, 'context', en);
    expect(items[0]).toMatchObject({
      kind: 'command',
      label: '/compact',
      description: '<instructions> · Context',
      detail: 'Clear conversation history but keep a summary in context',
    });
    expect(items.every((i) => i.kind === 'command')).toBe(true);
  });

  it('shows icon syntax from descriptions literally', () => {
    expect(escapeIcons('run $(zap) now')).toBe('run \\$(zap) now');
    const v = view([entry('/x', { description: '$(alert) danger' })]);
    expect(searchItems(v, 'x', en)[0]).toMatchObject({ detail: '\\$(alert) danger' });
  });
});
