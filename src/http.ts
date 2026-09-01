#!/usr/bin/env node
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { SERVER_NAME, SERVER_VERSION } from './lib/constants.js';
import { clientKey, createInboundLimiter } from './lib/inbound-limit.js';
import { createDefaultPorts } from './lib/ports.js';
import { createServer } from './server.js';

/**
 * The Streamable HTTP entrypoint, for a publicly reachable instance.
 *
 * Two things differ from the stdio entrypoint, and both are consequences of the
 * caller being a stranger rather than the person who started the process:
 * every tool is handed ports that refuse anything but public targets on port
 * 443 (`docs/adr/0012`), and inbound traffic is admitted through a per-client
 * token bucket with a global concurrency cap.
 *
 * The Node-to-web adaptation below is deliberately hand-written. The SDK
 * documents `toNodeHandler` from `@modelcontextprotocol/node` for this, and it
 * would be one more dependency to carry for sixty lines that this project can
 * own and test.
 *
 * The port is read from `--port`, never from the environment: a test asserts
 * that nothing under `src/` reads `process.env`, which is how "this server
 * needs no configuration and holds no secrets" stays a fact rather than a
 * claim. Cloud Run's default container port is 8080, which is this default.
 */

/** Where the MCP endpoint lives. Anything else gets the human-readable page. */
const MCP_PATH = '/mcp';

/** Most bytes accepted in one request body. MCP messages are small. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * How much traffic one demo instance will take.
 *
 * Sized for what a demo is: someone connects a client, lists the tools, calls
 * two or three. Sixty a minute is generous for that and useless for anyone
 * hoping to borrow the egress.
 */
const LIMITS = {
  perClientPerMinute: 60,
  burst: 20,
  maxConcurrent: 8,
  maxClients: 1000,
} as const;

const port = readPort(process.argv);
const ports = createDefaultPorts({ publicTargetsOnly: true });
const handler = createMcpHandler(() => createServer(ports));
const limiter = createInboundLimiter(LIMITS);

const server = createHttpServer((request, response) => {
  void route(request, response);
});

server.listen(port, () => {
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} listening on http://0.0.0.0:${String(port)}${MCP_PATH}`,
  );
});

/**
 * Routes one request: the landing page, or the MCP endpoint behind the limiter.
 *
 * @param request The incoming request.
 * @param response The response to write.
 * @returns Nothing; every failure is answered rather than thrown.
 * @throws Never.
 */
async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (url.pathname !== MCP_PATH) {
    respond(response, 200, 'text/plain; charset=utf-8', landingPage());
    return;
  }

  const admission = limiter.admit(
    clientKey(headerOf(request, 'x-forwarded-for'), request.socket.remoteAddress),
  );
  if (!admission.ok) {
    respond(response, admission.status, 'text/plain; charset=utf-8', `${admission.message}\n`);
    return;
  }

  try {
    const body = await readBody(request);
    if (body === null) {
      respond(response, 413, 'text/plain; charset=utf-8', 'request body too large\n');
      return;
    }

    const answer = await handler.fetch(toWebRequest(request, url, body));
    await writeResponse(response, answer);
  } catch (cause) {
    // Nothing may escape: an unhandled rejection here would take the process
    // down and the demo with it.
    console.error('request failed', cause);
    if (!response.headersSent) {
      respond(response, 500, 'text/plain; charset=utf-8', 'internal error\n');
    } else {
      response.end();
    }
  } finally {
    admission.release();
  }
}

/**
 * @param argv The process arguments.
 * @returns The port to listen on: `--port <n>`, or 8080.
 * @throws Never — an unusable value falls back to the default rather than
 *   refusing to start, because a demo that does not come up is worse than one
 *   on the wrong port.
 */
function readPort(argv: readonly string[]): number {
  const flag = argv.indexOf('--port');
  const value = flag === -1 ? undefined : argv[flag + 1];
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : 8080;
}

/**
 * @param request The incoming request.
 * @param name Header name, lowercase.
 * @returns The header value, joining repeats as the platform proxy would.
 * @throws Never.
 */
function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Reads a request body, refusing one that is too large.
 *
 * Buffered rather than streamed: MCP messages are small, and buffering is what
 * makes the size limit enforceable before anything is parsed.
 *
 * @param request The incoming request.
 * @returns The body, or `null` when it exceeded the limit.
 * @throws Whatever the socket throws.
 */
async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

/**
 * @param request The incoming request.
 * @param url Its parsed URL.
 * @param body Its body.
 * @returns The same request as a web-standard `Request`, which is what the
 *   SDK's handler speaks.
 * @throws Never.
 */
function toWebRequest(request: IncomingMessage, url: URL, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  const method = request.method ?? 'GET';
  return new Request(url, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
}

/**
 * Writes a web-standard `Response` to a Node response.
 *
 * Piped rather than buffered: the streamable transport answers with an
 * event stream, and buffering one would hold every notification until the
 * connection closed.
 *
 * @param response The Node response to write.
 * @param answer What the handler produced.
 * @returns Nothing.
 * @throws Whatever the socket throws.
 */
async function writeResponse(response: ServerResponse, answer: Response): Promise<void> {
  response.writeHead(answer.status, Object.fromEntries(answer.headers));

  const body = answer.body;
  if (body === null) {
    response.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(body).on('error', reject).pipe(response).on('finish', resolve);
  });
}

/**
 * @param response The response to write.
 * @param status HTTP status.
 * @param contentType Content type.
 * @param body The body.
 * @throws Never.
 */
function respond(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, { 'content-type': contentType });
  response.end(body);
}

/**
 * @returns What a person gets for pasting the URL into a browser. They are not
 *   the audience — an MCP client is — so it says what this is and where to
 *   point that client.
 * @throws Never.
 */
function landingPage(): string {
  return [
    `${SERVER_NAME} ${SERVER_VERSION}`,
    '',
    'A Model Context Protocol server for the recurring checks behind website',
    'maintenance: domains, SSL certificates, uptime and technical SEO.',
    '',
    `This is a demo instance. Point an MCP client at ${MCP_PATH} on this host.`,
    '',
    'It contacts only public addresses, and only the web ports. It rate limits',
    'every caller and stores nothing.',
    'Source: https://github.com/tiagocalado86/upkeep-mcp',
    '',
  ].join('\n');
}
