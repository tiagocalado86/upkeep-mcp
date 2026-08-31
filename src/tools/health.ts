import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { SERVER_NAME, SERVER_VERSION } from '../lib/constants.js';
import { guard, succeed } from '../lib/tool-result.js';
import type { HealthReport } from '../types.js';

const outputSchema = z.object({
  status: z.literal('ok').describe('Always "ok". If the server can answer, it is healthy.'),
  server: z.string().describe('Server name, e.g. "upkeep-mcp".'),
  version: z.string().describe('Server version, e.g. "0.1.0".'),
  node: z.string().describe('Node.js version the server runs under, e.g. "v20.11.0".'),
  uptimeSeconds: z.number().int().describe('Whole seconds since the server process started.'),
  checkedAt: z.iso.datetime().describe('When the report was produced, ISO 8601 with timezone.'),
});

/**
 * Produces a liveness report for the running server.
 *
 * @returns The current {@link HealthReport}.
 * @throws Never.
 */
export function buildHealthReport(): HealthReport {
  return {
    status: 'ok',
    server: SERVER_NAME,
    version: SERVER_VERSION,
    node: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Registers the `health` tool on an {@link McpServer}.
 *
 * @param server The server to register on.
 * @throws Never.
 */
export function registerHealthTool(server: McpServer): void {
  server.registerTool(
    'health',
    {
      title: 'Server health',
      description: [
        'Confirms that the upkeep-mcp server is running and reports which version it is.',
        '',
        'Use this to verify the connection after installing or reconfiguring the server, or',
        'when another upkeep-mcp tool behaves unexpectedly and you need to establish whether',
        'the server itself is reachable.',
        '',
        'Do not use it to check whether a website is up — it says nothing about any domain or',
        'URL, only about this server process. Use uptime_check for websites.',
        '',
        'Returns the server name and version, the Node.js version it runs under, how long the',
        'process has been alive, and the time of the check.',
      ].join('\n'),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    guard(() => {
      const report = buildHealthReport();
      const text = [
        `${report.server} ${report.version} is running.`,
        `Node ${report.node}, up ${String(report.uptimeSeconds)}s, checked at ${report.checkedAt}.`,
      ].join('\n');
      return succeed(text, report);
    }),
  );
}
