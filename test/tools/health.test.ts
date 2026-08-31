import { describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION } from '../../src/lib/constants.js';
import { buildHealthReport } from '../../src/tools/health.js';

describe('buildHealthReport', () => {
  it('reports the server identity used in the MCP handshake', () => {
    const report = buildHealthReport();

    expect(report.status).toBe('ok');
    expect(report.server).toBe(SERVER_NAME);
    expect(report.version).toBe(SERVER_VERSION);
  });

  it('reports the running Node.js version', () => {
    expect(buildHealthReport().node).toBe(process.version);
  });

  it('reports uptime as a whole number of seconds', () => {
    const { uptimeSeconds } = buildHealthReport();

    expect(Number.isInteger(uptimeSeconds)).toBe(true);
    expect(uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('timestamps the report in ISO 8601 with a timezone', () => {
    const { checkedAt } = buildHealthReport();

    expect(checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(new Date(checkedAt).toISOString()).toBe(checkedAt);
  });
});
