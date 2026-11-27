/**
 * User state (CLAUDE.md, "Stato utente"): pinned commands and the user's own edits, global
 * or per workspace. Written only on an explicit user action.
 *
 * The user state is never lost:
 * - an unreadable file, or one with an unknown `schemaVersion`, reads as empty (with a
 *   warning) and is never overwritten: every write refuses with `state-unreadable`;
 * - unknown keys are kept when the file is rewritten;
 * - writes are atomic, and each one re-reads the file and checks right before the rename
 *   that nobody changed it meanwhile (otherwise it starts over), so two IDE windows writing
 *   at nearly the same time do not lose each other's change. There is no lock: a write
 *   landing between that check and the rename (a few microseconds) can still be lost.
 */
import { z } from 'zod';
import { SlashDeckError } from '../errors.js';
import { readTextIfExists, writeFileAtomic } from '../fs-util.js';
import type { CommandEdit, CommandKind, ScanWarning } from '../types.js';
import { errorMessage, issuesMessage, stripBom, stripLeadingSlash } from '../util.js';
import { mergeEdit, storedEditSchema, type CommandEditInput } from './edit.js';

export const STATE_SCHEMA_VERSION = 1;

const scopeSchema = z.looseObject({
  pinned: z.array(z.string()).default([]),
  edits: z.record(z.string(), storedEditSchema).default({}),
});

export const userStateSchema = z.looseObject({
  schemaVersion: z.literal(STATE_SCHEMA_VERSION),
  pinned: z.array(z.string()).default([]),
  edits: z.record(z.string(), storedEditSchema).default({}),
  workspaces: z.record(z.string(), scopeSchema).default({}),
});

export interface ScopeState {
  pinned: string[];
  edits: Record<string, CommandEdit>;
}

export interface UserState extends ScopeState {
  schemaVersion: 1;
  /** Pins and edits of the commands defined in a workspace, by workspace ID. */
  workspaces: Record<string, ScopeState>;
}

/** `global` = top level of the state; `workspace` = `workspaces.<workspaceId>`. */
export type StateScope = 'global' | 'workspace';

/** Commands defined in the workspace keep their state under the workspace. */
export function scopeForKind(kind: CommandKind): StateScope {
  return kind === 'custom-project' || kind === 'skill-project' ? 'workspace' : 'global';
}

export function emptyUserState(): UserState {
  return { schemaVersion: STATE_SCHEMA_VERSION, pinned: [], edits: {}, workspaces: {} };
}

export type StateRead =
  | { status: 'ok' | 'missing'; state: UserState }
  | { status: 'invalid'; state: UserState; warning: ScanWarning };

type Parsed = { ok: true; state: UserState } | { ok: false; reason: string };

function parseState(text: string): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(stripBom(text));
  } catch (err) {
    return { ok: false, reason: `not valid JSON (${errorMessage(err)})` };
  }
  const version = (json as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== STATE_SCHEMA_VERSION) {
    return { ok: false, reason: `unknown schemaVersion ${JSON.stringify(version)}` };
  }
  const parsed = userStateSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: issuesMessage(parsed.error.issues) };
  }
  return { ok: true, state: parsed.data as UserState };
}

function unreadable(file: string, reason: string): string {
  return `user state ${file} is unreadable (${reason}); it is left untouched`;
}

/** Reads the user state; an unreadable file reads as empty, with a warning. */
export async function readUserState(file: string): Promise<StateRead> {
  let text: string | null;
  try {
    text = await readTextIfExists(file);
  } catch (err) {
    return invalid(file, errorMessage(err));
  }
  if (text === null) return { status: 'missing', state: emptyUserState() };
  const parsed = parseState(text);
  return parsed.ok ? { status: 'ok', state: parsed.state } : invalid(file, parsed.reason);
}

function invalid(file: string, reason: string): StateRead {
  return {
    status: 'invalid',
    state: emptyUserState(),
    warning: { code: 'state-unreadable', message: unreadable(file, reason) },
  };
}

const MAX_WRITE_ATTEMPTS = 5;

/**
 * Read-modify-write of the user state. `mutate` changes the state in place and returns
 * whether it changed anything; nothing is written when it did not. Throws
 * `state-unreadable` (file untouched) when the existing file cannot be read.
 */
