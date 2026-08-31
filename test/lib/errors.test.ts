import { describe, expect, it } from 'vitest';
import { CheckError, categorise } from '../../src/lib/errors.js';

describe('categorise', () => {
  it('calls a name that does not resolve not_found, not a network failure', () => {
    // The distinction matters to a caller: a domain that does not exist is an
    // answer, and retrying it is pointless.
    expect(categorise('ENOTFOUND')).toBe('not_found');
    expect(categorise('ENODATA')).toBe('not_found');
  });

  it('calls a timeout a timeout', () => {
    expect(categorise('ETIMEDOUT')).toBe('timeout');
    expect(categorise('ETIMEOUT')).toBe('timeout');
  });

  it('calls a refused or reset connection a network failure', () => {
    expect(categorise('ECONNREFUSED')).toBe('network');
    expect(categorise('ECONNRESET')).toBe('network');
  });

  it('treats a cancelled query as a timeout, because that is what cancels it', () => {
    expect(categorise('ECANCELLED')).toBe('timeout');
  });

  it('falls back to network for a code it does not know, and for none at all', () => {
    // Not `unexpected`: an unrecognised code from a socket or a resolver is far
    // more likely to be a network condition than a bug in this server.
    expect(categorise('ESOMETHINGNEW')).toBe('network');
    expect(categorise(undefined)).toBe('network');
  });
});

describe('CheckError', () => {
  it('carries its category and keeps the original cause', () => {
    const cause = new Error('socket hang up');
    const error = new CheckError('network', 'could not reach example.com', { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CheckError');
    expect(error.code).toBe('network');
    expect(error.cause).toBe(cause);
  });
});
