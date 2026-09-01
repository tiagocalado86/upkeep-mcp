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

  it('serves the same tools as the stdio entrypoint', async () => {
    const { body } = await call('tools/list');
    const tools = (body.result?.['tools'] ?? []) as { name: string }[];

    expect(tools.map((tool) => tool.name).sort()).toEqual([
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
});
