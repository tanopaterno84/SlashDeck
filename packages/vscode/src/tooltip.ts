/**
 * Tooltip of a command, as Markdown source for a `vscode.MarkdownString`.
 *
 * Every text that comes from a command (name, description, argument hint, guide, path) was
 * written by someone else and is untrusted: it is flattened to one line and every ASCII
 * punctuation character is backslash-escaped, so that it renders as plain text. No link,
 * image, HTML tag, autolink or theme icon can come out of it. The extension also creates the
 * MarkdownString with `isTrusted`, `supportHtml` and `supportThemeIcons` all false (see
 * tree-provider.ts), so even a missed escape could not run a command or load remote content.
 */
import { truncateText, type Origin, type ResolvedEntry, type ResolvedField } from '@slashdeck/core';
import { categoryLabel, kindLabel, originLabel } from './labels.js';
import type { Translate } from './l10n.js';

/** Longest text shown in a tooltip, per field. */
export const TOOLTIP_TEXT_CHARS = 600;

/** CommonMark: any ASCII punctuation character may be backslash-escaped. */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;

/** Untrusted text → inert Markdown: one line, cut, every punctuation character escaped. */
export function escapeMarkdown(text: string, max: number = TOOLTIP_TEXT_CHARS): string {
  return truncateText(text, max).replace(ASCII_PUNCTUATION, '\\$&');
}

/** Our own fixed text (labels): only escaped, never cut. */
function fixed(text: string): string {
  return text.replace(ASCII_PUNCTUATION, '\\$&');
}

function originOf(entry: ResolvedEntry, field: ResolvedField): Origin | undefined {
  return entry.origins[field];
}

function originNote(entry: ResolvedEntry, field: ResolvedField, t: Translate): string {
  return `_${fixed(originLabel(originOf(entry, field), t))}_`;
}

function field(
  entry: ResolvedEntry,
  name: string,
  value: string,
  origin: ResolvedField,
  t: Translate,
): string {
  return `**${fixed(name)}:** ${value} — ${originNote(entry, origin, t)}`;
}

export function tooltipMarkdown(entry: ResolvedEntry, t: Translate): string {
  const blocks: string[] = [];

  const hint = entry.argumentHint?.trim();
  blocks.push(`**${escapeMarkdown(entry.name)}**${hint ? ` ${escapeMarkdown(hint)}` : ''}`);

  const description = entry.description?.trim();
  blocks.push(
    description
      ? `${escapeMarkdown(description)}  \n${originNote(entry, 'description', t)}`
      : `_${fixed(t('No description'))}_`,
  );

  const details: string[] = [];
  if (hint) details.push(field(entry, t('Arguments'), escapeMarkdown(hint), 'argumentHint', t));
  const guide = entry.guide;
  if (guide?.whenToUse !== undefined) {
    details.push(
      field(entry, t('When to use'), escapeMarkdown(guide.whenToUse), 'guide.whenToUse', t),
    );
  }
  if (guide?.example !== undefined) {
    details.push(field(entry, t('Example'), escapeMarkdown(guide.example), 'guide.example', t));
  }
  if (guide?.related !== undefined && guide.related.length > 0) {
    const related = guide.related.map((r) => escapeMarkdown(r, 80)).join(', ');
    details.push(field(entry, t('Related'), related, 'guide.related', t));
  }
  if (details.length > 0) blocks.push(details.join('  \n'));

  const about: string[] = [
    `**${fixed(t('Type'))}:** ${fixed(kindLabel(entry.kind, t))}`,
    `**${fixed(t('Group'))}:** ${escapeMarkdown(categoryLabel(entry.category, t), 120)} — ${originNote(entry, 'category', t)}`,
  ];
  if (entry.sourcePath !== null) {
    about.push(`**${fixed(t('Source file'))}:** ${escapeMarkdown(entry.sourcePath, 400)}`);
  }
  if (entry.isNew && entry.firstSeenAt !== null) {
    about.push(
      `**${fixed(t('New'))}:** ${fixed(t('first seen on {0}', entry.firstSeenAt.slice(0, 10)))}`,
    );
  }
  if (entry.pinned) about.push(`_${fixed(t('In your favourites'))}_`);
  blocks.push(about.join('  \n'));

  return blocks.join('\n\n');
}
