import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION } from '../src/lib/constants.js';
import type { Ports } from '../src/lib/ports.js';
import { registerQuarterlyReportPrompt } from '../src/prompts/quarterly-report.js';
import { registerPortfolioSitesResource } from '../src/resources/portfolio-sites.js';
import { registerDomainCheckTool } from '../src/tools/domain-check.js';
import { registerHealthTool } from '../src/tools/health.js';
import { registerPortfolioReportTool } from '../src/tools/portfolio-report.js';
import { registerSeoAuditTool } from '../src/tools/seo-audit.js';
import { registerSslCheckTool } from '../src/tools/ssl-check.js';
import { registerUptimeCheckTool } from '../src/tools/uptime-check.js';
import { fakePorts, healthyDns, inspection, registration } from './helpers/fake-ports.js';

/**
 * Contract tests: every tool driven over the real MCP protocol, offline.
 *
 * This is the layer the unit tests could not reach. Calling a tool's `run`
 * function directly proves what the code does; going through a registered
 * server proves what it *promises*, because the SDK validates the structured
 * content against the tool's own `outputSchema` before it reaches the wire. A
 * field the schema declares and the code forgets fails here and nowhere else.
 */
const PROTOCOL_VERSION = '2026-07-28';

const PAGE = 'https://example.com/';
const SITEMAP = 'https://example.com/sitemap.xml';

/** One set of ports that can answer for every tool at once. */
function allPorts(): Ports {
  return fakePorts({
    dnsRecords: healthyDns(),
    dsRecord: true,
    rdap: { registration: registration(), delegationSigned: true },
    tls: inspection(),
    hops: {
      [PAGE]: {
        status: 200,
        headers: {
          'strict-transport-security': 'max-age=31536000',
          'content-security-policy': "default-src 'self'",
          'x-content-type-options': 'nosniff',
        },
      },
      'http://example.com/': { status: 301, location: PAGE },
      'https://example.com/about': { status: 200 },
    },
    documents: {
      [PAGE]: {
        status: 200,
        body: `<!doctype html><html lang="en"><head><title>Example</title>
          <meta name="description" content="A description of a perfectly sensible length.">
          <meta name="viewport" content="width=device-width">
          <link rel="canonical" href="https://example.com/">
          <meta property="og:title" content="Example"><meta property="og:image" content="/card.png">
          </head><body><h1>Example</h1><a href="/about">About</a></body></html>`,
      },
      [SITEMAP]: {
        status: 200,
        body: '<urlset><url><loc>https://example.com/</loc></url></urlset>',
        contentType: 'application/xml',
      },
    },
    files: {
      'sites.json': JSON.stringify({
        version: 1,
        sites: [{ name: 'Example', url: PAGE, checks: ['uptime'] }],
      }),
    },
  });
}

interface Response {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A raw JSON-RPC client over an in-memory transport, with no SDK client in between. */
class LinkedClient {
  private readonly transport: InMemoryTransport;
  private nextId = 1;
  private readonly pending = new Map<number, (response: Response) => void>();

  constructor(transport: InMemoryTransport) {
    this.transport = transport;
    this.transport.onmessage = (message) => {
      const response = message as unknown as Response;
      if (typeof response.id !== 'number') return;
      this.pending.get(response.id)?.(response);
      this.pending.delete(response.id);
    };
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Response> {
    const id = this.nextId++;
    const settled = new Promise<Response>((resolve) => this.pending.set(id, resolve));
    await this.transport.send({ jsonrpc: '2.0', id, method, params } as never);
    return settled;
  }

  async notify(method: string): Promise<void> {
    await this.transport.send({ jsonrpc: '2.0', method } as never);
  }
}

let client: LinkedClient;
let server: McpServer;

beforeAll(async () => {
  const ports = allPorts();
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerHealthTool(server);
  registerDomainCheckTool(server, ports);
  registerSslCheckTool(server, ports);
  registerUptimeCheckTool(server, ports);
  registerSeoAuditTool(server, ports);
  registerPortfolioReportTool(server, ports);
  registerPortfolioSitesResource(server, ports);
  registerQuarterlyReportPrompt(server);

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new LinkedClient(clientSide);
  await clientSide.start();
  await server.connect(serverSide);

  await client.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'contract-test', version: '0.0.0' },
  });
  await client.notify('notifications/initialized');
});

afterAll(async () => {
  await server.close();
});

/** Calls a tool and returns the result, failing loudly on a protocol error. */
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { result, error } = await client.request('tools/call', { name, arguments: args });
  expect(error, `${name} returned a protocol error: ${error?.message ?? ''}`).toBeUndefined();
  return result as Record<string, unknown>;
}

