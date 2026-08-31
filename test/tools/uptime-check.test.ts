import { describe, expect, it } from 'vitest';
import { runUptimeCheck } from '../../src/tools/uptime-check.js';
import { fakePorts, findingCodes, structured, text } from '../helpers/fake-ports.js';

const HSTS = 'max-age=31536000; includeSubDomains';

describe('runUptimeCheck', () => {
  it('reports a healthy page', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/' },
      fakePorts({
        hops: {
          'https://example.com/': {
            status: 200,
            headers: {
              'strict-transport-security': HSTS,
              'content-security-policy': "default-src 'self'",
              'x-content-type-options': 'nosniff',
            },
          },
          'http://example.com/': { status: 301, location: 'https://example.com/' },
        },
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      reachable: true,
      status: 200,
      severity: 'ok',
      finalUrl: 'https://example.com/',
    });
    expect(findingCodes(result)).toEqual([]);
  });

  it('treats a bare domain as HTTPS', async () => {
    const result = await runUptimeCheck(
      { url: 'example.com' },
      fakePorts({
        hops: {
          'https://example.com/': { status: 200 },
          'http://example.com/': { status: 301, location: 'https://example.com/' },
        },
      }),
    );

    expect(structured(result)['url']).toBe('https://example.com/');
  });

  it('records every hop of a redirect chain', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/' },
      fakePorts({
        hops: {
          'https://example.com/': { status: 301, location: 'https://www.example.com/' },
          'https://www.example.com/': { status: 302, location: '/home' },
          'https://www.example.com/home': { status: 200 },
          'http://example.com/': { status: 301, location: 'https://example.com/' },
        },
      }),
    );

    const redirects = structured(result)['redirects'] as { hops: unknown[]; crossHost: boolean };
    expect(redirects.hops).toHaveLength(3);
    expect(redirects.crossHost).toBe(true);
    expect(structured(result)['finalUrl']).toBe('https://www.example.com/home');
  });

  it('resolves a relative Location against the URL it came from', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/old/page' },
      fakePorts({
        hops: {
          'https://example.com/old/page': { status: 301, location: '../new' },
          'https://example.com/new': { status: 200 },
          'http://example.com/old/page': { status: 200 },
        },
      }),
    );

    expect(structured(result)['finalUrl']).toBe('https://example.com/new');
  });

  it('detects a redirect loop instead of following it forever', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/a' },
      fakePorts({
        hops: {
          'https://example.com/a': { status: 302, location: 'https://example.com/b' },
          'https://example.com/b': { status: 302, location: 'https://example.com/a' },
          'http://example.com/a': { status: 200 },
        },
      }),
    );

    expect(structured(result)['redirects']).toMatchObject({ loopDetected: true });
    expect(findingCodes(result)).toContain('redirect_loop');
    expect(structured(result)['severity']).toBe('critical');
  });

  it('notes a chain long enough to be worth shortening', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/1' },
      fakePorts({
        hops: {
          'https://example.com/1': { status: 301, location: 'https://example.com/2' },
          'https://example.com/2': { status: 301, location: 'https://example.com/3' },
          'https://example.com/3': { status: 301, location: 'https://example.com/4' },
          'https://example.com/4': { status: 200 },
          'http://example.com/1': { status: 200 },
        },
      }),
    );

    expect(findingCodes(result)).toContain('redirect_chain_long');
  });

  it('reports a server error as critical', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/' },
      fakePorts({
        hops: { 'https://example.com/': { status: 503 }, 'http://example.com/': { status: 503 } },
      }),
    );

    expect(findingCodes(result)).toContain('server_error');
    expect(structured(result)['severity']).toBe('critical');
  });

  it('reports a 404 as critical too, since the page was expected to exist', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/gone' },
      fakePorts({
        hops: {
          'https://example.com/gone': { status: 404 },
          'http://example.com/gone': { status: 404 },
        },
      }),
    );

    expect(findingCodes(result)).toContain('client_error');
  });

  it('warns when plain HTTP does not move visitors to HTTPS', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/' },
      fakePorts({
        hops: {
          'https://example.com/': { status: 200, headers: { 'strict-transport-security': HSTS } },
          'http://example.com/': { status: 200 },
        },
      }),
    );

    expect(findingCodes(result)).toContain('no_https_redirect');
    expect(structured(result)['https']).toMatchObject({ probedHttp: true, upgradesToHttps: false });
  });

  it('does not fault a host that simply refuses plain HTTP', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/' },
      fakePorts({
        hops: {
          'https://example.com/': { status: 200, headers: { 'strict-transport-security': HSTS } },
          'http://example.com/': new Error('ECONNREFUSED'),
        },
      }),
    );

    expect(structured(result)['https']).toMatchObject({ probedHttp: false });
    expect(findingCodes(result)).not.toContain('no_https_redirect');
  });

  it('reads HSTS from the HTTPS response', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/' },
      fakePorts({
        hops: {
          'https://example.com/': {
            status: 200,
            headers: {
              'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
            },
          },
          'http://example.com/': { status: 301, location: 'https://example.com/' },
        },
      }),
    );

    expect(structured(result)['hsts']).toMatchObject({
      present: true,
      maxAgeSeconds: 31_536_000,
      includeSubDomains: true,
      preload: true,
      preloadEligible: true,
    });
  });

  it('never reports a missing preload directive as a problem', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/' },
      fakePorts({
        hops: {
          'https://example.com/': { status: 200, headers: { 'strict-transport-security': HSTS } },
          'http://example.com/': { status: 301, location: 'https://example.com/' },
        },
      }),
    );

    expect(structured(result)['hsts']).toMatchObject({ preload: false, preloadEligible: false });
    expect(findingCodes(result).join(' ')).not.toContain('preload');
  });

  it('treats max-age=0 as switching HSTS off, not as a weak policy', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/' },
      fakePorts({
        hops: {
          'https://example.com/': {
            status: 200,
            headers: { 'strict-transport-security': 'max-age=0' },
          },
          'http://example.com/': { status: 301, location: 'https://example.com/' },
        },
      }),
    );

    expect(findingCodes(result)).toContain('hsts_disabled');
    expect(structured(result)['severity']).toBe('critical');
  });

  it('ignores an HSTS header sent over plain HTTP, as RFC 6797 requires', async () => {
    const result = await runUptimeCheck(
      { url: 'http://example.com/' },
      fakePorts({
        hops: {
          'http://example.com/': { status: 200, headers: { 'strict-transport-security': HSTS } },
        },
      }),
    );

    expect(structured(result)['hsts']).toMatchObject({ present: false });
  });

  it('does not report a missing X-XSS-Protection, but does report a present one', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/' },
      fakePorts({
        hops: {
          'https://example.com/': {
            status: 200,
            headers: {
              'strict-transport-security': HSTS,
              'content-security-policy': "default-src 'self'",
              'x-content-type-options': 'nosniff',
              'x-xss-protection': '1; mode=block',
            },
          },
          'http://example.com/': { status: 301, location: 'https://example.com/' },
        },
      }),
    );

    expect(findingCodes(result)).toEqual(['dead_headers_present']);
    expect(text(result)).not.toContain('X-XSS-Protection is missing');
  });

  it('fails when the site cannot be reached at all', async () => {
    const result = await runUptimeCheck(
      { url: 'https://example.com/' },
      fakePorts({ hops: { 'https://example.com/': new Error('ECONNREFUSED') } }),
    );

    expect(result.isError).toBe(true);
  });

  it('rejects input that is not a URL', async () => {
    expect((await runUptimeCheck({ url: '   ' }, fakePorts())).isError).toBe(true);
    expect((await runUptimeCheck({ url: 'http://' }, fakePorts())).isError).toBe(true);
  });
});
