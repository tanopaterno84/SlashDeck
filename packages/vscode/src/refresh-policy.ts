/**
 * Which file changes may call for a scan, and whether the definitions really changed.
 * No `vscode` import.
 *
 * Starting Claude Code (as every scan does) rewrites bookkeeping files in the user folder
 * (`plugins/synced/<id>/manifest.json`, `.last-complete-round`, `.in_use/`, `skills/.staging`
 * and more). Reacting to them made each scan trigger the next one, in every open window. Two
 * independent filters stop that:
 *
 * 1. `isDefinitionChange` drops, at the source, events on anything that is not a command,
 *    skill or plugin definition: dot-files and dot-folders, `manifest.json`, `*.meta.json`,
 *    skill resources, a folder whose content changed (the content is reported on its own).
 * 2. `definitionFingerprint` sums up what defines the commands (paths and content hashes of
 *    command files, SKILL.md and plugin manifests, as read by the core's `scanFiles`, which
 *    starts no process). A scan runs only when it differs from the one taken when the last
 *    scan started, whatever file names Claude Code writes tomorrow.
 *
 * The scheduler (scheduler.ts) adds a safety net that does not depend on either.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FileScanResult } from '@slashdeck/core';

export type ChangeType = 'create' | 'change' | 'delete';

/**
 * What a watched folder holds, relative to the watcher's base folder:
 * - `project`: the workspace folder (`.claude/commands/**`, `.claude/skills/**`);
 * - `commands`: a commands folder (`*.md`, nested);
 * - `skills`: a skills folder (`<name>/SKILL.md`, `synced/<id>/<name>/SKILL.md`);
 * - `roots`: the user folder, for `commands` and `skills` appearing or going away;
 * - `plugins`: `plugins/` (`installed_plugins.json`, `synced/<id>/<plugin>/...`);
 * - `file`: one file watched by name (team override, user state): always relevant.
 */
export type WatchArea = 'project' | 'commands' | 'skills' | 'roots' | 'plugins' | 'file';

/** Path segments of `file` below `base`; null when it is not below it. */
export function relativeSegments(base: string, file: string): string[] | null {
  const rel = path.relative(base, file);
  if (rel === '') return [];
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return null;
  return rel.split(/[\\/]+/).filter((s) => s !== '');
}

const isDot = (segment: string) => segment.startsWith('.');
/** A name without an extension: most likely a folder (`my-skill`, `group-a`). */
const looksLikeFolder = (segment: string) => !segment.includes('.');
/**
 * A folder appearing or going away may add or remove definitions. A folder "changed" only
 * means that something inside it changed, which is reported on its own.
 */
const folderEvent = (type: ChangeType) => type !== 'change';

function inCommands(segments: string[], type: ChangeType): boolean {
  if (segments.length === 0) return folderEvent(type);
  if (segments.some(isDot)) return false;
  const last = segments.at(-1)!.toLowerCase();
  if (last.endsWith('.md')) return true;
  return looksLikeFolder(last) && folderEvent(type);
}

function inSkills(segments: string[], type: ChangeType): boolean {
  if (segments.length === 0) return folderEvent(type);
  if (segments.some(isDot)) return false;
  const last = segments.at(-1)!.toLowerCase();
  if (last === 'skill.md') return true;
  return looksLikeFolder(last) && folderEvent(type);
}

/** `synced/<id>/<plugin>/...`: plugin manifest, skills and commands. */
function inSyncedPlugins(segments: string[], type: ChangeType): boolean {
  if (segments.length === 0) return folderEvent(type);
  // `.claude-plugin` holds the manifest: the only dot-folder that matters.
  if (segments.some((s) => isDot(s) && s.toLowerCase() !== '.claude-plugin')) return false;
  const lower = segments.map((s) => s.toLowerCase());
  const last = lower.at(-1)!;
  const parent = lower.at(-2);
  if (last === '.claude-plugin') return folderEvent(type);
  if (last === 'plugin.json') return parent === '.claude-plugin';
  if (last === 'skill.md') return true;
  if (last.endsWith('.md')) return lower.includes('commands');
  return looksLikeFolder(last) && folderEvent(type);
}

/** Whether a change of `segments` (below the watcher's base) may change the commands. */
export function isDefinitionChange(
  area: WatchArea,
  segments: readonly string[] | null,
  type: ChangeType,
): boolean {
  // Outside the base (should not happen): let the fingerprint decide.
  if (segments === null) return true;
  const segs = [...segments];
  switch (area) {
    case 'file':
      return true;
    case 'commands':
      return inCommands(segs, type);
    case 'skills':
      return inSkills(segs, type);
    case 'roots':
      return (
        segs.length === 1 &&
        ['commands', 'skills'].includes(segs[0]!.toLowerCase()) &&
        folderEvent(type)
      );
    case 'project': {
      if (segs.length === 0 || segs[0]!.toLowerCase() !== '.claude') return false;
      if (segs.length === 1) return folderEvent(type);
      const kind = segs[1]!.toLowerCase();
      if (kind === 'commands') return inCommands(segs.slice(2), type);
      if (kind === 'skills') return inSkills(segs.slice(2), type);
      return false;
    }
    case 'plugins': {
      const first = segs[0]?.toLowerCase();
      if (first === 'installed_plugins.json') return segs.length === 1;
      if (first === 'synced') return inSyncedPlugins(segs.slice(1), type);
      return false;
    }
  }
}

/**
 * A digest of what defines the commands: kind, name, path and content hash of every command,
 * skill and plugin file found by `scanFiles`, and the installed plugins. Bookkeeping files
 * are not part of it, so rewriting them never changes it.
 */
export function definitionFingerprint(result: Pick<FileScanResult, 'items' | 'plugins'>): string {
  const lines = result.items
    .map((i) =>
      ['item', i.kind, i.name, i.sourcePath, i.hash, i.userInvocable ? 'user' : 'model'].join('\t'),
    )
    .concat(result.plugins.map((p) => `plugin\t${p}`))
    .sort();
  return 'sha256:' + createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}
