/**
 * Search over the commands, for "SlashDeck: Search Command" (CLAUDE.md: search by intention,
 * "I want to do X", before browsing). No `vscode` import.
 *
 * VS Code's own quick pick filter matches one contiguous string, so "review pull request"
 * would find nothing. Here the query is split into words; each word is looked up in the
 * name, the argument hint, the description, the "when to use" text, the example and the
 * group label, accents and case ignored, with a crude stem so that "commits" finds "commit".
 * A command is listed when at least one word matches; more matched words and matches in the
 * name rank higher. Words that carry no meaning ("how", "do", "voglio"...) are ignored.
 */
import {
  orderCategories,
  truncateText,
  type ResolvedEntry,
  type ResolvedView,
} from '@slashdeck/core';
import { categoryLabel } from './labels.js';
import type { Translate } from './l10n.js';

const STOP_WORDS = new Set(
  [
    // English
    'a an the i to do how can want what which is of for in on my me and or with it this that',
    'command use',
    // Italian
    'il lo la le gli un una uno di da per con su e o come faccio fare voglio vorrei che quale',
    'cosa mi del della al alla comando usare',
  ]
    .join(' ')
    .split(' '),
);

/** Lower case, no accents. */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Query words, without stop words and without the leading "/" of a command name. */
export function queryTokens(query: string): string[] {
  const words = normalize(query)
    .split(/[^\p{L}\p{N}:_-]+/u)
    .map((w) => w.replace(/^[-:_]+|[-:_]+$/g, ''))
    .filter((w) => w !== '');
  const meaningful = words.filter((w) => !STOP_WORDS.has(w));
  // A query made only of stop words ("do") is still searched as it is.
  return [...new Set(meaningful.length > 0 ? meaningful : words)];
}

/** Crude stem: drops the last one or two letters of long words (plurals, verb endings). */
function stem(token: string): string {
  if (token.length >= 7) return token.slice(0, -2);
  if (token.length >= 5) return token.slice(0, -1);
  return token;
}

function words(text: string): string[] {
  return normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');
}

interface Fields {
  name: string;
  nameWords: string[];
  text: { words: string[]; weight: number }[];
}

function fieldsOf(entry: ResolvedEntry, t: Translate): Fields {
  const text = (value: string | undefined, weight: number) => ({
    words: value ? words(value) : [],
    weight,
  });
  return {
    name: normalize(entry.name.replace(/^\//, '')),
    nameWords: words(entry.name),
    text: [
      text(entry.guide?.whenToUse, 3),
      text(entry.description, 3),
      text(entry.guide?.example, 1),
      text(entry.argumentHint, 1),
      text(categoryLabel(entry.category, t), 1),
    ],
  };
}

/** Score of one query word against a command; 0 when it does not match. */
function tokenScore(token: string, fields: Fields): number {
  if (fields.name === token) return 12;
  if (fields.name.startsWith(token)) return 9;
  if (fields.nameWords.some((w) => w.startsWith(token))) return 8;
  if (fields.name.includes(token)) return 6;
  const prefix = stem(token);
  let best = 0;
  for (const field of fields.text) {
    if (field.words.some((w) => w.startsWith(prefix))) best = Math.max(best, field.weight);
  }
  if (best === 0 && fields.nameWords.some((w) => w.startsWith(prefix))) best = 4;
  return best;
}

export interface RankedCommand {
  entry: ResolvedEntry;
  /** Query words found in the command. */
  matched: number;
  score: number;
}

/** Commands matching the query, best first. An empty query matches nothing. */
export function rankCommands(view: ResolvedView, query: string, t: Translate): RankedCommand[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const ranked: RankedCommand[] = [];
  for (const entry of Object.values(view.commands)) {
    const fields = fieldsOf(entry, t);
    let matched = 0;
    let score = 0;
    for (const token of tokens) {
      const s = tokenScore(token, fields);
      if (s > 0) {
        matched += 1;
        score += s;
      }
    }
    if (matched > 0) ranked.push({ entry, matched, score });
  }
  return ranked.sort(
    (a, b) =>
      b.matched - a.matched ||
      b.score - a.score ||
      Number(b.entry.pinned) - Number(a.entry.pinned) ||
      (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0),
  );
}

export interface SearchCommandItem {
  kind: 'command';
  label: string;
  description: string;
  detail: string;
  entry: ResolvedEntry;
}

export interface SearchSeparatorItem {
  kind: 'separator';
  label: string;
}

export type SearchItem = SearchCommandItem | SearchSeparatorItem;

/**
 * Quick pick labels support `$(icon)` syntax: a description that contains it is shown
 * literally, not as an icon.
 */
export function escapeIcons(text: string): string {
  return text.replace(/\$\(/g, '\\$(');
}

export function searchCommandItem(entry: ResolvedEntry, t: Translate): SearchCommandItem {
  const marks = [
    ...(entry.pinned ? [t('Favourite')] : []),
    ...(entry.isNew ? [t('New')] : []),
    categoryLabel(entry.category, t),
  ];
  const hint = entry.argumentHint?.trim();
  const description = entry.description?.trim();
  return {
    kind: 'command',
    label: escapeIcons(entry.name),
    description: escapeIcons([...(hint ? [truncateText(hint, 40)] : []), ...marks].join(' · ')),
    detail: escapeIcons(description ? truncateText(description, 200) : t('No description')),
    entry,
  };
}

/**
 * Items of the quick pick. Empty query: every command, grouped like the tree (Favourites
 * first). Otherwise: the matching commands, best first, without groups.
 */
export function searchItems(view: ResolvedView, query: string, t: Translate): SearchItem[] {
  if (queryTokens(query).length > 0) {
    return rankCommands(view, query, t).map((r) => searchCommandItem(r.entry, t));
  }
  const entries = Object.values(view.commands).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const items: SearchItem[] = [];
  const pinned = entries.filter((e) => e.pinned);
  if (pinned.length > 0) {
    items.push({ kind: 'separator', label: t('Favourites') });
    for (const e of pinned) items.push(searchCommandItem(e, t));
  }
  const categories = orderCategories(new Set(entries.map((e) => e.category)));
  for (const id of categories) {
    items.push({ kind: 'separator', label: categoryLabel(id, t) });
    for (const e of entries.filter((x) => x.category === id && !x.pinned)) {
      items.push(searchCommandItem(e, t));
    }
  }
  // Drop the separators of groups whose commands are all in Favourites.
  return items.filter((item, i) => item.kind === 'command' || items[i + 1]?.kind === 'command');
}
