import { describe, expect, it } from 'vitest';
import { rejectPrivateAddress } from '../../src/lib/address.js';

describe('rejectPrivateAddress', () => {
  it('accepts ordinary public addresses', () => {
    for (const address of [
      '1.1.1.1',
      '93.184.216.34',
      '8.8.8.8',
      '2606:2800:220:1:248:1893:25c8:1946',
    ]) {
      expect(rejectPrivateAddress(address), address).toBeNull();
    }
  });

  it('rejects the cloud metadata address, which is the whole point', () => {
    // http://169.254.169.254/latest/meta-data/ is the first thing anyone tries
    // against a service that fetches URLs on request.
    expect(rejectPrivateAddress('169.254.169.254')).toContain('metadata');
  });

  it('rejects loopback, however it is spelled', () => {
    expect(rejectPrivateAddress('127.0.0.1')).toBe('loopback');
    expect(rejectPrivateAddress('127.1.2.3')).toBe('loopback');
    expect(rejectPrivateAddress('::1')).toBe('loopback');
    // An IPv4-mapped address reaches an IPv4 destination and is judged as one.
    expect(rejectPrivateAddress('::ffff:127.0.0.1')).toBe('loopback');
  });

  it('rejects every private IPv4 range, at both edges', () => {
    for (const address of [
      '10.0.0.0',
      '10.255.255.255',
      '172.16.0.0',
      '172.31.255.255',
      '192.168.0.0',
      '192.168.255.255',
    ]) {
      expect(rejectPrivateAddress(address), address).toBe('a private network');
    }
  });

  it('lets the addresses just outside those ranges through', () => {
    // The edges are where an off-by-one in the prefix arithmetic shows up.
    for (const address of [
      '9.255.255.255',
      '11.0.0.0',
      '172.15.255.255',
      '172.32.0.0',
      '192.167.255.255',
      '192.169.0.0',
    ]) {
      expect(rejectPrivateAddress(address), address).toBeNull();
    }
  });

  it('rejects the other ranges that are not public unicast', () => {
    expect(rejectPrivateAddress('0.0.0.0')).toContain('unspecified');
    expect(rejectPrivateAddress('100.64.0.1')).toContain('NAT');
    expect(rejectPrivateAddress('198.18.0.1')).toContain('benchmarking');
    expect(rejectPrivateAddress('224.0.0.1')).toBe('multicast');
    expect(rejectPrivateAddress('240.0.0.1')).toContain('reserved');
    // The broadcast address sits inside 240.0.0.0/4, so it needs no rule of
    // its own — but it must still be refused.
    expect(rejectPrivateAddress('255.255.255.255')).toContain('reserved');
  });

  it('rejects IPv6 unique local, link-local and multicast', () => {
    expect(rejectPrivateAddress('fd00::1')).toContain('unique local');
    expect(rejectPrivateAddress('fc00::1')).toContain('unique local');
    expect(rejectPrivateAddress('fe80::1')).toBe('link-local');
    expect(rejectPrivateAddress('fe80::1%eth0')).toBe('link-local');
    expect(rejectPrivateAddress('ff02::1')).toBe('multicast');
    expect(rejectPrivateAddress('::')).toContain('unspecified');
  });

  it('rejects anything it cannot parse, rather than assuming it is fine', () => {
    for (const value of ['', 'example.com', '999.1.1.1', '1.2.3', 'not an address', '::gggg']) {
      expect(rejectPrivateAddress(value), value).toBe('it is not a recognisable IP address');
    }
  });
});