export async function updateUserState(
  file: string,
  mutate: (state: UserState) => boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    let text: string | null;
    try {
      text = await readTextIfExists(file);
    } catch (err) {
      throw new SlashDeckError('state-unreadable', unreadable(file, errorMessage(err)));
    }
    let state: UserState;
    if (text === null) state = emptyUserState();
    else {
      const parsed = parseState(text);
      if (!parsed.ok) throw new SlashDeckError('state-unreadable', unreadable(file, parsed.reason));
      state = parsed.state;
    }
    if (!mutate(state)) return false;
    const data = JSON.stringify(state, null, 2) + '\n';
    if (await writeFileAtomic(file, data, { unchangedSince: text })) return true;
  }
  throw new SlashDeckError(
    'state-busy',
    `user state ${file} kept changing while being written; try again`,
  );
}

// ---------------------------------------------------------------------------------------
// Mutations. Command names are stored with the leading "/"; entries written by hand without
// it are found and removed too.

function scopeOf(
  state: UserState,
  scope: StateScope,
  workspaceId: string,
  create: boolean,
): ScopeState | undefined {
  if (scope === 'global') return state;
  const existing = state.workspaces[workspaceId];
  if (existing || !create) return existing;
  const created: ScopeState = { pinned: [], edits: {} };
  state.workspaces[workspaceId] = created;
  return created;
}

function variants(name: string): string[] {
  return [name, stripLeadingSlash(name)];
}

/** Drops a workspace entry left with nothing in it. */
function dropEmptyWorkspace(state: UserState, workspaceId: string): void {
  const ws = state.workspaces[workspaceId];
  if (!ws) return;
  const keys = Object.keys(ws).filter((k) => k !== 'pinned' && k !== 'edits');
  if (ws.pinned.length === 0 && Object.keys(ws.edits).length === 0 && keys.length === 0) {
    delete state.workspaces[workspaceId];
  }
}

export function isPinnedIn(scope: ScopeState | undefined, name: string): boolean {
  return scope !== undefined && variants(name).some((n) => scope.pinned.includes(n));
}

export function editIn(scope: ScopeState | undefined, name: string): CommandEdit | undefined {
  if (!scope) return undefined;
  return scope.edits[name] ?? scope.edits[stripLeadingSlash(name)];
}

export function pin(state: UserState, scope: StateScope, workspaceId: string, name: string) {
  if (isPinnedIn(scopeOf(state, scope, workspaceId, false), name)) return false;
  scopeOf(state, scope, workspaceId, true)!.pinned.push(name);
  return true;
}

export function unpin(state: UserState, scope: StateScope, workspaceId: string, name: string) {
  const target = scopeOf(state, scope, workspaceId, false);
  if (!target) return false;
  const names = variants(name);
  const kept = target.pinned.filter((n) => !names.includes(n));
  if (kept.length === target.pinned.length) return false;
  target.pinned = kept;
  if (scope === 'workspace') dropEmptyWorkspace(state, workspaceId);
  return true;
}

export function edit(
  state: UserState,
  scope: StateScope,
  workspaceId: string,
  name: string,
  input: CommandEditInput,
): boolean {
  const target = scopeOf(state, scope, workspaceId, false);
  // Keep editing a hand-written entry stored without the leading "/", if that is the one.
  const bare = stripLeadingSlash(name);
  const key = target?.edits[name] === undefined && target?.edits[bare] ? bare : name;
  const before = target?.edits[key];
  const after = mergeEdit(before, input);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  const writable = scopeOf(state, scope, workspaceId, true)!;
  if (after === undefined) delete writable.edits[key];
  else writable.edits[key] = after;
  if (scope === 'workspace') dropEmptyWorkspace(state, workspaceId);
  return true;
}

export function reset(state: UserState, scope: StateScope, workspaceId: string, name: string) {
  const target = scopeOf(state, scope, workspaceId, false);
  if (!target) return false;
  let changed = false;
  for (const n of variants(name)) {
    if (target.edits[n] !== undefined) {
      delete target.edits[n];
      changed = true;
    }
  }
  if (changed && scope === 'workspace') dropEmptyWorkspace(state, workspaceId);
  return changed;
}
