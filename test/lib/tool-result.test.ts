import { describe, expect, it } from 'vitest';
import { fail, guard, succeed, toToolError } from '../../src/lib/tool-result.js';

describe('succeed', () => {
  it('carries both the text and the structured half of the result', () => {
    const result = succeed('all good', { status: 'ok' });

    expect(result.content).toEqual([{ type: 'text', text: 'all good' }]);
    expect(result.structuredContent).toEqual({ status: 'ok' });
    expect(result.isError).toBeUndefined();
  });
});

describe('fail', () => {
  it('marks the result as an error and names the failure in the text', () => {
    const result = fail('timeout', 'TLS handshake with example.com:443 timed out after 10s');

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'timeout: TLS handshake with example.com:443 timed out after 10s' },
    ]);
  });

  it('omits structuredContent, which describes successful readings only', () => {
    expect(fail('network', 'domain does not resolve').structuredContent).toBeUndefined();
  });
});

describe('toToolError', () => {
  it('takes the message from an Error', () => {
    expect(toToolError(new Error('boom'))).toEqual({ code: 'unexpected', message: 'boom' });
  });

  it('stringifies values that are not Errors, since anything can be thrown', () => {
    expect(toToolError('boom')).toEqual({ code: 'unexpected', message: 'boom' });
    expect(toToolError(undefined)).toEqual({ code: 'unexpected', message: 'undefined' });
  });
});

describe('guard', () => {
  it('passes a successful result through untouched', async () => {
    const handler = guard(() => succeed('fine', { status: 'ok' }));

    await expect(handler()).resolves.toEqual(succeed('fine', { status: 'ok' }));
  });

  it('forwards the handler arguments', async () => {
    const handler = guard((a: number, b: number) => succeed(String(a + b), { sum: a + b }));

    await expect(handler(2, 3)).resolves.toMatchObject({ structuredContent: { sum: 5 } });
  });

  it('turns a synchronous throw into an error result rather than letting it escape', async () => {
    const handler = guard(() => {
      throw new Error('unexpected failure');
    });

    await expect(handler()).resolves.toEqual(fail('unexpected', 'unexpected failure'));
  });

  it('turns a rejected promise into an error result', async () => {
    const handler = guard(() => Promise.reject(new Error('async failure')));

    await expect(handler()).resolves.toEqual(fail('unexpected', 'async failure'));
  });

  it('survives a non-Error rejection', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const handler = guard(() => Promise.reject('just a string'));

    await expect(handler()).resolves.toEqual(fail('unexpected', 'just a string'));
  });
});
