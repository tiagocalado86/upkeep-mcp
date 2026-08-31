import type { ToolErrorCode } from '../types.js';

/**
 * A failure with a category already attached.
 *
 * Modules in `lib/` throw this rather than returning a result type, so that a
 * deep call stack does not have to thread a failure back by hand. Tool handlers
 * catch it and turn it into an MCP error result — nothing escapes to the
 * protocol, and the category survives the trip.
 */
export class CheckError extends Error {
  /** Category the tool layer reports to the caller. */
  readonly code: ToolErrorCode;

  /**
   * @param code Category of failure.
   * @param message Actionable explanation naming what failed and against what.
   * @param options Standard error options; pass `cause` to keep the original.
   */
  constructor(code: ToolErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CheckError';
    this.code = code;
  }
}

/**
 * Maps a DNS or socket error code onto a tool error category.
 *
 * @param code The `err.code` from `node:dns` or a socket.
 * @returns The matching category, defaulting to `network`.
 * @throws Never.
 */
export function categorise(code: string | undefined): ToolErrorCode {
  switch (code) {
    case 'ENOTFOUND':
    case 'ENODATA':
      return 'not_found';
    // ETIMEOUT is what node:dns emits; ETIMEDOUT is the socket equivalent. They
    // are different strings and both occur, which is easy to get wrong.
    case 'ETIMEOUT':
    case 'ETIMEDOUT':
    case 'ECANCELLED':
      return 'timeout';
    default:
      return 'network';
  }
}
