import { parse as parseYaml } from 'yaml';
import { stripBom } from '../util.js';

export interface FrontmatterResult {
  data: Record<string, unknown>;
  /** Top-level `key: value` lines as written, without YAML interpretation. */
  raw: Record<string, unknown>;
  body: string;
  /** Set when the frontmatter exists but could not be parsed cleanly. */
  error?: string;
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^---[ \t]*$/m;

/** Lenient fallback for invalid YAML: top-level `key: value` lines only. */
function parseLines(src: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const line of src.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    let value = (m[2] ?? '').trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    data[m[1]] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return data;
}

/** Splits and parses a YAML frontmatter block. Never throws. */
export function parseFrontmatter(text: string): FrontmatterResult {
  const content = stripBom(text);
  const open = OPEN.exec(content);
  if (!open) return { data: {}, raw: {}, body: content };

  const rest = content.slice(open[0].length);
  const close = CLOSE.exec(rest);
  if (!close) {
    return { data: {}, raw: {}, body: content, error: 'unterminated frontmatter' };
  }
  const yamlSrc = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length).replace(/^\r?\n/, '');

  const raw = parseLines(yamlSrc);
  try {
    const parsed: unknown = parseYaml(yamlSrc);
    if (parsed === null || parsed === undefined) return { data: {}, raw, body };
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, raw, body, error: 'frontmatter is not a mapping' };
    }
    return { data: parsed as Record<string, unknown>, raw, body };
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : undefined;
    return { data: raw, raw, body, error: reason || 'invalid YAML' };
  }
}

/**
 * `argument-hint: [file]` is valid YAML but parses as an array; the author meant the literal
 * text, so a non-string value falls back to the raw line.
 */
export function argumentHintField(fm: FrontmatterResult): string | undefined {
  const value = fm.data['argument-hint'];
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string'
    ? stringField(fm.data, 'argument-hint')
    : stringField(fm.raw, 'argument-hint');
}

export function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function isFalse(value: unknown): boolean {
  return value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'false');
}
