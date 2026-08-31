import { McpServer } from '@modelcontextprotocol/server';
import { SERVER_NAME, SERVER_VERSION } from './lib/constants.js';
import { registerHealthTool } from './tools/health.js';

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

  return server;
}
