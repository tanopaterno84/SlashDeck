import { writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SlashDeckError } from '../src/errors.js';
import { writeFileAtomic } from '../src/fs-util.js';
import { mergeEdit } from '../src/state/edit.js';
import { readTeamOverride } from '../src/state/team.js';
import {
  edit,
  emptyUserState,
  pin,
  readUserState,
  reset,
  unpin,
  updateUserState,
  type UserState,
} from '../src/state/user-state.js';
import { makeTempDir } from './helpers.js';

async function stateFile(content?: string): Promise<string> {
  const file = path.join(await makeTempDir('state'), 'state.json');
  if (content !== undefined) await writeFile(file, content);
  return file;
}

describe('user state: never lost', () => {
  const unreadable: [string, string][] = [
    ['a corrupt file', '{"schemaVersion": 1, "pinned": ['],
    ['an unknown schemaVersion', '{"schemaVersion": 2, "pinned": ["/x"], "future": true}\n'],
    ['a missing schemaVersion', '{"pinned": ["/x"]}'],
    ['a wrong shape', '{"schemaVersion": 1, "pinned": "/x"}'],
  ];

  for (const [what, content] of unreadable) {
    it(`reads ${what} as empty, with a warning`, async () => {
      const file = await stateFile(content);
      const read = await readUserState(file);
      expect(read.status).toBe('invalid');
      expect(read.state).toEqual(emptyUserState());
      if (read.status === 'invalid') expect(read.warning.code).toBe('state-unreadable');
    });

    it(`refuses to write over ${what} and leaves its bytes untouched`, async () => {
      const file = await stateFile(content);
      const before = await readFile(file);
      let mutated = false;
      const error = await updateUserState(file, () => {
        mutated = true;
        return true;
      }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(SlashDeckError);
      expect((error as SlashDeckError).code).toBe('state-unreadable');
      expect(mutated).toBe(false);
      expect((await readFile(file)).equals(before)).toBe(true);
      expect(await readdir(path.dirname(file))).toEqual(['state.json']);
    });
  }

  it('refuses to write when the state path cannot be read (a folder)', async () => {
    const file = await stateFile();
    await mkdir(file);
    const error = await updateUserState(file, () => true).catch((err: unknown) => err);
    expect((error as SlashDeckError).code).toBe('state-unreadable');
    expect((await readUserState(file)).status).toBe('invalid');
  });

  it('keeps unknown keys when rewriting', async () => {
    const file = await stateFile(
      JSON.stringify({
        schemaVersion: 1,
        pinned: ['/a'],
        edits: { '/a': { description: 'mine', note: 'kept' } },
        workspaces: { ws1: { pinned: ['/p'], edits: {}, extra: 1 } },
        futureField: { x: 1 },
      }),
    );
    await updateUserState(file, (s) => pin(s, 'global', 'ws1', '/b'));
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({
      pinned: ['/a', '/b'],
      edits: { '/a': { description: 'mine', note: 'kept' } },
      workspaces: { ws1: { pinned: ['/p'], extra: 1 } },
      futureField: { x: 1 },
    });
  });

  it('starts over when another writer changes the file before the rename', async () => {
    const file = await stateFile(JSON.stringify({ schemaVersion: 1, pinned: ['/a'] }));
    let calls = 0;
    const changed = await updateUserState(file, (s) => {
      calls++;
      if (calls === 1) {
        // Another IDE window pins /other while this write is in progress.
        return (
          writeFileSyncJson(file, { schemaVersion: 1, pinned: ['/a', '/other'] }) &&
          pin(s, 'global', 'ws', '/b')
        );
      }
      return pin(s, 'global', 'ws', '/b');
    });
    expect(changed).toBe(true);
    expect(calls).toBe(2);
    const saved = JSON.parse(await readFile(file, 'utf8')) as UserState;
    expect(saved.pinned).toEqual(['/a', '/other', '/b']);
  });

  it('does not write when nothing changes', async () => {
    const file = await stateFile();
    expect(await updateUserState(file, () => false)).toBe(false);
    await expect(readFile(file)).rejects.toThrow();
  });
});

function writeFileSyncJson(file: string, value: unknown): true {
  // Synchronous on purpose: the change must land before the mutation returns.
  writeFileSync(file, JSON.stringify(value));
  return true;
}

describe('writeFileAtomic', () => {
  it('writes nothing when the file changed since the given content', async () => {
    const file = await stateFile('one');
    expect(await writeFileAtomic(file, 'two', { unchangedSince: 'zero' })).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('one');
    expect(await writeFileAtomic(file, 'two', { unchangedSince: 'one' })).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('two');
    expect(await readdir(path.dirname(file))).toEqual(['state.json']);
  });
});

describe('user state mutations', () => {
  it('pins in the global scope or under the workspace', () => {
    const s = emptyUserState();
    expect(pin(s, 'global', 'ws1', '/compact')).toBe(true);
    expect(pin(s, 'global', 'ws1', '/compact')).toBe(false);
    expect(pin(s, 'workspace', 'ws1', '/deploy')).toBe(true);
    expect(s.pinned).toEqual(['/compact']);
    expect(s.workspaces).toEqual({ ws1: { pinned: ['/deploy'], edits: {} } });
    expect(unpin(s, 'workspace', 'ws1', '/deploy')).toBe(true);
    // An empty workspace entry is dropped.
    expect(s.workspaces).toEqual({});
    expect(unpin(s, 'workspace', 'ws1', '/deploy')).toBe(false);
  });

  it('finds and removes hand-written names without the leading slash', () => {
    const s: UserState = {
      ...emptyUserState(),
      pinned: ['compact'],
      edits: { compact: { description: 'x' } },
    };
    expect(pin(s, 'global', 'ws', '/compact')).toBe(false);
    expect(unpin(s, 'global', 'ws', '/compact')).toBe(true);
    expect(reset(s, 'global', 'ws', '/compact')).toBe(true);
    expect(s).toEqual(emptyUserState());
  });

  it('edits field by field; null removes only the user value', () => {
    const s = emptyUserState();
    expect(edit(s, 'global', 'ws', '/a', { description: 'D', guide: { whenToUse: 'W' } })).toBe(
      true,
    );
    expect(edit(s, 'global', 'ws', '/a', { guide: { example: '/a x' } })).toBe(true);
    expect(s.edits['/a']).toEqual({ description: 'D', guide: { whenToUse: 'W', example: '/a x' } });
    expect(edit(s, 'global', 'ws', '/a', { guide: { example: '/a x' } })).toBe(false);
    expect(edit(s, 'global', 'ws', '/a', { description: null, guide: { whenToUse: null } })).toBe(
      true,
    );
    expect(s.edits['/a']).toEqual({ guide: { example: '/a x' } });
    expect(edit(s, 'global', 'ws', '/a', { guide: null })).toBe(true);
    // Nothing left: the entry goes away.
    expect(s.edits).toEqual({});
    expect(edit(s, 'global', 'ws', '/a', {})).toBe(false);
  });

  it('keeps workspace edits apart and reset leaves pins alone', () => {
    const s = emptyUserState();
    pin(s, 'workspace', 'ws1', '/deploy');
    edit(s, 'workspace', 'ws1', '/deploy', { category: 'release' });
    expect(s.edits).toEqual({});
    expect(s.workspaces['ws1']).toEqual({
      pinned: ['/deploy'],
      edits: { '/deploy': { category: 'release' } },
    });
    expect(reset(s, 'workspace', 'ws1', '/deploy')).toBe(true);
    expect(s.workspaces['ws1']).toEqual({ pinned: ['/deploy'], edits: {} });
    expect(reset(s, 'workspace', 'ws1', '/deploy')).toBe(false);
  });

  it('mergeEdit keeps unknown keys of the stored entry', () => {
    const merged = mergeEdit({ description: 'a', note: 1 } as never, { category: 'c' });
    expect(merged).toEqual({ description: 'a', note: 1, category: 'c' });
  });
});

describe('team override', () => {
  async function workspaceWith(content?: string): Promise<string> {
    const ws = await makeTempDir('ws');
    if (content !== undefined) {
      await mkdir(path.join(ws, '.claude'), { recursive: true });
      await writeFile(path.join(ws, '.claude', 'slashdeck.json'), content);
    }
    return ws;
  }

  it('is empty and silent when the file does not exist', async () => {
    expect(await readTeamOverride(await workspaceWith())).toEqual({ commands: {}, warnings: [] });
  });

  it('reads valid entries and normalizes the names', async () => {
    const ws = await workspaceWith(
      '﻿' +
        JSON.stringify({
          schemaVersion: 1,
          commands: {
            deploy: { category: 'project', guide: { whenToUse: 'Before every release.' } },
            '/compact': { description: 'Team text', guide: { related: ['/context'] } },
          },
        }),
    );
    const team = await readTeamOverride(ws);
    expect(team.warnings).toEqual([]);
    expect(team.commands).toEqual({
      '/deploy': { category: 'project', guide: { whenToUse: 'Before every release.' } },
      '/compact': { description: 'Team text', guide: { related: ['/context'] } },
    });
  });

  it('ignores a malformed file with a warning', async () => {
    for (const content of [
      '{ nope',
      JSON.stringify({ schemaVersion: 2, commands: {} }),
      JSON.stringify({ commands: {} }),
      JSON.stringify([]),
    ]) {
      const team = await readTeamOverride(await workspaceWith(content));
      expect(team.commands).toEqual({});
      expect(team.warnings).toHaveLength(1);
      expect(team.warnings[0]!.code).toBe('team-override-invalid');
    }
  });

  it('ignores only the malformed entries', async () => {
    const ws = await workspaceWith(
      JSON.stringify({
        schemaVersion: 1,
        commands: {
          '/good': { description: 'ok' },
          '/typo': { guide: { whenToUSe: 'x' } },
          '/blank': { description: '  ' },
          '/': { description: 'no name' },
        },
      }),
    );
    const team = await readTeamOverride(ws);
    expect(team.commands).toEqual({ '/good': { description: 'ok' } });
    expect(team.warnings.map((w) => w.message.match(/entry "([^"]*)"/)?.[1])).toEqual([
      '/typo',
      '/blank',
      '/',
    ]);
    expect(team.warnings[0]!.message).toContain('guide: Unrecognized key: "whenToUSe"');
    // Warnings end up in the Markdown catalog, which is ASCII-only.
    // eslint-disable-next-line no-control-regex
    expect(team.warnings.every((w) => /^[\x00-\x7f]*$/.test(w.message))).toBe(true);
  });
});
