/**
 * Merges the CLI list and the file scan into catalog entries, applying categories, hidden
 * entries and extra entries from data/builtin-commands.json.
 */
import type { BuiltinData } from '../data.js';
import type { CatalogEntry, CatalogSource, CommandKind, ScanWarning } from '../types.js';
import { hashFields, stripLeadingSlash } from '../util.js';
import type { CliResult } from './cli-source.js';
import type { FileItem, FileScanResult } from './file-source.js';

export interface MergeResult {
  source: CatalogSource;
  claudeCodeVersion: string | null;
  commands: Record<string, CatalogEntry>;
  warnings: ScanWarning[];
}

export function isHidden(name: string, data: BuiltinData): boolean {
  const bare = stripLeadingSlash(name);
  return bare.startsWith('__') || data.hidden.some((h) => stripLeadingSlash(h) === bare);
}

/** Category ID derived from the kind (origin `derived`). */
export function categoryForKind(kind: CommandKind, plugin?: string): string {
  switch (kind) {
    case 'custom-project':
    case 'skill-project':
      return 'project';
    case 'custom-user':
    case 'skill-user':
      return 'personal';
    case 'skill-synced':
      return 'synced';
    case 'plugin':
      return plugin === undefined ? 'other' : `plugin:${plugin}`;
    default:
      return 'other';
  }
}

/**
 * Attributes a CLI name to a scanned file:
 * - `<plugin>:<name>` with an installed plugin prefix → that plugin's command or skill;
 * - otherwise an exact name match on non-plugin items;
 * - otherwise, for a prefixed name, a match on the part after the last ":".
 * Names are never constructed: only the CLI name is matched.
 */
export function matchFileItem(name: string, files: FileScanResult): FileItem | undefined {
  const colon = name.indexOf(':');
  if (colon > 0 && files.plugins.includes(name.slice(0, colon))) {
    return files.items.find((i) => i.kind === 'plugin' && i.matchNames.includes(name));
  }
  const local = files.items.filter((i) => i.kind !== 'plugin');
  const exact = local.find((i) => i.matchNames.includes(name));
  if (exact || colon <= 0) return exact;
  const last = name.slice(name.lastIndexOf(':') + 1);
  return local.find((i) => i.matchNames.includes(last));
}

function builtinCategory(
  name: string,
  data: BuiltinData,
  explicit?: string,
): Pick<CatalogEntry, 'category' | 'origins'> {
  const curated = explicit ?? data.categories[name];
  return curated !== undefined
    ? { category: curated, origins: { category: 'curated' } }
    : { category: 'other', origins: { category: 'derived' } };
}

/** Sorts by name and fixes the key order of each entry, for a stable JSON output. */
function sortCommands(entries: CatalogEntry[]): Record<string, CatalogEntry> {
  const out: Record<string, CatalogEntry> = {};
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    out[e.name] = {
      name: e.name,
      kind: e.kind,
      ...(e.plugin !== undefined && { plugin: e.plugin }),
      sourcePath: e.sourcePath,
      hash: e.hash,
      category: e.category,
      ...(e.description !== undefined && { description: e.description }),
      ...(e.argumentHint !== undefined && { argumentHint: e.argumentHint }),
      origins: {
        ...(e.origins.description !== undefined && { description: e.origins.description }),
        ...(e.origins.argumentHint !== undefined && { argumentHint: e.origins.argumentHint }),
        ...(e.origins.category !== undefined && { category: e.origins.category }),
      },
    };
  }
  return out;
}

function fromCli(cli: CliResult, files: FileScanResult, data: BuiltinData): MergeResult {
  const entries = new Map<string, CatalogEntry>();

  for (const command of cli.commands) {
    const bare = stripLeadingSlash(command.name);
    const key = `/${bare}`;
    if (isHidden(bare, data) || entries.has(key)) continue;

    let entry: CatalogEntry;
    if (command.builtin) {
      const { category, origins } = builtinCategory(bare, data);
      entry = {
        name: key,
        kind: 'builtin',
        sourcePath: null,
        hash: hashFields(key, command.description, command.argumentHint),
        category,
        origins,
      };
    } else {
      const item = matchFileItem(bare, files);
      entry = item
        ? {
            name: key,
            kind: item.kind,
            ...(item.plugin !== undefined && { plugin: item.plugin }),
            sourcePath: item.sourcePath,
            hash: item.hash,
            category: categoryForKind(item.kind, item.plugin),
            origins: { category: 'derived' },
          }
        : {
            name: key,
            kind: 'unknown',
            sourcePath: null,
            hash: hashFields(key, command.description, command.argumentHint),
            category: 'other',
            origins: { category: 'derived' },
          };
    }
    if (command.description !== undefined) {
      entry.description = command.description;
      entry.origins.description = 'cli';
    }
    if (command.argumentHint !== undefined) {
      entry.argumentHint = command.argumentHint;
      entry.origins.argumentHint = 'cli';
    }
    entries.set(key, entry);
  }

  // Interactive-only builtins, added by hand after verification; the CLI wins when it has them.
  for (const extra of data.extra) {
    const bare = stripLeadingSlash(extra.name);
    const key = `/${bare}`;
    if (isHidden(bare, data) || entries.has(key)) continue;
    const { category, origins } = builtinCategory(bare, data, extra.category);
    const entry: CatalogEntry = {
      name: key,
      kind: 'builtin',
      sourcePath: null,
      hash: hashFields(key, extra.description, extra.argumentHint),
      category,
      description: extra.description,
      origins: { ...origins, description: 'curated' },
    };
    if (extra.argumentHint !== undefined) {
      entry.argumentHint = extra.argumentHint;
      entry.origins.argumentHint = 'curated';
    }
    entries.set(key, entry);
  }

  return {
    source: 'cli',
    claudeCodeVersion: cli.claudeCodeVersion,
    commands: sortCommands([...entries.values()]),
    warnings: [],
  };
}

function fromFiles(files: FileScanResult, data: BuiltinData): MergeResult {
  const entries = new Map<string, CatalogEntry>();
  const warnings: ScanWarning[] = [];

  for (const item of files.items) {
    if (!item.userInvocable || isHidden(item.name, data)) continue;
    const key = `/${item.name}`;
    const existing = entries.get(key);
    if (existing) {
      warnings.push({
        code: 'duplicate-name',
        message: `${key} is defined more than once; kept ${existing.sourcePath}, ignored ${item.sourcePath}`,
      });
      continue;
    }
    const entry: CatalogEntry = {
      name: key,
      kind: item.kind,
      ...(item.plugin !== undefined && { plugin: item.plugin }),
      sourcePath: item.sourcePath,
      hash: item.hash,
      category: categoryForKind(item.kind, item.plugin),
      origins: { category: 'derived' },
    };
    if (item.description !== undefined) {
      entry.description = item.description;
      entry.origins.description = 'local-metadata';
    }
    if (item.argumentHint !== undefined) {
      entry.argumentHint = item.argumentHint;
      entry.origins.argumentHint = 'local-metadata';
    }
    entries.set(key, entry);
  }

  return {
    source: 'files',
    claudeCodeVersion: null,
    commands: sortCommands([...entries.values()]),
    warnings,
  };
}

/** `cli` null means the CLI did not answer: the catalog is built from files only. */
export function mergeCatalog(input: {
  cli: CliResult | null;
  files: FileScanResult;
  data: BuiltinData;
}): MergeResult {
  return input.cli
    ? fromCli(input.cli, input.files, input.data)
    : fromFiles(input.files, input.data);
}
