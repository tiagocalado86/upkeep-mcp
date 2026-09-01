import { describe, expect, it, vi } from 'vitest';
import { CheckError } from '../../src/lib/errors.js';
import { allowAnyTarget, allowOnlyPublicTargets } from '../../src/lib/public-target.js';

/** A resolver that answers from a table, and fails the test if asked anything else. */
function resolver(table: Record<string, string[]>): (hostname: string) => Promise<string[]> {
  return (hostname) => Promise.resolve(table[hostname] ?? []);
}

describe('allowOnlyPublicTargets', () => {
  it('allows a name that resolves to public addresses', async () => {
    const guard = allowOnlyPublicTargets(resolver({ 'example.com': ['93.184.216.34'] }));

    await expect(guard.assertPublic('example.com')).resolves.toBeUndefined();
  });

  it('refuses a literal private address without asking a resolver', async () => {
    const resolve = vi.fn(() => Promise.resolve(['1.1.1.1']));
    const guard = allowOnlyPublicTargets(resolve);

    // Resolving `127.0.0.1` would fail rather than answer, and the failure
    // would read as an unreachable host instead of a refused one.
    await expect(guard.assertPublic('127.0.0.1')).rejects.toThrow(/not on it/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses the cloud metadata address by name as well as by number', async () => {
    const guard = allowOnlyPublicTargets(resolver({ 'metadata.internal': ['169.254.169.254'] }));

    const error = await guard.assertPublic('metadata.internal').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CheckError);
    expect((error as CheckError).code).toBe('invalid_input');
    expect((error as CheckError).message).toContain('metadata');
  });

  it('refuses a name that resolves to both a public and a private address', async () => {
    // Answering with one of each is the standard way past a check that stops at
    // the first address.
    const guard = allowOnlyPublicTargets(
      resolver({ 'split.example': ['93.184.216.34', '10.0.0.5'] }),
    );

    await expect(guard.assertPublic('split.example')).rejects.toThrow(/10\.0\.0\.5/);
  });

  it('refuses a name that resolves to nothing, as not found rather than as private', async () => {
    const guard = allowOnlyPublicTargets(resolver({}));

    const error = await guard.assertPublic('nowhere.example').catch((cause: unknown) => cause);
    expect((error as CheckError).code).toBe('not_found');
  });

  it('handles a bracketed IPv6 literal', async () => {
    const guard = allowOnlyPublicTargets(resolver({}));

    await expect(guard.assertPublic('[::1]')).rejects.toThrow(/loopback/);
    await expect(
      guard.assertPublic('[2606:2800:220:1:248:1893:25c8:1946]'),
    ).resolves.toBeUndefined();
  });

  it('opens no port but 443', () => {
    const guard = allowOnlyPublicTargets(resolver({}));

    expect(() => {
      guard.assertPort(443);
    }).not.toThrow();
    // A public endpoint that connects to any port on request is a port scanner
    // wearing this project's user agent.
    expect(() => {
      guard.assertPort(8443);
    }).toThrow(/port scanner/);
    expect(() => {
      guard.assertPort(22);
    }).toThrow(/port scanner/);
  });
});

describe('allowAnyTarget', () => {
  it('allows what a local operator asks for, including their own network', async () => {
    const guard = allowAnyTarget();

    // A staging box on the local network is exactly what a maintenance tool is
    // for, when the person running it owns the network.
    await expect(guard.assertPublic('192.168.1.10')).resolves.toBeUndefined();
    await expect(guard.assertPublic('localhost')).resolves.toBeUndefined();
    expect(() => {
      guard.assertPort(8443);
    }).not.toThrow();
  });
});