describe('every tool honours its own output schema', () => {
  // A protocol error here means the structured content did not validate against
  // the schema the tool advertises — the exact mismatch a unit test that asserts
  // what the code does, rather than what it promises, cannot see.
  const cases: [string, Record<string, unknown>][] = [
    ['health', {}],
    ['domain_check', { domain: 'example.com' }],
    ['ssl_check', { domain: 'example.com' }],
    ['uptime_check', { url: PAGE }],
    ['seo_audit', { url: PAGE }],
    ['portfolio_report', { sites: [{ name: 'Example', url: PAGE, checks: ['uptime'] }] }],
  ];

  it.each(cases)('%s returns structured content that validates', async (name, args) => {
    const result = await call(name, args);

    expect(result['isError']).toBeFalsy();
    expect(result['structuredContent']).toBeTypeOf('object');
    expect(Array.isArray(result['content'])).toBe(true);
  });

  it('reads the portfolio file when told to rather than only inline sites', async () => {
    const result = await call('portfolio_report', { file: 'sites.json' });

    expect(result['isError']).toBeFalsy();
    expect((result['structuredContent'] as { siteCount: number }).siteCount).toBe(1);
  });
});

describe('every tool refuses bad input as a result, not as a crash', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['domain_check', { domain: '   ' }],
    ['ssl_check', { domain: 'not a domain at all' }],
    ['uptime_check', { url: '' }],
    ['seo_audit', { url: '://broken' }],
    ['portfolio_report', { sites: [{ name: 'Bad', url: 'not a url' }] }],
  ];

  it.each(cases)('%s reports the refusal through the result', async (name, args) => {
    const { result, error } = await client.request('tools/call', { name, arguments: args });

    // Either the schema rejected it before the handler, or the handler returned
    // isError. What must never happen is an exception crossing the boundary.
    if (error !== undefined) {
      expect(error.message).not.toBe('');
      return;
    }
    const payload = result as { isError?: boolean; content: { text?: string }[] };
    expect(payload.isError).toBe(true);
    expect(payload.content[0]?.text ?? '').not.toBe('');
    // A failed result carries no structured content: the output schema
    // describes a successful reading, and an error is not one.
    expect((result as Record<string, unknown>)['structuredContent']).toBeUndefined();
  });

  it('rejects an input the schema forbids without reaching the handler', async () => {
    const { error, result } = await client.request('tools/call', {
      name: 'ssl_check',
      arguments: { domain: 'example.com', port: 70_000 },
    });

    const failed = error !== undefined || (result as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
  });
});

describe('the advertised surface', () => {
  it('describes every tool, every input field and every output field', async () => {
    const { result } = await client.request('tools/list');
    const { tools } = result as {
      tools: {
        name: string;
        description?: string;
        inputSchema?: { properties?: Record<string, { description?: string }> };
        outputSchema?: { properties?: Record<string, { description?: string }> };
      }[];
    };

    expect(tools.length).toBeGreaterThanOrEqual(6);

    for (const tool of tools) {
      expect(tool.description ?? '', `${tool.name} has no description`).not.toBe('');
      for (const [field, schema] of Object.entries(tool.inputSchema?.properties ?? {})) {
        expect(schema.description ?? '', `${tool.name}.${field} input is undescribed`).not.toBe('');
      }
      for (const [field, schema] of Object.entries(tool.outputSchema?.properties ?? {})) {
        expect(schema.description ?? '', `${tool.name}.${field} output is undescribed`).not.toBe(
          '',
        );
      }
    }
  });

  it('says when each tool should not be used, not only when it should', async () => {
    const { result } = await client.request('tools/list');
    const { tools } = result as { tools: { name: string; description?: string }[] };

    // The project's documentation rule: a description states what a tool does,
    // when to use it, when *not* to, and what it returns. The negative half is
    // what stops a model reaching for the wrong tool.
    for (const tool of tools) {
      expect(tool.description ?? '', `${tool.name} never says when not to use it`).toMatch(
        /Do not use it/i,
      );
    }
  });

  it('marks every tool read-only, because none of them change anything', async () => {
    const { result } = await client.request('tools/list');
    const { tools } = result as {
      tools: { name: string; annotations?: Record<string, unknown> }[];
    };

    for (const tool of tools) {
      expect(tool.annotations?.['readOnlyHint'], `${tool.name} is not marked read-only`).toBe(true);
      expect(tool.annotations?.['destructiveHint']).toBe(false);
    }
  });
});
