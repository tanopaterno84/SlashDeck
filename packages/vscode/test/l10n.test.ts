// Every UI string has an Italian translation, and no translation is left over.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');
const json = (file: string) => JSON.parse(read(file)) as Record<string, unknown>;

/** The literal first arguments of `t(...)` calls in src/, comments removed. */
function sourceStrings(): Set<string> {
  const strings = new Set<string>();
  for (const file of readdirSync(new URL('src/', root))) {
    const code = read(`src/${file}`)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const match of code.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      strings.add(match[2]!.replace(/\\(['"\\])/g, '$1'));
    }
    // Calls whose first argument is not a literal could not be checked: there must be none.
    expect(code.match(/\bt\(\s*[^'"\s)]/g) ?? [], file).toEqual([]);
  }
  return strings;
}

describe('runtime strings (l10n/bundle.l10n.it.json)', () => {
  const bundle = json('l10n/bundle.l10n.it.json');
  const strings = sourceStrings();

  it('finds the strings', () => {
    expect(strings.size).toBeGreaterThan(50);
  });

  it('translates every string', () => {
    expect([...strings].filter((s) => !(s in bundle))).toEqual([]);
  });

  it('has no stale translation', () => {
    expect(Object.keys(bundle).filter((k) => !strings.has(k))).toEqual([]);
  });

  it('keeps the placeholders', () => {
    for (const [key, value] of Object.entries(bundle)) {
      const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort();
      expect(placeholders(value as string), key).toEqual(placeholders(key));
    }
  });
});

describe('package.json strings (package.nls*.json)', () => {
  const en = json('package.nls.json');
  const it_ = json('package.nls.it.json');
  const manifest = read('package.json');

  it('has the same keys in English and Italian', () => {
    expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort());
  });

  it('defines every %key% used by package.json, and only those', () => {
    const used = new Set([...manifest.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]!));
    expect([...used].filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(en).filter((k) => !used.has(k))).toEqual([]);
  });
});
