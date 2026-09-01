import { describe, expect, it } from 'vitest';
import type { AxeViolation } from '../../src/lib/axe.js';
import { CheckError } from '../../src/lib/errors.js';
import { runAccessibilityAudit } from '../../src/tools/accessibility-audit.js';
import { axeRun, fakePorts, findingCodes, structured, text } from '../helpers/fake-ports.js';

const PAGE = 'https://example.com/';

/** One axe violation, as a base for cases to override. */
function violation(overrides: Partial<AxeViolation> = {}): AxeViolation {
  return {
    id: 'color-contrast',
    impact: 'serious',
    help: 'Elements must have sufficient colour contrast',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.13/color-contrast',
    tags: ['wcag2aa', 'wcag143'],
    nodeCount: 3,
    selectors: ['.banner > p', 'footer a'],
    ...overrides,
  };
}

describe('runAccessibilityAudit', () => {
  it('reports a page that fails nothing, without calling it accessible', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({ axe: axeRun({ passCount: 42 }) }),
    );

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      audited: true,
      standard: 'wcag2aa',
      violationCount: 0,
      passCount: 42,
    });
    // Automated rules find about a third of the problems, and the wording has
    // to carry that or the report overstates itself.
    expect(findingCodes(result)).toContain('a11y_automated_checks_passed');
    expect(text(result)).toContain('roughly a third');
  });

  it('maps axe impacts onto the severities this project reports', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({
        axe: axeRun({
          violations: [
            violation({ id: 'image-alt', impact: 'critical', nodeCount: 2 }),
            violation({ id: 'color-contrast', impact: 'serious', nodeCount: 5 }),
            violation({ id: 'region', impact: 'moderate', nodeCount: 1 }),
            violation({ id: 'landmark-one-main', impact: 'minor', nodeCount: 1 }),
          ],
        }),
      }),
    );

    const findings = structured(result)['findings'] as { code: string; severity: string }[];
    expect(findings.map((item) => item.severity)).toEqual([
      'critical',
      'warning',
      'warning',
      'info',
    ]);
    expect(structured(result)['severity']).toBe('critical');
    expect(structured(result)['affectedElements']).toBe(9);
  });

  it('puts the worst impact first, then the one affecting most elements', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({
        axe: axeRun({
          violations: [
            violation({ id: 'minor-rule', impact: 'minor', nodeCount: 40 }),
            violation({ id: 'critical-few', impact: 'critical', nodeCount: 1 }),
            violation({ id: 'critical-many', impact: 'critical', nodeCount: 9 }),
          ],
        }),
      }),
    );

    const violations = structured(result)['violations'] as { id: string }[];
    expect(violations.map((item) => item.id)).toEqual([
      'critical-many',
      'critical-few',
      'minor-rule',
    ]);
  });

  it('reports rules it could not decide, without putting the site in the unknown column', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({ axe: axeRun({ incompleteCount: 4 }) }),
    );

    const findings = structured(result)['findings'] as { code: string; severity: string }[];
    const review = findings.find((item) => item.code === 'a11y_needs_review');

    // Said out loud, because they are the rules needing a person — but `info`,
    // not `unknown`: contrast against a background image is incomplete on most
    // real pages, and `unknown` is the column a portfolio reserves for checks
    // that could not run at all.
    expect(review?.severity).toBe('info');
    expect(structured(result)['severity']).not.toBe('unknown');
    expect(structured(result)['incompleteCount']).toBe(4);
  });

  it('keeps the error category the failure carried, rather than re-reading its prose', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      // What the public instance's target guard raises for a redirect into
      // private space. Classifying it by message would report it as `network`.
      fakePorts({
        axe: new CheckError('invalid_input', 'this server only contacts the public internet'),
      }),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('invalid_input');
  });

  it('passes a timeout through as a timeout', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({ axe: new CheckError('timeout', 'auditing did not finish within 45s') }),
    );

    expect(text(result)).toContain('timeout');
  });

  it('summarises the tail rather than emitting a finding per rule', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({
        axe: axeRun({
          violations: Array.from({ length: 14 }, (_, index) =>
            violation({ id: `rule-${String(index)}`, impact: 'minor' }),
          ),
        }),
      }),
    );

    expect(findingCodes(result)).toContain('a11y_further_violations');
    expect(structured(result)['violationCount']).toBe(14);
    // All fourteen are still in the structured output; only the findings list
    // is trimmed, because a person reads that one.
    expect((structured(result)['violations'] as unknown[]).length).toBe(14);
  });

  it('names the command that installs a browser when none is there', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({
        axe: new CheckError(
          'not_found',
          'no browser is installed for this check; run `npx playwright install chromium` once, or use the other tools, which need none',
        ),
      }),
    );

    // The whole point of scheduling this tool last: it degrades to an
    // actionable message and takes nothing else down with it.
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('npx playwright install chromium');
    expect(text(result)).toContain('not_found');
  });

  it('does not open a page robots.txt forbids', async () => {
    const result = await runAccessibilityAudit(
      { url: 'https://example.com/private' },
      // No axe fixture: opening the page would reject and fail this test.
      fakePorts({ robots: 'User-agent: *\nDisallow: /private' }),
    );

    expect(result.isError).toBeFalsy();
    expect(structured(result)['audited']).toBe(false);
    expect(findingCodes(result)).toEqual(['page_disallowed_by_robots']);
  });

  it('selects cumulative rule sets, so asking for AA still reports A failures', async () => {
    const seen: string[][] = [];
    const ports = fakePorts({ axe: axeRun() });
    ports.browser.audit = (_url, tags) => {
      seen.push([...tags]);
      return Promise.resolve(axeRun());
    };

    await runAccessibilityAudit({ url: PAGE, standard: 'wcag22aa' }, ports);

    expect(seen[0]).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  });

  it('rejects a URL it cannot make sense of', async () => {
    const result = await runAccessibilityAudit({ url: '  ' }, fakePorts());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('invalid_input');
  });
});
