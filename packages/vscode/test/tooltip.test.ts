import { describe, expect, it } from 'vitest';
import { escapeMarkdown, tooltipMarkdown } from '../src/tooltip.js';
import { en, entry, italian } from './helpers.js';

/** Characters that start Markdown or HTML syntax, not preceded by a backslash. */
const UNESCAPED_SYNTAX = /(?<!\\)[[\]()<>!`&$#|~]/;

describe('escapeMarkdown', () => {
  it('escapes every ASCII punctuation character', () => {
    expect(escapeMarkdown('![x](https://evil.example/x.png)')).toBe(
      '\\!\\[x\\]\\(https\\:\\/\\/evil\\.example\\/x\\.png\\)',
    );
    expect(escapeMarkdown('<img src=x onerror=alert(1)>')).toBe(
      '\\<img src\\=x onerror\\=alert\\(1\\)\\>',
    );
  });

  it('flattens the text to one line and cuts it', () => {
    expect(escapeMarkdown('a\n\n# b\n- c')).toBe('a \\# b \\- c');
    expect(escapeMarkdown('word '.repeat(500)).length).toBeLessThan(700);
  });

  it('leaves letters, digits and non-ASCII text alone', () => {
    expect(escapeMarkdown('Già fatto 3 volte')).toBe('Già fatto 3 volte');
  });
});

describe('tooltipMarkdown', () => {
  const full = entry('/gxrr:wiki', {
    kind: 'plugin',
    plugin: 'gxrr',
    category: 'plugin:gxrr',
    sourcePath: 'C:/Users/me/.claude/plugins/cache/m/gxrr/1.0.0/skills/wiki/SKILL.md',
    description: 'File a document in the wiki',
    argumentHint: '<path>',
    guide: {
      whenToUse: 'After an analysis',
      example: '/gxrr:wiki analysis/note.md',
      related: ['/gxrr:doctor', '/init'],
    },
    origins: {
      description: 'cli',
      argumentHint: 'cli',
      category: 'derived',
      'guide.whenToUse': 'team',
      'guide.example': 'user-edit',
      'guide.related': 'team',
    },
    isNew: true,
    firstSeenAt: '2026-11-20T10:00:00.000Z',
    pinned: true,
  });

  it('shows the description, the arguments, the guide and the source file', () => {
    const md = tooltipMarkdown(full, en);
    expect(md).toContain('**\\/gxrr\\:wiki** \\<path\\>');
    expect(md).toContain('File a document in the wiki');
    expect(md).toContain('**Arguments:** \\<path\\>');
    expect(md).toContain('**When to use:** After an analysis');
    expect(md).toContain('**Example:** \\/gxrr\\:wiki analysis\\/note\\.md');
    expect(md).toContain('**Related:** \\/gxrr\\:doctor, \\/init');
    expect(md).toContain('**Source file:** C\\:\\/Users\\/me\\/');
    expect(md).toContain('**Type:** Plugin command or skill');
    expect(md).toContain('**Group:** Plugin\\: gxrr');
    expect(md).toContain('**New:** first seen on 2026\\-11\\-20');
    expect(md).toContain('_In your favourites_');
  });

  it('says where each text comes from', () => {
    const md = tooltipMarkdown(full, en);
    expect(md).toContain('File a document in the wiki  \n_From Claude Code_');
    expect(md).toContain('After an analysis — _From the team_');
    expect(md).toContain('analysis\\/note\\.md — _Edited by you_');
    expect(md).toContain('Plugin\\: gxrr — _Assigned by SlashDeck_');
  });

  it('handles a command with nothing but a name', () => {
    const md = tooltipMarkdown(entry('/bare', { origins: {} }), en);
    expect(md).toContain('_No description_');
    expect(md).not.toContain('Arguments');
    expect(md).not.toContain('Source file');
  });

  it('cannot be turned into links, images, HTML or headings by a description', () => {
    const evil = entry('/evil](command:workbench.action.terminal.sendSequence)', {
      kind: 'custom-project',
      category: 'project',
      sourcePath: 'C:/repo/.claude/commands/<evil>.md',
      description:
        '![x](https://evil.example/track.png) [click](command:workbench.action.terminal.sendSequence?%7B%7D) <img src="https://evil.example/a.png"> https://evil.example $(alert) `code` &amp; # Heading',
      argumentHint: '<a href="https://evil.example">x</a>',
      guide: {
        whenToUse: '[run](command:slashdeck.run)\n\n---\n\n# Big',
        example: '<script>alert(1)</script>',
        related: ['[x](https://evil.example)'],
      },
      origins: { description: 'team', 'guide.whenToUse': 'team' },
    });
    const md = tooltipMarkdown(evil, en);
    expect(md).not.toMatch(UNESCAPED_SYNTAX);
    expect(md).not.toMatch(/\n#/);
    expect(md).not.toContain('\n---');
    expect(md).not.toContain('https://');
  });

  it('is translated', async () => {
    const md = tooltipMarkdown(full, await italian());
    expect(md).toContain('**Quando usarlo:** After an analysis — _Dal team_');
    expect(md).toContain('_Da Claude Code_');
    expect(md).toContain('_Modificato da te_');
    expect(md).toContain('**File sorgente:**');
  });
});
