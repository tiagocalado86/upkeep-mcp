import type { DetailedPeerCertificate } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { walkChain } from '../../src/lib/tls.js';

/**
 * Builds a certificate the way `getPeerCertificate(true)` returns one — only
 * the fields this project reads.
 */
function certificate(
  subject: string,
  issuer: string,
  overrides: Partial<DetailedPeerCertificate> = {},
): DetailedPeerCertificate {
  return {
    subject: { CN: subject },
    issuer: { CN: issuer },
    serialNumber: 'AABB',
    // Distinct per certificate: the walk uses the fingerprint to notice it has
    // come back round to one it has already summarised.
    fingerprint256: `AA:BB:${subject}`,
    valid_from: 'Jul  1 00:00:00 2026 GMT',
    valid_to: 'Dec  1 00:00:00 2026 GMT',
    ...overrides,
  } as DetailedPeerCertificate;
}

describe('walkChain', () => {
  it('summarises a chain from the leaf upwards', () => {
    const root = certificate('ISRG Root X1', 'ISRG Root X1');
    // A verified chain terminates in a self-signed root pointing at itself.
    (root as { issuerCertificate?: unknown }).issuerCertificate = root;
    const intermediate = certificate('R11', 'ISRG Root X1', {
      issuerCertificate: root,
    });
    const leaf = certificate('example.com', 'R11', {
      issuerCertificate: intermediate,
    });

    const chain = walkChain(leaf);

    expect(chain.map((entry) => entry.subject)).toEqual(['example.com', 'R11', 'ISRG Root X1']);
    expect(chain[0]).toMatchObject({
      issuer: 'R11',
      serialNumber: 'AABB',
      fingerprintSha256: 'AA:BB:example.com',
      validFrom: '2026-07-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
    });
  });

  it('stops at a self-signed leaf, which points at itself from depth zero', () => {
    const leaf = certificate('self.example', 'self.example');
    (leaf as { issuerCertificate?: unknown }).issuerCertificate = leaf;

    expect(walkChain(leaf)).toHaveLength(1);
  });

  it('stops when the intermediate is missing, which is the misconfiguration to catch', () => {
    const leaf = certificate('example.com', 'R11');

    expect(walkChain(leaf).map((entry) => entry.subject)).toEqual(['example.com']);
  });

  it('falls back to the first SAN when a certificate has no common name', () => {
    const leaf = certificate('', 'R11', {
      subject: {},
      subjectaltname: 'DNS:example.com, DNS:www.example.com',
    });

    expect(walkChain(leaf)[0]?.subject).toBe('example.com');
  });

  it('returns nothing when no certificate was presented at all', () => {
    expect(walkChain({} as DetailedPeerCertificate)).toEqual([]);
  });

  it('reports an unparseable date as null rather than as an invalid date', () => {
    const leaf = certificate('example.com', 'R11', {
      valid_to: 'not a date',
    });

    expect(walkChain(leaf)[0]?.validTo).toBeNull();
  });
});
