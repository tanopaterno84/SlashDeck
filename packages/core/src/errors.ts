export type SlashDeckErrorCode =
  /** There is no usable cache for the workspace yet: run a scan first. */
  | 'no-cache'
  /** The command is not in the cached catalog of the workspace. */
  | 'not-in-catalog'
  /** A command name that is empty or only "/". */
  | 'invalid-command-name'
  /** An edit that does not have the shape of an `edits` entry. */
  | 'invalid-edit'
  /** The user state file exists but cannot be read: it is never overwritten. */
  | 'state-unreadable'
  /** The user state file kept changing under concurrent writers. */
  | 'state-busy';

/** An expected failure of a library call; `code` is stable, `message` is for people. */
export class SlashDeckError extends Error {
  constructor(
    readonly code: SlashDeckErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SlashDeckError';
  }
}
