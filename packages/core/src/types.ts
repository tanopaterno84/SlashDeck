export type CommandKind =
  | 'builtin'
  | 'custom-user'
  | 'custom-project'
  | 'skill-user'
  | 'skill-synced'
  | 'skill-project'
  | 'plugin'
  | 'unknown';

/**
 * Where a text field comes from.
 * - `cli`: returned by the Claude Code CLI;
 * - `local-metadata`: frontmatter of the source file (file-only fallback);
 * - `curated`: data/builtin-commands.json;
 * - `derived`: computed by SlashDeck from other data (e.g. a category derived from `kind`,
 *   or `other` for a builtin without a curated category). Lowest precedence.
 * - `team`: the team override, `<workspace>/.claude/slashdeck.json` (resolved view only);
 * - `user-edit`: the user's own edit in the user state (resolved view only).
 * A catalog (and the cache) only ever holds the first four.
 */
export type Origin = 'cli' | 'local-metadata' | 'curated' | 'derived' | 'team' | 'user-edit';

export type OriginField = 'description' | 'argumentHint' | 'category';

export interface CatalogEntry {
  name: string;
  kind: CommandKind;
  plugin?: string;
  sourcePath: string | null;
  hash: string;
  category: string;
  description?: string;
  argumentHint?: string;
  origins: Partial<Record<OriginField, Origin>>;
}

export interface ScanWarning {
  code: string;
  message: string;
}

export type CatalogSource = 'cli' | 'files';

export interface Catalog {
  schemaVersion: 1;
  claudeCodeVersion: string | null;
  source: CatalogSource;
  workspace: string;
  scannedAt: string;
  warnings: ScanWarning[];
  commands: Record<string, CatalogEntry>;
}

/** Guide texts: written by the team (override file) or by the user (edits). */
export interface Guide {
  whenToUse?: string;
  example?: string;
  related?: string[];
}

/**
 * The fields a team override or a user edit may set (CLAUDE.md, "Regole dello stato
 * utente"): `description`, `category`, `guide.whenToUse`, `guide.example`, `guide.related`.
 */
export interface CommandEdit {
  description?: string;
  category?: string;
  guide?: Guide;
}

/** Keys of `ResolvedEntry.origins`: guide fields use a dotted name, e.g. `guide.whenToUse`. */
export type ResolvedField = OriginField | 'guide.whenToUse' | 'guide.example' | 'guide.related';

/** One command of the resolved view: catalog + team override + user edits + state. */
export interface ResolvedEntry extends Omit<CatalogEntry, 'origins'> {
  guide?: Guide;
  origins: Partial<Record<ResolvedField, Origin>>;
  /** Pinned by the user (user state). */
  pinned: boolean;
  /** Appeared after the first scan of the workspace and less than 14 days ago. */
  isNew: boolean;
  /** When the command was first seen in this workspace; null if never recorded. */
  firstSeenAt: string | null;
}

/**
 * What the IDEs and the skill show (CLAUDE.md, "Vista risolta"). Computed on every read,
 * never saved. `warnings` holds the scan warnings plus those found while resolving
 * (unreadable user state, malformed team override, cache not written).
 */
export interface ResolvedView {
  schemaVersion: 1;
  claudeCodeVersion: string | null;
  source: CatalogSource;
  workspace: string;
  workspaceId: string;
  scannedAt: string;
  warnings: ScanWarning[];
  /**
   * The category IDs of `commands` (after the team override and the user's edits), each once,
   * in display order (`orderCategories`). Front-ends that do not use the core as a library,
   * such as the JetBrains plugin, read the order from here instead of re-implementing it.
   */
  categoryOrder: string[];
  commands: Record<string, ResolvedEntry>;
}
