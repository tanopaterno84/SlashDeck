import { z } from 'zod';
// Inlined by esbuild at build time: the built output never reads this file at runtime.
import rawBuiltinData from '../../../data/builtin-commands.json' with { type: 'json' };

export const extraCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  argumentHint: z.string().optional(),
  category: z.string().min(1).optional(),
});

export const builtinDataSchema = z.object({
  schemaVersion: z.literal(1),
  categories: z.record(z.string(), z.string().min(1)).default({}),
  hidden: z.array(z.string()).default([]),
  extra: z.array(extraCommandSchema).default([]),
});

export type ExtraCommand = z.infer<typeof extraCommandSchema>;
export type BuiltinData = z.infer<typeof builtinDataSchema>;

let cached: BuiltinData | undefined;

/** The curated data shipped with the core (data/builtin-commands.json). */
export function loadBuiltinData(): BuiltinData {
  cached ??= builtinDataSchema.parse(rawBuiltinData);
  return cached;
}
