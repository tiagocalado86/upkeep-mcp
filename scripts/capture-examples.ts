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
console.error('captured');
