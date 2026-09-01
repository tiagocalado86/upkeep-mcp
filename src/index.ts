#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { SERVER_NAME, SERVER_VERSION } from './lib/constants.js';
import { createServer } from './server.js';

// Wrapped rather than passed directly: the factory is handed a request context,
// and `createServer` takes ports.
serveStdio(() => createServer());

// stdout is the JSON-RPC channel on this transport: a single console.log would
// corrupt the stream. All diagnostics go to stderr.
console.error(`${SERVER_NAME} ${SERVER_VERSION} running on stdio`);
