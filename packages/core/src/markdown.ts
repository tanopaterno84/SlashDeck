/**
 * Renders a catalog as compact Markdown, for the help skill: the text ends up in a model's
 * context, so descriptions are cut and only what the skill needs is printed.
 *
 * The output uses ASCII punctuation only (descriptions are printed as they are): it may be
 * read back through a console that does not decode UTF-8.
 */
import type {
  Catalog,
  CatalogEntry,
  Origin,
  ResolvedEntry,
  ResolvedField,
  ResolvedView,
} from './types.js';

/** Descriptions longer than this are cut on a word boundary and end with "...". */
export const MAX_DESCRIPTION_CHARS = 240;

const ELLIPSIS = '...';

/** Known category IDs before the plugin groups, in display order (CLAUDE.md, "Categorie"). */
const LEADING_CATEGORIES = ['project'] as const;
/** Known custom category IDs after the plugin groups. */
const CUSTOM_CATEGORIES = ['personal', 'synced'] as const;
/** Builtin category IDs, in display order; `other` is always last. */
const BUILTIN_CATEGORIES = [
  'session',
  'context',
  'model-permissions',
  'review-git',
  'mcp-plugins',
  'config',
  'other',
] as const;

const LABELS: Record<string, string> = {
  project: 'Project',
  personal: 'Personal',
  synced: 'Synced',
  // Builtin groups say so in the heading, so that a reader can tell them from custom ones.
  session: 'Built-in: Session',
  context: 'Built-in: Context',
  'model-permissions': 'Built-in: Model and permissions',
  'review-git': 'Built-in: Review and Git',
  'mcp-plugins': 'Built-in: MCP and plugins',
  config: 'Built-in: Configuration',
  // Builtins without a category, and non-builtin commands with no source file found.
  other: 'Other',
};

const PLUGIN_PREFIX = 'plugin:';

