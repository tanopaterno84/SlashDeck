/**
 * Library API used by the IDE front-ends and by the CLI: scan and cache, the cached
 * resolved view, pins, edits and cache clearing. Folders are injectable (`cacheDir`,
 * `configDir`, `homeDir`, `env`), so that tests never touch the real user folders.
 *
 * Expected failures throw a SlashDeckError with a stable `code`.
 */
import path from 'node:path';
import { nextCache, readCache, removeCacheDir, writeCache, type CacheFile } from './cache/cache.js';
import { SlashDeckError } from './errors.js';
import { cacheFilePath, resolveDirs, stateFilePath, workspaceId } from './paths.js';
import { scan, type ScanOptions } from './scan.js';
import { editInputSchema, type CommandEditInput } from './state/edit.js';
import { resolveEntry, resolveView } from './state/resolve.js';
import { readTeamOverride } from './state/team.js';
import * as userState from './state/user-state.js';
import type { CatalogEntry, ResolvedEntry, ResolvedView, ScanWarning } from './types.js';
import { errorMessage, issuesMessage, stripLeadingSlash, toPosixPath } from './util.js';

export interface StoreOptions {
  workspace: string;
  /** Cache folder; default SLASHDECK_CACHE_DIR or the platform folder (see paths.ts). */
  cacheDir?: string;
  /** User state folder; default SLASHDECK_CONFIG_DIR or the platform folder. */
  configDir?: string;
  /** Environment used to find the default folders; default process.env. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => Date;
}

export type ScanAndCacheOptions = ScanOptions & StoreOptions;

/** Result of every write: pin, unpin, edit, reset, cache clear. */
export interface WriteResult {
  action: 'pin' | 'unpin' | 'edit' | 'reset' | 'cache-clear';
  /** Normalized command name ("/name"); null for cache clear. */
  command: string | null;
  /** Workspace whose state or cache was used; null for `cache clear --all`. */
  workspaceId: string | null;
  /** False when the call changed nothing (already pinned, nothing to reset...). */
  changed: boolean;
  /**
   * Where the change was made: the state scope of the command (`global` or `workspace`),
   * `both` when unpin/reset cannot tell (command not in the cached catalog), `workspace` or
   * `all` for cache clear.
   */
  scope: 'global' | 'workspace' | 'both' | 'all';
  /** The command in the resolved view after the change; null if not in the cached catalog. */
  entry: ResolvedEntry | null;
}

interface Context {
  workspace: string;
  workspaceId: string;
  cacheDir: string;
  cacheFile: string;
  stateFile: string;
  now: Date;
}

function context(options: StoreOptions): Context {
  const workspace = path.resolve(options.workspace);
  const dirs = resolveDirs({
    ...(options.cacheDir !== undefined && { cacheDir: options.cacheDir }),
    ...(options.configDir !== undefined && { configDir: options.configDir }),
    ...(options.env !== undefined && { env: options.env }),
    ...(options.homeDir !== undefined && { homeDir: options.homeDir }),
  });
  const id = workspaceId(workspace);
  return {
    workspace,
    workspaceId: id,
    cacheDir: dirs.cacheDir,
    cacheFile: cacheFilePath(dirs.cacheDir, id),
    stateFile: stateFilePath(dirs.configDir),
    now: options.now?.() ?? new Date(),
  };
}

/** Accepts a name with or without the leading "/" and returns it with the "/". */
export function normalizeCommandName(name: string): string {
  const bare = stripLeadingSlash(name.trim());
  if (bare === '') {
    throw new SlashDeckError('invalid-command-name', `invalid command name "${name}"`);
  }
  return `/${bare}`;
}

async function overlays(ctx: Context) {
  const state = await userState.readUserState(ctx.stateFile);
  const team = await readTeamOverride(ctx.workspace);
  const warnings: ScanWarning[] = [
    ...(state.status === 'invalid' ? [state.warning] : []),
    ...team.warnings,
  ];
  return { state: state.state, team: team.commands, warnings };
}

async function resolveCache(
  ctx: Context,
  cache: CacheFile,
  warnings: ScanWarning[] = [],
): Promise<ResolvedView> {
  const o = await overlays(ctx);
  return resolveView({
    cache,
    workspaceId: ctx.workspaceId,
    state: o.state,
    team: o.team,
    warnings: [...warnings, ...o.warnings],
    now: ctx.now,
  });
}

async function cachedCatalog(ctx: Context): Promise<CacheFile | null> {
  const read = await readCache(ctx.cacheFile);
  return read.status === 'ok' ? read.cache : null;
}

/**
 * Scans the workspace (Claude Code CLI + files), updates its cache and returns the resolved
 * view. A cache that cannot be written only adds a `cache-write-failed` warning.
 */
export async function scanAndCache(options: ScanAndCacheOptions): Promise<ResolvedView> {
  const catalog = await scan(options);
  const ctx = context(options);
  const warnings: ScanWarning[] = [];
  const previous = await readCache(ctx.cacheFile);
  if (previous.status === 'invalid') {
    warnings.push({
      code: 'cache-invalid',
      message: `cache ${toPosixPath(ctx.cacheFile)} ignored and rebuilt: ${previous.message}`,
    });
  }
  const cache = nextCache(previous.status === 'ok' ? previous.cache : null, catalog);
  try {
    await writeCache(ctx.cacheFile, cache);
  } catch (err) {
    warnings.push({
      code: 'cache-write-failed',
      message: `cache ${toPosixPath(ctx.cacheFile)} not written: ${errorMessage(err)}`,
    });
  }
  return resolveCache(ctx, cache, warnings);
}

/**
 * The resolved view of the last cached scan, without calling Claude Code. Null when the
 * workspace has no cache yet, or when its cache is unreadable (the next scan rewrites it).
 */
export async function loadCachedView(options: StoreOptions): Promise<ResolvedView | null> {
  const ctx = context(options);
  const cache = await cachedCatalog(ctx);
  return cache ? resolveCache(ctx, cache) : null;
}

/** Cached catalog entry of a command, for pin and edit; throws when there is none. */
async function requireEntry(
  ctx: Context,
  name: string,
): Promise<{ cache: CacheFile; entry: CatalogEntry }> {
  const cache = await cachedCatalog(ctx);
  if (!cache) {
    throw new SlashDeckError(
      'no-cache',
      `no cached catalog for ${toPosixPath(ctx.workspace)}: run a scan first`,
    );
  }
  const entry = cache.catalog.commands[name];
  if (!entry) {
    throw new SlashDeckError('not-in-catalog', `${name} is not in the cached catalog`);
  }
  return { cache, entry };
}

async function entryAfter(ctx: Context, cache: CacheFile | null, name: string) {
  const entry = cache?.catalog.commands[name];
  if (!cache || !entry) return null;
  const o = await overlays(ctx);
  return resolveEntry(entry, {
    cache,
    workspaceId: ctx.workspaceId,
    state: o.state,
    team: o.team,
    now: ctx.now,
  });
}

type Mutation = (
  state: userState.UserState,
  scope: userState.StateScope,
  workspaceId: string,
  name: string,
) => boolean;

/** pin and edit: only for commands in the cached catalog, in the command's own scope. */
async function changeKnown(
  options: StoreOptions,
  action: 'pin' | 'edit',
  command: string,
  mutate: Mutation,
): Promise<WriteResult> {
  const ctx = context(options);
  const name = normalizeCommandName(command);
  const { cache, entry } = await requireEntry(ctx, name);
  const scope = userState.scopeForKind(entry.kind);
  const changed = await userState.updateUserState(ctx.stateFile, (s) =>
    mutate(s, scope, ctx.workspaceId, name),
  );
  return {
    action,
    command: name,
    workspaceId: ctx.workspaceId,
    changed,
    scope,
    entry: await entryAfter(ctx, cache, name),
  };
}

/**
 * unpin and reset: they also work without a cache or for a command no longer in the
 * catalog, so that stale entries can be cleaned up; then both the global scope and this
 * workspace's scope are cleaned.
 */
async function changeAny(
  options: StoreOptions,
  action: 'unpin' | 'reset',
  command: string,
  mutate: Mutation,
): Promise<WriteResult> {
  const ctx = context(options);
  const name = normalizeCommandName(command);
  const cache = await cachedCatalog(ctx);
  const entry = cache?.catalog.commands[name];
  const scopes: userState.StateScope[] = entry
    ? [userState.scopeForKind(entry.kind)]
    : ['global', 'workspace'];
  const changed = await userState.updateUserState(ctx.stateFile, (s) =>
    scopes.map((scope) => mutate(s, scope, ctx.workspaceId, name)).some(Boolean),
  );
  return {
    action,
    command: name,
    workspaceId: ctx.workspaceId,
    changed,
    scope: scopes.length === 1 ? scopes[0]! : 'both',
    entry: await entryAfter(ctx, cache, name),
  };
}

/** Pins a command of the cached catalog. Throws `no-cache` or `not-in-catalog`. */
export function pinCommand(options: StoreOptions, command: string): Promise<WriteResult> {
  return changeKnown(options, 'pin', command, userState.pin);
}

/** Unpins a command, also one that is no longer in the catalog. */
export function unpinCommand(options: StoreOptions, command: string): Promise<WriteResult> {
  return changeAny(options, 'unpin', command, userState.unpin);
}

/**
 * Applies an edit to a command of the cached catalog: a value sets a field, `null` removes
 * the user's own value, an absent field stays as it is. Throws `invalid-edit`, `no-cache`
 * or `not-in-catalog`.
 */
export async function editCommand(
  options: StoreOptions,
  command: string,
  edit: CommandEditInput,
): Promise<WriteResult> {
  const parsed = editInputSchema.safeParse(edit);
  if (!parsed.success) {
    throw new SlashDeckError('invalid-edit', `invalid edit: ${issuesMessage(parsed.error.issues)}`);
  }
  return changeKnown(options, 'edit', command, (s, scope, id, name) =>
    userState.edit(s, scope, id, name, parsed.data),
  );
}

/** Removes all the user's edits of a command (pins are left alone). */
export function resetCommand(options: StoreOptions, command: string): Promise<WriteResult> {
  return changeAny(options, 'reset', command, userState.reset);
}

/**
 * Deletes the cache of the workspace, or with `all` the cache of every workspace. The user
 * state and the team override are never touched.
 */
export async function clearCache(options: StoreOptions & { all?: boolean }): Promise<WriteResult> {
  const ctx = context(options);
  const workspaces = path.join(ctx.cacheDir, 'workspaces');
  const changed = await removeCacheDir(options.all ? workspaces : path.dirname(ctx.cacheFile));
  return {
    action: 'cache-clear',
    command: null,
    workspaceId: options.all ? null : ctx.workspaceId,
    changed,
    scope: options.all ? 'all' : 'workspace',
    entry: null,
  };
}
