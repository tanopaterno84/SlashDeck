import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const text = readFileSync(new URL('../src/SKILL.md', import.meta.url), 'utf8');
const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);

describe('SKILL.md', () => {
  it('has a valid frontmatter', () => {
    expect(match).not.toBeNull();
    const fm = parse(match![1]!) as Record<string, unknown>;
    expect(fm.name).toBe('slashdeck');
    expect(typeof fm.description).toBe('string');
    // Claude Code truncates description + when_to_use at 1,536 characters in the listing.
    expect((fm.description as string).length).toBeLessThanOrEqual(1536);
    // Unquoted brackets would make YAML parse the hint as a list.
    expect(typeof fm['argument-hint']).toBe('string');
    // Without the Bash rule the injected command fails with "This command requires approval"
    // (verified on Claude Code 2.1.318). The rule covers only the skill's own script.
    expect(fm['allowed-tools']).toBe(
      'Read, Bash(node "${CLAUDE_SKILL_DIR}/scripts/slashdeck.mjs" scan *)',
    );
  });

  it('injects the catalog from the bundled CLI, with paths that do not depend on the cwd', () => {
    const body = match![2]!;
    const command =
      'node "${CLAUDE_SKILL_DIR}/scripts/slashdeck.mjs" scan --markdown --quiet --workspace "${CLAUDE_PROJECT_DIR}"';
    expect(body).toContain('```!\n' + command + '\n```');
    // Exactly one injected block, and no inline !`...` injection anywhere else.
    expect(body.match(/```!/g)).toHaveLength(1);
    expect(/(^|\s)!`/.test(body)).toBe(false);
    expect(body).toContain('$ARGUMENTS');
  });

  it('uses no other argument placeholders by accident', () => {
    const body = match![2]!;
    expect(body.replace('$ARGUMENTS', '')).not.toMatch(/\$(ARGUMENTS|\d)/);
  });
});
