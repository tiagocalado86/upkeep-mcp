/**
 * Regenerates `examples/` from real requests against public control targets.
 *
 * Out-of-date documentation is worse than none, and hand-written example output
 * drifts the moment a message changes. Run `npm run examples` after any change
 * to what a tool returns.
 *
 * Targets are deliberately public and neutral: never point this at a client site.
 */
import { writeFileSync } from 'node:fs';
import { createDefaultPorts } from '../src/lib/ports.js';
import { runDomainCheck } from '../src/tools/domain-check.js';
import { runPortfolioReport } from '../src/tools/portfolio-report.js';
import { runSeoAudit } from '../src/tools/seo-audit.js';
import { runSslCheck } from '../src/tools/ssl-check.js';
import { runUptimeCheck } from '../src/tools/uptime-check.js';

const ports = createDefaultPorts();
const render = (
  title: string,
  call: string,
  result: { content: { type: string; text?: string }[]; structuredContent?: unknown },
): string =>
  [
    `# ${title}`,
    '',
    'Call:',
    '',
    '```json',
    call,
    '```',
    '',
    'Text returned to the conversation:',
    '',
    '```',
    result.content.map((c) => c.text ?? '').join('\n'),
    '```',
    '',
    'Structured content:',
    '',
    '```json',
    JSON.stringify(result.structuredContent, null, 2),
    '```',
    '',
  ].join('\n');

writeFileSync(
  'examples/domain-check.md',
  render(
    'domain_check',
    '{ "name": "domain_check", "arguments": { "domain": "example.com" } }',
    await runDomainCheck({ domain: 'example.com' }, ports),
  ),
);

writeFileSync(
  'examples/ssl-check.md',
  render(
    'ssl_check',
    '{ "name": "ssl_check", "arguments": { "domain": "expired.badssl.com" } }',
    await runSslCheck({ domain: 'expired.badssl.com' }, ports),
  ),
);

writeFileSync(
  'examples/uptime-check.md',
  render(
    'uptime_check',
    '{ "name": "uptime_check", "arguments": { "url": "http://github.com" } }',
    await runUptimeCheck({ url: 'http://github.com' }, ports),
  ),
);
writeFileSync(
  'examples/seo-audit.md',
  render(
    'seo_audit',
    '{ "name": "seo_audit", "arguments": { "url": "https://example.com/" } }',
    await runSeoAudit({ url: 'https://example.com/' }, ports),
  ),
);

// A portfolio of reserved, public domains. Never a client list: the checks are
// real requests, and this file is committed.
const examplePortfolio = [
  { name: 'Example Ltd', url: 'https://example.com', checks: ['domain', 'ssl', 'uptime'] as const },
  { name: 'Example Foundation', url: 'https://example.org', checks: ['domain', 'ssl'] as const },
  { name: 'Example Net', url: 'https://example.net', checks: ['uptime'] as const },
];

writeFileSync(
  'examples/portfolio-report.md',
  render(
    'portfolio_report',
    '{ "name": "portfolio_report", "arguments": { "sites": [ /* three public domains */ ] } }',
    await runPortfolioReport(
      { sites: examplePortfolio.map((site) => ({ ...site, checks: [...site.checks] })) },
      ports,
    ),
  ),
);

console.error('captured');