/** English label of a category ID; unknown IDs are shown as they are. */
export function categoryLabel(id: string): string {
  if (id.startsWith(PLUGIN_PREFIX)) return `Plugin: ${id.slice(PLUGIN_PREFIX.length)}`;
  return LABELS[id] ?? id;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Display order of the category IDs present in a catalog: `project`, each `plugin:<name>`
 * (alphabetical), `personal`, `synced`, unknown IDs (alphabetical), then the builtin
 * categories with `other` last.
 */
export function orderCategories(ids: Iterable<string>): string[] {
  const present = new Set(ids);
  const known = new Set<string>([
    ...LEADING_CATEGORIES,
    ...CUSTOM_CATEGORIES,
    ...BUILTIN_CATEGORIES,
  ]);
  const plugins = [...present].filter((id) => id.startsWith(PLUGIN_PREFIX)).sort(compare);
  const unknown = [...present]
    .filter((id) => !known.has(id) && !id.startsWith(PLUGIN_PREFIX))
    .sort(compare);
  return [
    ...LEADING_CATEGORIES.filter((id) => present.has(id)),
    ...plugins,
    ...CUSTOM_CATEGORIES.filter((id) => present.has(id)),
    ...unknown,
    ...BUILTIN_CATEGORIES.filter((id) => present.has(id)),
  ];
}

/**
 * Collapses whitespace and cuts the text to at most `max` characters, ellipsis included,
 * on a word boundary when one is close enough.
 */
export function truncateText(text: string, max: number = MAX_DESCRIPTION_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const room = Math.max(0, max - ELLIPSIS.length);
  const cut = flat.slice(0, room + 1);
  const space = cut.lastIndexOf(' ');
  // Prefer a word boundary, unless it would throw away more than a third of the text.
  const end = space >= room * (2 / 3) ? space : room;
  return flat.slice(0, end).replace(/[\s,;:.-]+$/, '') + ELLIPSIS;
}

type Entry = CatalogEntry | ResolvedEntry;

/** Who wrote a text, when it is not the command's own metadata. */
function author(origin: Origin | undefined): string | undefined {
  if (origin === 'team') return 'team';
  if (origin === 'user-edit') return 'user';
  return undefined;
}

function origin(entry: Entry, field: ResolvedField): Origin | undefined {
  return (entry.origins as Partial<Record<ResolvedField, Origin>>)[field];
}

function guideLines(entry: Entry): string[] {
  const guide = 'guide' in entry ? entry.guide : undefined;
  if (!guide) return [];
  const label = (name: string, field: ResolvedField) => {
    const by = author(origin(entry, field));
    return by ? `${name} (${by})` : name;
  };
  const lines: string[] = [];
  if (guide.whenToUse !== undefined)
    lines.push(`  - ${label('when to use', 'guide.whenToUse')}: ${truncateText(guide.whenToUse)}`);
  if (guide.example !== undefined)
    lines.push(`  - ${label('example', 'guide.example')}: ${truncateText(guide.example)}`);
  if (guide.related !== undefined && guide.related.length > 0)
    lines.push(`  - ${label('related', 'guide.related')}: ${guide.related.join(', ')}`);
  return lines;
}

function renderEntry(entry: Entry): string[] {
  const hint = entry.argumentHint?.trim();
  const usage = hint ? `${entry.name} ${hint}` : entry.name;
  const marks =
    ('pinned' in entry && entry.pinned ? ' [pinned]' : '') +
    ('isNew' in entry && entry.isNew ? ' [new]' : '');
  let description =
    entry.description !== undefined && entry.description.trim() !== ''
      ? truncateText(entry.description)
      : '(no description)';
  const by = author(origin(entry, 'description'));
  if (by) description += ` (${by})`;
  const lines = [`- \`${usage}\`${marks} - ${description}`, ...guideLines(entry)];
  if (entry.sourcePath !== null) lines.push(`  - file: ${entry.sourcePath}`);
  else if (entry.kind === 'unknown') lines.push('  - file: not found (not a built-in command)');
  return lines;
}

function renderHeader(catalog: Catalog | ResolvedView, count: number): string[] {
  const lines = ['# Slash command catalog', ''];
  lines.push(`- Claude Code version: ${catalog.claudeCodeVersion ?? 'unknown'}`);
  lines.push(
    catalog.source === 'cli'
      ? '- Source: cli (the list reported by the Claude Code CLI)'
      : '- Source: files (fallback: command and skill files only)',
  );
  lines.push(`- Commands: ${count}`);
  const entries: Entry[] = Object.values(catalog.commands);
  const annotated = entries.some(
    (e) =>
      ('guide' in e && e.guide !== undefined) ||
      Object.values(e.origins).some((o) => author(o) !== undefined),
  );
  const marked = entries.some((e) => ('pinned' in e && e.pinned) || ('isNew' in e && e.isNew));
  if (marked) {
    lines.push('- Marks: [pinned] = pinned by the user; [new] = appeared in the last 14 days');
  }
  if (annotated) {
    lines.push(
      '- (team) = written by the team in .claude/slashdeck.json; (user) = edited by the user',
    );
  }
  if (catalog.source === 'files') {
    lines.push(
      '',
      '> Built-in commands are missing: the Claude Code CLI did not answer, so this catalog was',
      '> built from the command, skill and plugin files only. Some listed entries may also be',
      '> disabled in Claude Code.',
    );
  }
  if (catalog.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const w of catalog.warnings) lines.push(`- [${w.code}] ${w.message}`);
  }
  return lines;
}

/**
 * Renders a catalog or a resolved view as Markdown, grouped by category in display order.
 * For a resolved view it also prints the guide texts, who wrote the texts that come from
 * the team or the user, and the [pinned] and [new] marks.
 */
export function renderMarkdown(catalog: Catalog | ResolvedView): string {
  const groups = new Map<string, Entry[]>();
  for (const entry of Object.values(catalog.commands) as Entry[]) {
    const list = groups.get(entry.category);
    if (list) list.push(entry);
    else groups.set(entry.category, [entry]);
  }

  const lines = renderHeader(catalog, Object.keys(catalog.commands).length);
  for (const id of orderCategories(groups.keys())) {
    const entries = [...groups.get(id)!].sort((a, b) => compare(a.name, b.name));
    lines.push('', `## ${categoryLabel(id)} (${entries.length})`, '');
    for (const entry of entries) lines.push(...renderEntry(entry));
  }
  return lines.join('\n') + '\n';
}
