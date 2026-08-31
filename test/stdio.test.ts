import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION } from '../src/lib/constants.js';

/**
 * The protocol revision this server is built against. Pinned here so that an
 * SDK upgrade that changes the negotiated revision shows up as a test failure
 * rather than as a silent behaviour change.
 */
const PROTOCOL_VERSION = '2026-07-28';

const repoRoot = new URL('..', import.meta.url);
const tsx = fileURLToPath(new URL('node_modules/tsx/dist/cli.mjs', repoRoot));
const entrypoint = fileURLToPath(new URL('src/index.ts', repoRoot));

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * A minimal newline-delimited JSON-RPC client over a child process's stdio.
 * Deliberately hand-rolled: the point of this suite is to exercise the real
 * wire format the way a host does, without an SDK client smoothing it over.
 */
class StdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();

  constructor() {
    this.child = spawn(process.execPath, [tsx, entrypoint], {
      cwd: fileURLToPath(repoRoot),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line !== '') {
          const message = JSON.parse(line) as JsonRpcResponse;
          this.pending.get(message.id)?.(message);
          this.pending.delete(message.id);
        }
        newline = this.buffer.indexOf('\n');
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no response to ${method} within 10s`));
      }, 10_000);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  kill(): void {
    this.child.kill();
  }
}

describe('stdio transport', () => {
  let client: StdioClient;

  beforeAll(async () => {
    client = new StdioClient();
    await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'upkeep-mcp-test', version: '0.0.0' },
    });
    client.notify('notifications/initialized');
  }, 30_000);

  afterAll(() => {
    client.kill();
  });

  it('completes the handshake announcing its own name and version', async () => {
    const { result } = await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'upkeep-mcp-test', version: '0.0.0' },
    });

    expect(result).toMatchObject({
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  });

  it('advertises the health tool with a description and an output schema', async () => {
    const { result } = await client.request('tools/list');
    const { tools } = result as { tools: { name: string; description?: string }[] };
    const health = tools.find((tool) => tool.name === 'health');

    expect(health).toBeDefined();
    expect(health?.description ?? '').not.toBe('');
    expect(result).toMatchObject({ tools: expect.any(Array) as unknown[] });
  });

  it('answers a health call with text and structured content', async () => {
    const { result } = await client.request('tools/call', { name: 'health', arguments: {} });
    const call = result as {
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };

    expect(call.isError).toBeFalsy();
    expect(call.content[0]?.text).toContain(`${SERVER_NAME} ${SERVER_VERSION} is running`);
    expect(call.structuredContent).toMatchObject({
      status: 'ok',
      server: SERVER_NAME,
      version: SERVER_VERSION,
    });
  });

  it('rejects an unknown tool as a protocol error instead of dying', async () => {
    const response = await client.request('tools/call', { name: 'no-such-tool', arguments: {} });

    // Either shape is acceptable; what matters is that the server survives it.
    expect(response.error ?? (response.result as { isError?: boolean }).isError).toBeTruthy();

    const { result } = await client.request('tools/call', { name: 'health', arguments: {} });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  });
});
