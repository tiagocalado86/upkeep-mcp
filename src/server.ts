import { McpServer } from '@modelcontextprotocol/server';
import { SERVER_NAME, SERVER_VERSION } from './lib/constants.js';
import { registerDomainCheckTool } from './tools/domain-check.js';
import { registerQuarterlyReportPrompt } from './prompts/quarterly-report.js';
import { registerPortfolioSitesResource } from './resources/portfolio-sites.js';
import { registerHealthTool } from './tools/health.js';
import { registerPortfolioReportTool } from './tools/portfolio-report.js';
import { registerSeoAuditTool } from './tools/seo-audit.js';
import { registerSslCheckTool } from './tools/ssl-check.js';
import { registerUptimeCheckTool } from './tools/uptime-check.js';

/**
 * Builds a fully configured server instance with every tool registered.
 *
 * This is a factory rather than a shared singleton because the transport
 * entrypoints instantiate one server per connection: two clients must not share
 * mutable per-connection state.
 *
 * @returns A ready-to-serve {@link McpServer}.
 * @throws Never.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerHealthTool(server);
  registerDomainCheckTool(server);
  registerSslCheckTool(server);
  registerUptimeCheckTool(server);
  registerSeoAuditTool(server);
  registerPortfolioReportTool(server);

  registerPortfolioSitesResource(server);
  registerQuarterlyReportPrompt(server);

  return server;
}
