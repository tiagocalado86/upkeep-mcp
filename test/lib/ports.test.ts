import { describe, expect, it } from 'vitest';
import { foundAnything } from '../../src/lib/ports.js';
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
