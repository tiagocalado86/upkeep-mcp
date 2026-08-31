import { describe, expect, it } from 'vitest';
import { CERT_EXPIRY_WARNING_DAYS, DOMAIN_EXPIRY_WARNING_DAYS } from '../../src/lib/defaults.js';
import {
  daysUntil,
  expirySeverity,
  finding,
  sortFindings,
  worstSeverity,
} from '../../src/lib/severity.js';

const now = new Date('2026-08-31T12:00:00.000Z');

describe('daysUntil', () => {
  it('counts whole days ahead', () => {
    expect(daysUntil('2026-09-30T12:00:00.000Z', now)).toBe(30);
  });

  it('floors rather than rounds, so an expiry later today reads as 0', () => {
    expect(daysUntil('2026-08-31T12:30:00.000Z', now)).toBe(0);
    expect(daysUntil('2026-08-31T23:59:59.000Z', now)).toBe(0);
  });

  it('goes negative once the date has passed', () => {
    expect(daysUntil('2026-08-30T12:00:00.000Z', now)).toBe(-1);
  });

  it('is null for an absent or unparseable date', () => {
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil('not a date', now)).toBeNull();
  });

  it('measures across timezone offsets correctly', () => {
    // Same instant as 2026-09-30T12:00:00Z, written with an offset.
    expect(daysUntil('2026-09-30T14:00:00+02:00', now)).toBe(30);
  });
});

describe('expirySeverity', () => {
  it('is unknown when there is no date, not ok', () => {
    expect(expirySeverity(null, DOMAIN_EXPIRY_WARNING_DAYS)).toBe('unknown');
  });

  it('is critical once expired', () => {
    expect(expirySeverity(-1, DOMAIN_EXPIRY_WARNING_DAYS)).toBe('critical');
  });

  it('is critical within a week', () => {
    expect(expirySeverity(0, DOMAIN_EXPIRY_WARNING_DAYS)).toBe('critical');
    expect(expirySeverity(7, DOMAIN_EXPIRY_WARNING_DAYS)).toBe('critical');
  });

  it('is a warning inside the warning window', () => {
    expect(expirySeverity(8, DOMAIN_EXPIRY_WARNING_DAYS)).toBe('warning');
    expect(expirySeverity(30, DOMAIN_EXPIRY_WARNING_DAYS)).toBe('warning');
  });

  it('is ok beyond the window', () => {
    expect(expirySeverity(31, DOMAIN_EXPIRY_WARNING_DAYS)).toBe('ok');
  });

  it('honours a caller-supplied window', () => {
    expect(expirySeverity(45, 60)).toBe('warning');
    expect(expirySeverity(45, 30)).toBe('ok');
  });

  it('leaves a certificate mid-ACME-renewal alone but flags a domain at the same distance', () => {
    // 28 days is where a certbot renewal normally happens, and it is also close
    // enough that a manual domain renewal must be chased.
    expect(expirySeverity(28, CERT_EXPIRY_WARNING_DAYS)).toBe('ok');
    expect(expirySeverity(28, DOMAIN_EXPIRY_WARNING_DAYS)).toBe('warning');
  });
});

describe('sortFindings', () => {
  it('puts the worst first', () => {
    const sorted = sortFindings([
      finding('c', 'info', 'c'),
      finding('a', 'critical', 'a'),
      finding('b', 'warning', 'b'),
      finding('d', 'ok', 'd'),
    ]);
    expect(sorted.map((item) => item.code)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sorts unknown below warning, since not knowing must not outrank a fact', () => {
    const sorted = sortFindings([
      finding('unknown', 'unknown', 'u'),
      finding('warning', 'warning', 'w'),
      finding('info', 'info', 'i'),
    ]);
    expect(sorted.map((item) => item.code)).toEqual(['warning', 'unknown', 'info']);
  });

  it('keeps ties in the order they were found', () => {
    const sorted = sortFindings([
      finding('first', 'warning', 'a'),
      finding('second', 'warning', 'b'),
      finding('third', 'warning', 'c'),
    ]);
    expect(sorted.map((item) => item.code)).toEqual(['first', 'second', 'third']);
  });

  it('does not mutate its argument', () => {
    const original = [finding('a', 'info', 'a'), finding('b', 'critical', 'b')];
    sortFindings(original);
    expect(original.map((item) => item.code)).toEqual(['a', 'b']);
  });
});

describe('worstSeverity', () => {
  it('is ok when there is nothing to report', () => {
    expect(worstSeverity([])).toBe('ok');
  });

  it('picks the highest-ranked severity present', () => {
    expect(
      worstSeverity([
        { code: 'a', severity: 'info', message: '' },
        { code: 'b', severity: 'critical', message: '' },
        { code: 'c', severity: 'warning', message: '' },
      ]),
    ).toBe('critical');
  });

  it('ranks unknown below warning, so not knowing never outranks a fact', () => {
    expect(
      worstSeverity([
        { code: 'a', severity: 'unknown', message: '' },
        { code: 'b', severity: 'warning', message: '' },
      ]),
    ).toBe('warning');
  });

  it('ranks unknown above info', () => {
    expect(
      worstSeverity([
        { code: 'a', severity: 'unknown', message: '' },
        { code: 'b', severity: 'info', message: '' },
      ]),
    ).toBe('unknown');
  });
});
