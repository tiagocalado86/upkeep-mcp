import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION } from '../src/lib/constants.js';

/**
 * The HTTP entrypoint, driven over a real socket.
 *
 * It binds a loopback port and speaks to itself; it reaches nothing else,
 * because the entrypoint's own guard refuses every target that is not public —
 * which is one of the things asserted here.
 */
const PROTOCOL_VERSION = '2026-07-28';
const PORT = 8791;
const BASE = `http://127.0.0.1:${String(PORT)}`;

const repoRoot = new URL('..', import.meta.url);
const tsx = fileURLToPath(new URL('node_modules/tsx/dist/cli.mjs', repoRoot));
const entrypoint = fileURLToPath(new URL('src/http.ts', repoRoot));

let child: ChildProcessWithoutNullStreams;

/** Sends one JSON-RPC request and reads the answer out of the event stream. */
async function call(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{
  status: number;
  body: { result?: Record<string, unknown>; error?: { message: string } };
}> {
  const response = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  const text = await response.text();
  const payload = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .join('');

  return {
    status: response.status,
    body: payload === '' ? {} : (JSON.parse(payload) as { result?: Record<string, unknown> }),
  };
}

/** Reads the text of a tool result, whatever it decided. */
function toolText(body: { result?: Record<string, unknown> }): string {
  const content = (body.result?.['content'] ?? []) as { text?: string }[];
  return content.map((block) => block.text ?? '').join('\n');
}

beforeAll(async () => {
  child = spawn(process.execPath, [tsx, entrypoint, '--port', String(PORT)], {
    cwd: fileURLToPath(repoRoot),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the server did not start within 20s'));
    }, 20_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (chunk.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  await call('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'http-test', version: '0.0.0' },
  });
}, 30_000);

afterAll(() => {
  child.kill();
});

describe('the HTTP entrypoint', () => {
  it('answers a browser with something a person can read', async () => {
    const response = await fetch(BASE);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain(`${SERVER_NAME} ${SERVER_VERSION}`);
    expect(text).toContain('/mcp');
  });

  it('answers an unknown path with 404, not with the landing page', async () => {
    // Answering everything with 200 told a crawler and a browser asking for a
    // favicon that they had found something.
    const response = await fetch(`${BASE}/favicon.ico`);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('/mcp');
  });

  it('serves the same tools as the stdio entrypoint', async () => {
    const { body } = await call('tools/list');
    const tools = (body.result?.['tools'] ?? []) as { name: string }[];

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'accessibility_audit',
      'domain_check',
      'health',
      'portfolio_report',
      'seo_audit',
      'ssl_check',
      'uptime_check',
    ]);
  });

  it('runs a tool that needs no network', async () => {
    const { body } = await call('tools/call', { name: 'health', arguments: {} });

    expect(toolText(body)).toContain(SERVER_VERSION);
  });

  it('refuses a target that is not on the public internet', async () => {
    // The whole reason this entrypoint builds its own ports.
    const { body } = await call('tools/call', {
      name: 'uptime_check',
      arguments: { url: `${BASE}/` },
    });

    expect(body.result?.['isError']).toBe(true);
    expect(toolText(body)).toContain('only contacts the public internet');
    expect(toolText(body)).toContain('loopback');
  });

  it('refuses to open a port other than 443', async () => {
    const { body } = await call('tools/call', {
      name: 'ssl_check',
      arguments: { domain: 'example.com', port: 8443 },
    });

    expect(body.result?.['isError']).toBe(true);
    expect(toolText(body)).toContain('port scanner');
  });

  it('rate limits a caller that spends its burst, without dropping the connection', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      statuses.push((await call('tools/list')).status);
    }

    // A refusal is an answer, not a closed socket: a client must be able to
    // read why it was turned away.
    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThan(0);
  }, 30_000);

  it('does not let open streams exhaust the concurrency cap', async () => {
    // The entrypoint holds a caller's concurrency slot until the response body
    // has finished writing. A response that never finishes would hold one for
    // ever, and twelve of them would close the instance to everybody — there is
    // no authentication in front of this.
    //
    // `subscriptions/listen` is the request that asks for such a stream. It is
    // refused with -32601 today, because `createServer` registers no
    // subscription capability. This test fails the day one is added without the
    // limiter learning to tell a long-lived stream from a request.
    const streams = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        fetch(`${BASE}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            // Distinct callers, so this measures the global concurrency cap and
            // not one caller's token bucket.
            'x-forwarded-for': `203.0.113.${String(index)}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 200 + index,
            method: 'subscriptions/listen',
            params: { notifications: { toolsListChanged: true } },
          }),
        }),
      ),
    );

    // Deliberately left unread: an unfinished body is the whole point.
    const stillServed = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-for': '203.0.113.200',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 299, method: 'tools/list', params: {} }),
    });

    expect(stillServed.status).toBe(200);

    await Promise.all(streams.map(async (stream) => stream.body?.cancel()));
    await stillServed.text();
  }, 30_000);
});
