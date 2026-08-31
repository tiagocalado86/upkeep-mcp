import { describe, expect, it } from 'vitest';
import { parseTarget } from '../../src/lib/domain-name.js';

/**
 * @param input Whatever a caller might pass.
 * @returns The parsed target, failing the test if it did not parse.
 */
function ok(input: string): Extract<ReturnType<typeof parseTarget>, { ok: true }> {
  const result = parseTarget(input);
  if (!result.ok) throw new Error(`expected "${input}" to parse, got: ${result.reason}`);
  return result;
}

describe('parseTarget', () => {
  it('accepts a bare domain', () => {
    expect(ok('example.com')).toMatchObject({
      ascii: 'example.com',
      unicode: null,
      registrable: 'example.com',
      isIp: false,
    });
  });

  it('lowercases and drops a trailing dot', () => {
    expect(ok('EXAMPLE.COM.').ascii).toBe('example.com');
  });

  it('reduces a full URL to its hostname', () => {
    expect(ok('https://www.example.com/pricing?a=1#top').ascii).toBe('www.example.com');
  });

  it('strips a port and a path from a bare host', () => {
    expect(ok('example.com:8443').ascii).toBe('example.com');
    expect(ok('example.com/some/path').ascii).toBe('example.com');
  });

  it('strips userinfo, which a URL may carry', () => {
    expect(ok('https://user:pass@example.com/').ascii).toBe('example.com');
  });

  it('converts an internationalised name to A-labels and keeps the Unicode form', () => {
    // tls.connect's servername rejects U-labels, so this conversion is what stops
    // a domain resolving fine and then failing the TLS handshake.
    expect(ok('café.pt')).toMatchObject({ ascii: 'xn--caf-dma.pt', unicode: 'café.pt' });
    expect(ok('bücher.de').ascii).toBe('xn--bcher-kva.de');
  });

  it('reduces a subdomain to its registrable domain', () => {
    expect(ok('www.shop.example.co.uk').registrable).toBe('example.co.uk');
    expect(ok('blog.example.org').registrable).toBe('example.org');
  });

  it('recognises IPv4 and IPv6 literals, which have no registration', () => {
    expect(ok('192.0.2.1')).toMatchObject({ isIp: true, registrable: null });
    expect(ok('https://[2001:db8::1]/')).toMatchObject({ ascii: '2001:db8::1', isIp: true });
  });

  it('rejects empty input', () => {
    expect(parseTarget('   ')).toMatchObject({ ok: false });
  });

  it('rejects a single label, which cannot be a registrable domain', () => {
    expect(parseTarget('localhost')).toMatchObject({ ok: false });
  });

  it('rejects an empty label', () => {
    // domainToASCII returns 'a..b' unchanged rather than '', so the empty-string
    // test alone would let this through.
    expect(parseTarget('a..b')).toMatchObject({ ok: false });
  });

  it('rejects labels with illegal characters', () => {
    expect(parseTarget('exa mple.com')).toMatchObject({ ok: false });
    expect(parseTarget('-example.com')).toMatchObject({ ok: false });
  });

  it('rejects a label over 63 characters', () => {
    expect(parseTarget(`${'a'.repeat(64)}.com`)).toMatchObject({ ok: false });
  });

  it('explains why it rejected something', () => {
    const result = parseTarget('localhost');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('localhost');
  });
});
