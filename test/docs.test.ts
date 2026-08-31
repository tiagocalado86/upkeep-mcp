import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

/**
 * Documentation that describes the code, checked against the code.
 *
 * The project's rule is that out-of-date documentation is worse than none. That
 * rule has been broken three times in this repository's short life — a README
 * table left saying "Planned", a CHANGELOG naming the wrong Node versions, a
 * threat model still offering a protocol that had been dropped — and each time
 * a person had to notice. These assertions notice instead.
 */

/** Every markdown file that documents the project. */
function documents(): { path: string; text: string }[] {
  const roots = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'];
  const docs = readdirSync('docs', { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `${entry.parentPath}/${entry.name}`);
  const examples = readdirSync('examples')
    .filter((name) => name.endsWith('.md'))
    .map((name) => `examples/${name}`);

  return [...roots, ...docs, ...examples].map((path) => ({
    path,
    text: readFileSync(path, 'utf8'),
  }));
}

describe('the README describes the tools that exist', () => {
  it('marks exactly the registered tools as available', async () => {
    // A table row saying "Planned" for something that shipped is the drift this
    // project keeps having; so is a row promising something that does not exist.
    const registered = new Set(Object.keys(await toolNames()));
    const readme = readFileSync('README.md', 'utf8');

    // Read the table as a table, not as loose lines. A row that has drifted
    // out of the block still looks like a row to a line-based regex — which is
    // how the flagship tool came to render as literal pipes under a paragraph
    // while this very assertion passed.
    const table = tableAfterHeader(readme);
    const available = new Set(
      table
        .filter((row) => /\|\s*Available\s*\|/.test(row))
        .map((row) => /^\| `(\w+)`/.exec(row)?.[1] ?? ''),
    );

    expect([...available].sort()).toEqual([...registered].sort());
  });

  it('keeps every table row inside its table', () => {
    // Markdown ends a table at the first line that is not a row. A stray row
    // after a paragraph renders as text with pipes in it, which is what a
    // reviewer sees first and what no formatter complains about.
    for (const { path, text } of documents()) {
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        if (!/^\|.*\|$/.test(line.trim())) return;
        const previous = lines[index - 1]?.trim() ?? '';
        const orphaned = previous !== '' && !/^\|.*\|$/.test(previous);
        expect(orphaned, `${path}:${String(index + 1)} is a table row outside a table`).toBe(false);
      });
    }
  });

  it('gives every registered tool a section of its own', () => {
    const readme = readFileSync('README.md', 'utf8');

    for (const name of [
      'domain_check',
      'ssl_check',
      'uptime_check',
      'seo_audit',
      'portfolio_report',
    ]) {
      expect(readme.includes(`### \`${name}\``), `README has no section for ${name}`).toBe(true);
    }
  });
});

describe('every link in the documentation points at something', () => {
  it('resolves every relative markdown link', () => {
    for (const { path, text } of documents()) {
      const links = [...text.matchAll(/\]\(([^)#]+?)(?:#[^)]*)?\)/g)].map(
        (match) => match[1] ?? '',
      );

      for (const link of links) {
        if (/^(https?:|mailto:)/.test(link)) continue;
        const target = normalize(join(dirname(path), link));
        expect(existsSync(target), `${path} links to ${link}, which does not exist`).toBe(true);
      }
    }
  });

  it('references only ADRs that exist', () => {
    const adrs = new Set(readdirSync('docs/adr'));

    for (const { path, text } of documents()) {
      for (const match of text.matchAll(/docs\/adr\/(\d{4}-[a-z0-9-]+\.md)/g)) {
        expect(adrs.has(match[1] ?? ''), `${path} cites a missing ADR: ${match[1] ?? ''}`).toBe(
          true,
        );
      }
    }
  });
});

/**
 * @param text A markdown document.
 * @returns The contiguous rows of its first table, header and separator
 *   excluded.
 * @throws Never.
 */
function tableAfterHeader(text: string): string[] {
  const lines = text.split('\n');
  const header = lines.findIndex((line) => /^\| Tool\s+\|/.test(line));
  if (header === -1) return [];

  const rows: string[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!/^\|.*\|$/.test(line.trim())) break;
    rows.push(line);
  }
  return rows;
}

/**
 * @returns The names of every tool the server registers, read from the server
 *   itself rather than from a list a test would have to remember to update.
 */
async function toolNames(): Promise<Record<string, unknown>> {
  const server = createServer();
  // The registry is private, so the names are read the way a client reads them.
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  const names: Record<string, unknown> = {};
  const settled = new Promise<void>((resolve) => {
    clientSide.onmessage = (message) => {
      const response = message as unknown as {
        id?: number;
        result?: { tools?: { name: string }[] };
      };
      if (response.id === 2) {
        for (const tool of response.result?.tools ?? []) names[tool.name] = true;
        resolve();
      }
    };
  });

  await clientSide.start();
  await server.connect(serverSide);
  await clientSide.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'docs-test', version: '0.0.0' },
    },
  } as never);
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);
  await clientSide.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } as never);

  await settled;
  await server.close();
  return names;
}
