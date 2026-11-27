/**
 * Team override (CLAUDE.md, "Override di team"): `<workspace>/.claude/slashdeck.json`,
 * written by the team by hand and versioned in the repository. The core only reads it.
 *
 * A file that cannot be parsed, or that has an unknown `schemaVersion`, is ignored with a
 * warning. A single malformed command entry (for example a misspelled field) is ignored
 * with a warning, and the other entries still apply.
 */
import path from 'node:path';
import { z } from 'zod';
import { readTextIfExists } from '../fs-util.js';
import type { CommandEdit, ScanWarning } from '../types.js';
import { errorMessage, issuesMessage, stripBom, stripLeadingSlash, toPosixPath } from '../util.js';
import { teamEditSchema } from './edit.js';

export const TEAM_OVERRIDE_PATH = path.join('.claude', 'slashdeck.json');

const teamFileSchema = z.object({
  schemaVersion: z.literal(1),
  commands: z.record(z.string(), z.unknown()).default({}),
});

export interface TeamOverride {
  /** Valid entries, keyed by command name with the leading "/". */
  commands: Record<string, CommandEdit>;
  warnings: ScanWarning[];
}

export function teamOverridePath(workspace: string): string {
  return path.join(workspace, TEAM_OVERRIDE_PATH);
}

function oneLine(error: z.ZodError): string {
  return issuesMessage(error.issues);
}

export async function readTeamOverride(workspace: string): Promise<TeamOverride> {
  const file = teamOverridePath(workspace);
  const shown = toPosixPath(file);
  const ignored = (reason: string): TeamOverride => ({
    commands: {},
    warnings: [
      { code: 'team-override-invalid', message: `team override ${shown} ignored: ${reason}` },
    ],
  });

  let text: string | null;
  try {
    text = await readTextIfExists(file);
  } catch (err) {
    return ignored(errorMessage(err));
  }
  if (text === null) return { commands: {}, warnings: [] };

  let json: unknown;
  try {
    json = JSON.parse(stripBom(text));
  } catch (err) {
    return ignored(`not valid JSON (${errorMessage(err)})`);
  }
  const parsed = teamFileSchema.safeParse(json);
  if (!parsed.success) return ignored(oneLine(parsed.error));

  const commands: Record<string, CommandEdit> = {};
  const warnings: ScanWarning[] = [];
  for (const [rawName, value] of Object.entries(parsed.data.commands)) {
    const name = `/${stripLeadingSlash(rawName.trim())}`;
    const entry = teamEditSchema.safeParse(value);
    if (name === '/' || !entry.success) {
      warnings.push({
        code: 'team-override-invalid',
        message: `team override ${shown}: entry "${rawName}" ignored: ${
          entry.success ? 'empty command name' : oneLine(entry.error)
        }`,
      });
      continue;
    }
    commands[name] = entry.data;
  }
  return { commands, warnings };
}
