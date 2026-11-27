/**
 * The editable fields of a command, shared by the user state (`edits`) and the team
 * override: `description`, `category`, `guide.whenToUse`, `guide.example`, `guide.related`.
 * Texts must not be blank. A category may be any ID: unknown IDs are shown as they are.
 */
import { z } from 'zod';
import type { CommandEdit } from '../types.js';

const text = z.string().refine((s) => s.trim() !== '', { message: 'must not be empty' });

/** Team override entry: hand-written, so unknown keys (typos) are errors. */
export const teamEditSchema = z.strictObject({
  description: text.optional(),
  category: text.optional(),
  guide: z
    .strictObject({
      whenToUse: text.optional(),
      example: text.optional(),
      related: z.array(text).optional(),
    })
    .optional(),
});

/**
 * User state entry: written by SlashDeck. Unknown keys are kept, so that a file written by
 * a newer version never loses data when an older one rewrites it.
 */
export const storedEditSchema = z.looseObject({
  description: text.optional(),
  category: text.optional(),
  guide: z
    .looseObject({
      whenToUse: text.optional(),
      example: text.optional(),
      related: z.array(text).optional(),
    })
    .optional(),
});

/**
 * Input of `edit`: the fields to change, in the shape of an `edits` entry. A value sets the
 * field, `null` removes the user's own value (the team or catalog value shows again), an
 * absent field is left as it is. `guide: null` removes all the user's guide fields.
 */
export const editInputSchema = z.strictObject({
  description: text.nullable().optional(),
  category: text.nullable().optional(),
  guide: z
    .strictObject({
      whenToUse: text.nullable().optional(),
      example: text.nullable().optional(),
      related: z.array(text).nullable().optional(),
    })
    .nullable()
    .optional(),
});

export type CommandEditInput = z.infer<typeof editInputSchema>;

const TOP_FIELDS = ['description', 'category'] as const;
const GUIDE_FIELDS = ['whenToUse', 'example', 'related'] as const;

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === null) delete target[key];
  else if (value !== undefined) target[key] = value;
}

/** The edit after applying `input`; undefined when nothing is left. */
export function mergeEdit(
  existing: CommandEdit | undefined,
  input: CommandEditInput,
): CommandEdit | undefined {
  const next = structuredClone(existing ?? {}) as Record<string, unknown> & CommandEdit;
  for (const key of TOP_FIELDS) setOrDelete(next, key, input[key]);
  if (input.guide === null) delete next.guide;
  else if (input.guide !== undefined) {
    const guide = { ...next.guide } as Record<string, unknown>;
    for (const key of GUIDE_FIELDS) setOrDelete(guide, key, input.guide[key]);
    if (Object.keys(guide).length > 0) next.guide = guide;
    else delete next.guide;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
