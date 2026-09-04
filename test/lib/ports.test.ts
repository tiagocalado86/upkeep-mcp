import { describe, expect, it } from 'vitest';
import { CheckError } from '../../src/lib/errors.js';
import { createDefaultPorts, foundAnything, rethrowForRemoteCaller } from '../../src/lib/ports.js';
import { emptyDns, healthyDns } from '../helpers/fake-ports.js';

describe('foundAnything', () => {
  it('is false for a name that returned nothing at all', () => {
    // This is the NXDOMAIN case: every record set comes back empty and the
    // lookup itself succeeded, so without this the answer would be cached as
    // confidently as a real one.
    expect(foundAnything(emptyDns())).toBe(false);
  });

  it('is true for a domain that resolves', () => {
    expect(foundAnything(healthyDns())).toBe(true);
  });

  it('is true for a domain that exists but serves nothing', () => {
    // A parked or mail-only domain has nameservers, or an MX, and no addresses.
    // It exists, and its answer is worth the full lifetime.
    expect(foundAnything({ ...emptyDns(), ns: ['ns1.example.net'] })).toBe(true);
    expect(foundAnything({ ...emptyDns(), mx: [{ exchange: 'mx.example', priority: 10 }] })).toBe(
      true,
    );
    expect(foundAnything({ ...emptyDns(), txt: ['v=spf1 -all'] })).toBe(true);
  });

  it('is true when only the www sibling resolves', () => {
    expect(foundAnything({ ...emptyDns(), wwwResolves: true })).toBe(true);
  });
});

describe('createDefaultPorts with publicTargetsOnly', () => {
  // The guard was wired into the TLS path and nowhere else, so a public
  // instance would have fetched `https://host:22/` and reported back whether
  // the connection was refused. The policy was right; only the wiring was
  // missing, so this asserts the wiring, on every path that leaves the process.
  //
  // The target is an RFC 5737 documentation address: public as far as the
  // guard is concerned, needs no lookup because it is a literal, and is never
  // contacted because the port is refused first.
  const ports = createDefaultPorts({ publicTargetsOnly: true });

  it('refuses a port that is not a web port, on every outbound path', async () => {
    await expect(ports.http.hop('https://192.0.2.1:22/', 1000)).rejects.toThrow(/port scanner/);
    await expect(ports.http.text('https://192.0.2.1:3306/', 1000, 1000)).rejects.toThrow(
      /port scanner/,
    );
    await expect(ports.robots.forOrigin('https://192.0.2.1:8080')).rejects.toThrow(/port scanner/);
    await expect(ports.browser.audit('https://192.0.2.1:9222/', ['wcag2a'])).rejects.toThrow(
      /port scanner/,
    );
    await expect(ports.tls.inspect('192.0.2.1', 22, ['192.0.2.1'])).rejects.toThrow(/port scanner/);
  });

  it('refuses port 443 over plain HTTP, and 80 over HTTPS', async () => {
    await expect(ports.http.hop('http://192.0.2.1:443/', 1000)).rejects.toThrow(/port scanner/);
    await expect(ports.http.hop('https://192.0.2.1:80/', 1000)).rejects.toThrow(/port scanner/);
  });
});

describe('rethrowForRemoteCaller', () => {
  // The published container ships no browser on purpose (ADR 0013), so on a
  // hosted instance this is the failure people actually meet — and the advice
  // it carried, `npx playwright install chromium`, is for a machine they do
  // not have. It read as a broken deployment rather than as a documented limit.
  it('tells a remote caller to run the server themselves', () => {
    const missing = new CheckError(
      'not_found',
      'no browser is installed for this check; run `npx playwright install chromium` once',
    );

    expect(() => {
      rethrowForRemoteCaller(missing);
    }).toThrow(/run the server on your own machine/);
  });

  it('keeps the code, and the original failure as the cause', () => {
    const missing = new CheckError('not_found', 'no browser is installed for this check');

    try {
      rethrowForRemoteCaller(missing);
      expect.unreachable('it must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CheckError);
      expect((error as CheckError).code).toBe('not_found');
      expect((error as CheckError).cause).toBe(missing);
    }
  });

  it('passes every other failure through untouched', () => {
    // A page that would not load, or a target the guard refused, has nothing to
    // do with the browser being absent and must keep its own message.
    const timeout = new CheckError(
      'timeout',
      'https://example.com did not finish loading within 20s',
    );
    expect(() => {
      rethrowForRemoteCaller(timeout);
    }).toThrow(timeout);

    const odd = new Error('boom');
    expect(() => {
      rethrowForRemoteCaller(odd);
    }).toThrow(odd);
  });
});
