import type { McpServer } from '@modelcontextprotocol/server';
import { readPortfolioText } from '../lib/portfolio.js';
import { createDefaultPorts, type Ports } from '../lib/ports.js';

/** The portfolio file this resource reads. */
const PORTFOLIO_FILE = 'sites.json';

/**
 * Registers the `portfolio://sites` resource.
 *
 * A resource rather than a tool because it is something to *read*, not something
 * to run: a client can put the site list in front of a model without spending a
 * tool call, and the model can see what it is allowed to ask about before it
 * asks. It exposes names, URLs, tags and notes — the same public information the
 * checks work from, and nothing else. The file is read, never written.
 *
 * @param server The server to register on.
 * @param ports The I/O boundary. Defaults to real file access.
 * @throws Never.
 */
export function registerPortfolioSitesResource(
  server: McpServer,
  ports: Ports = createDefaultPorts(),
): void {
  server.registerResource(
    'portfolio-sites',
    'portfolio://sites',
    {
      title: 'Monitored sites',
      description:
        `The portfolio this server checks, read from ${PORTFOLIO_FILE} in the directory the ` +
        'server runs in. Each entry has a name, a URL, the registrable domain, which checks it ' +
        'wants, its expiry warning window, tags and notes. Empty when no portfolio file exists — ' +
        'the format is documented in sites.example.json.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const text = await describePortfolio(ports);
      return { contents: [{ uri: uri.href, text, mimeType: 'application/json' }] };
    },
  );
}

/**
 * Reads the portfolio and renders it as JSON.
 *
 * Exported so its three outcomes can be tested directly; the registration above
 * is exercised over the wire in the stdio suite.
 *
 * Every failure is an answer here rather than an exception: a client reading a
 * resource gets a document explaining why the list is empty, which is more use
 * than a protocol error it has to interpret.
 *
 * @param ports The I/O boundary.
 * @returns JSON text: the sites, or an explanation of why there are none.
 * @throws Never.
 */
export async function describePortfolio(ports: Ports): Promise<string> {
  let raw: string;
  try {
    raw = await ports.files.readText(PORTFOLIO_FILE);
  } catch (cause) {
    return JSON.stringify(
      {
        sites: [],
        note: `No portfolio file was read: ${cause instanceof Error ? cause.message : String(cause)}. Copy sites.example.json to ${PORTFOLIO_FILE} to fill this in.`,
      },
      null,
      2,
    );
  }

  const parsed = readPortfolioText(raw);
  if (!parsed.ok) {
    return JSON.stringify(
      { sites: [], note: `${PORTFOLIO_FILE} is unusable: ${parsed.reason}` },
      null,
      2,
    );
  }

  return JSON.stringify(
    { file: PORTFOLIO_FILE, count: parsed.sites.length, sites: parsed.sites },
    null,
    2,
  );
}
