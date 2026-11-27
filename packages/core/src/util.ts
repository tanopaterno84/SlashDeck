import { createHash } from 'node:crypto';

/** Converts a path to forward slashes, on every platform. */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function sha256(data: string | Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}

/**
 * Hash for entries without a source file (builtin, unknown, extra):
 * SHA-256 of the JSON array [name, description, argumentHint], name with the leading "/".
 */
export function hashFields(name: string, description?: string, argumentHint?: string): string {
  return sha256(JSON.stringify([name, description ?? '', argumentHint ?? '']));
}

const BOM = String.fromCharCode(0xfeff);

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

export function stripLeadingSlash(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

/**
 * One-line, ASCII-only summary of zod issues ("path: message; ..."): it may end up in the
 * Markdown catalog.
 */
export function issuesMessage(issues: readonly { path: PropertyKey[]; message: string }[]) {
  return issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
