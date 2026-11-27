/**
 * File helpers for the cache and the user state: atomic writes (temporary file in the same
 * folder, then rename), with an optional "unchanged since" check right before the rename.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Reads a UTF-8 file; `null` when it does not exist. Other errors are thrown. */
export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

const RENAME_RETRIES = 8;

/** Windows refuses to replace a file that another process has open: retry for a short while. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= RENAME_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

export interface AtomicWriteOptions {
  /**
   * Content the target file must still have right before the rename (`null`: the file must
   * not exist). When it differs, nothing is written and the function returns false.
   */
  unchangedSince?: string | null;
}

/**
 * Writes `data` to `file` atomically: a temporary file in the same folder, flushed to disk,
 * then renamed over the target. Creates the folder. Returns false only when
 * `unchangedSince` is given and the file changed in the meantime.
 */
export async function writeFileAtomic(
  file: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<boolean> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.unchangedSince !== undefined) {
      const current = await readTextIfExists(file);
      if (current !== options.unchangedSince) {
        await rm(temp, { force: true });
        return false;
      }
    }
    await renameWithRetry(temp, file);
    return true;
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}
