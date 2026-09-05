import { describe, expect, it } from 'vitest';
import { blockRefused, type InterceptedRequest } from '../../src/lib/axe.js';
import { CheckError } from '../../src/lib/errors.js';

/** What one intercepted request did, once the handler had decided about it. */
interface Outcome {
  continued: boolean;
  aborted: string | undefined;
}

/**
 * Captures the route handler the way a browser context would, then lets a test
 * drive requests through it.
 *
 * @param allow The policy under test.
 * @returns A function that plays one request URL through the handler.
 */
async function intercept(
  allow: (target: URL) => Promise<void>,
): Promise<(url: string) => Promise<Outcome>> {
  let handler: ((route: InterceptedRequest) => Promise<void>) | undefined;
  await blockRefused(
    {
      route: (_pattern, given) => {
        handler = given;
        return Promise.resolve(undefined);
      },
    },
    allow,
  );

  if (handler === undefined) throw new Error('no handler was registered');
  const registered = handler;

  return async (url: string): Promise<Outcome> => {
    const outcome: Outcome = { continued: false, aborted: undefined };
    await registered({
      request: () => ({ url: () => url }),
      continue: () => {
        outcome.continued = true;
        return Promise.resolve();
      },
      abort: (errorCode) => {
        outcome.aborted = errorCode ?? '';
        return Promise.resolve();
      },
    });
    return outcome;
  };
}

/** A policy that refuses anything whose hostname is not `public.example`. */
function onlyPublicExample(): {
  allow: (target: URL) => Promise<void>;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    allow: (target: URL) => {
      asked.push(target.hostname);
      return target.hostname === 'public.example'
        ? Promise.resolve()
        : Promise.reject(new CheckError('invalid_input', `${target.hostname} is not public`));
    },
  };
}

describe('blockRefused', () => {
  it('lets through a subresource the policy allows', async () => {
    const policy = onlyPublicExample();
    const play = await intercept(policy.allow);

    await expect(play('https://public.example/logo.png')).resolves.toEqual({
      continued: true,
      aborted: undefined,
    });
  });

  it('aborts a subresource pointing at an address the policy refuses', async () => {
    // The whole reason this exists. Only the page's own URL used to be checked,
    // so `<img src="http://169.254.169.254/latest/meta-data/">` on any page made
    // the server fetch cloud metadata — and whether it loaded is observable from
    // the page, whatever the response body does or does not come back.
    const policy = onlyPublicExample();
    const play = await intercept(policy.allow);

    await expect(play('http://169.254.169.254/latest/meta-data/')).resolves.toEqual({
      continued: false,
      aborted: 'blockedbyclient',
    });
  });

  it('applies the policy to every scheme that reaches a network', async () => {
    const policy = onlyPublicExample();
    const play = await intercept(policy.allow);

    await expect(play('http://10.0.0.5/internal.css')).resolves.toMatchObject({
      continued: false,
    });
    await expect(play('https://10.0.0.5/internal.css')).resolves.toMatchObject({
      continued: false,
    });
  });

  it('does not ask about a scheme that reaches no network', async () => {
    // A data: URI never leaves the process, and there is nothing for a target
    // policy to decide about it. Asking would also fail: it has no hostname.
    const policy = onlyPublicExample();
    const play = await intercept(policy.allow);

    await expect(play('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).resolves.toEqual({
      continued: true,
      aborted: undefined,
    });
    expect(policy.asked).toEqual([]);
  });

  it('asks once per origin, however many files come from it', async () => {
    // A page pulling forty files off one CDN would otherwise resolve that
    // hostname forty times, inside an audit that already has a deadline.
    const policy = onlyPublicExample();
    const play = await intercept(policy.allow);

    await play('https://public.example/a.css');
    await play('https://public.example/b.js');
    await play('https://public.example/c.woff2');

    expect(policy.asked).toEqual(['public.example']);
  });

  it('treats a different port on the same host as its own decision', async () => {
    // The policy allows 443 and 80 only, so an origin is host *and* port. Keying
    // the memo on the hostname alone would let `https://host:8080/` through on
    // the strength of an earlier answer about `https://host/`.
    const seen: string[] = [];
    const play = await intercept((target) => {
      seen.push(target.port === '' ? 'default' : target.port);
      return target.port === ''
        ? Promise.resolve()
        : Promise.reject(new CheckError('invalid_input', 'not a web port'));
    });

    await expect(play('https://public.example/ok.png')).resolves.toMatchObject({ continued: true });
    await expect(play('https://public.example:8080/probe')).resolves.toMatchObject({
      continued: false,
    });
    expect(seen).toEqual(['default', '8080']);
  });
});
