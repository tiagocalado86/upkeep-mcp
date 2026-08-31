# Contributing

Thanks for taking a look. This is a small, opinionated project; the sections
below cover what you need to work on it without guessing.

> **Status:** Phase 3 is complete. `domain_check`, `ssl_check`, `uptime_check`,
> `seo_audit` and `portfolio_report` work and are covered by tests, along with
> the `portfolio://sites` resource and the `quarterly_report` prompt. Phase 4
> adds `accessibility_audit` and the Streamable HTTP transport.

## Ground rules

Two rules override everything else in this document, and a change that breaks
either does not get merged regardless of how good it is otherwise:

1. **Never handle credentials.** No API keys, no tokens, no passwords, for any
   service. If a feature needs one, it does not belong here.
2. **Public information only, and nothing intrusive.** No port scanning, no
   subdomain brute-forcing, no vulnerability probing. This tool inspects public
   configuration.

The full threat model is in [SECURITY.md](SECURITY.md).

## Setup

You need **Node.js 22 or newer**.

```bash
git clone git@github.com:tiagocalado86/upkeep-mcp.git
cd upkeep-mcp
npm install
```

Common commands:

| Command                    | What it does                                    |
| -------------------------- | ----------------------------------------------- |
| `npm run build`            | Compile TypeScript to `dist/`                   |
| `npm run dev`              | Run the stdio server against the sources        |
| `npm run lint`             | ESLint                                          |
| `npm run typecheck`        | `tsc --noEmit`                                  |
| `npm run format`           | Prettier, writing in place                      |
| `npm run check`            | Format, lint, typecheck and tests — the CI gate |
| `npm test`                 | Vitest, unit tests only, no network             |
| `npm run coverage`         | The same suite with a coverage report           |
| `npm run test:integration` | Integration tests — real network, not run in CI |

`npm run check` is the same gate CI applies, on Node.js 22 and 24. Run it before
opening a pull request.

## Testing

The normal suite never touches the network, in three layers:

1. **Pure functions are tested directly** against recorded payloads under
   `test/fixtures/`. Most of the awkward real-world cases live here.
2. **Anything going through `fetch`** uses undici's `MockAgent` with
   `disableNetConnect()`, so an unintercepted request fails loudly instead of
   escaping to the network.
3. **`node:dns` and `node:tls`** are reached only through the `DnsClient` and
   `TlsProbe` interfaces in `src/lib/ports.ts`; tests pass fakes from
   `test/helpers/fake-ports.ts`.

Do not mock a Node builtin. That couples a test to the sequence of calls into
someone else's module instead of to this project's own contract — which is the
whole reason tools never make network calls directly (see
[Project layout](#project-layout)).

Integration tests live behind `npm run test:integration` and run against known
control domains — a valid certificate, an expired one, a domain that does not
resolve. They are excluded from CI so a third party's outage never fails a
build. Never point a test at a real client site.

Every check needs its edge cases covered: a domain that does not resolve, a
self-signed certificate, an infinite redirect, IDN/punycode, IPv6, and a host
that only answers on `www`.

## Project layout

```
src/
  index.ts     entrypoint, stdio transport
  server.ts    builds the McpServer and registers tools, resources and prompts
  tools/       one file per tool: schemas, findings, human summary
  resources/   one file per resource
  prompts/     one file per prompt
  lib/
    ports.ts     the I/O boundary — the only way a tool reaches the network
    dns.ts tls.ts rdap.ts http-client.ts    the implementations behind it
    robots.ts                               RFC 9309 parsing, matching, fetching
    cache.ts rate-limit.ts defaults.ts      caching, pacing, and the numbers
    html.ts sitemap.ts                      reading a page and a sitemap
    portfolio.ts history.ts                 the site list, and the previous run
    domain-name.ts severity.ts url.ts       pure helpers
    http-headers.ts json.ts concurrency.ts
  types.ts     shared result types
test/          mirrors src/, with fixtures and fake ports
```

The split matters: **no tool performs I/O directly**, it goes through the
interfaces in `lib/ports.ts`. That is not a convention — those interfaces are the
only thing a tool can see, so the compiler enforces it, and it is what makes the
tools testable without a network. `server.ts` only registers; it holds no logic.

`src/http.ts`, the Streamable HTTP entrypoint for the public demo, arrives in
Phase 4. [`docs/architecture.md`](docs/architecture.md) has the full picture.

## Adding a tool

1. Create `src/tools/<name>.ts` exporting a `register<Name>Tool(server, ports)`
   function and the handler it wraps. Take `ports` as a parameter defaulting to
   `createDefaultPorts()`, so tests can pass fakes.
2. Put any new network access behind an interface in `lib/ports.ts`, implemented
   in `lib/`, with an explicit timeout. Never call out from the tool file.
3. Define the input schema with Zod v4 (`import * as z from 'zod/v4'`).
4. Return both human-readable text and structured data.
5. Catch everything. No exception may cross the MCP boundary — return a
   structured error with an actionable message (`domain does not resolve`,
   `timed out after 10s`, `TLS handshake failed`). A server that crashes is a
   useless server.
6. Register it in `src/server.ts`.
7. Add tests with recorded fixtures, including the edge cases above.
8. Update the README's tool table and the `CHANGELOG.md`.

### Write the descriptions properly

In an MCP server the `description` on a tool and on every input field is not
decoration — it is what the model reads to decide whether and how to call the
tool. A vague description produces wrong tool calls.

Each tool description states what it does, when it should be used, when it
should _not_ be, and what it returns. Each input field gets a description, the
expected format and an example (`domain: "example.com", no scheme, no trailing
slash`). Write both for someone who has never seen the project.

## Code conventions

- TypeScript `strict`, ESM. No `any`, no `@ts-ignore` — if the types do not
  close, the design is wrong.
- Explicit timeout on every network operation. Bounded concurrency and per-host
  rate limiting on anything touching multiple targets.
- Dates in ISO 8601 with a timezone; days-until-expiry computed in UTC.
- JSDoc on everything exported from `lib/`: purpose, parameters, return value,
  and which errors it throws.
- Comments explain _why_, never _what_. Where a decision is not obvious — a
  specific timeout, the RDAP-to-WHOIS fallback, a parsing tolerance — say why.
- Code, comments, error messages and documentation in English.

## Documentation

Outdated documentation is worse than none. A change in behaviour updates the
docs **in the same commit** — never leave it for later.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
  `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.
- One logical change per commit; the history is meant to be read.
- Keep pull requests small and say what you verified, not just what you changed.
- Never commit a real client domain, a real `sites.json`, or anything
  resembling a credential — including in a test fixture or a commit message.

## Reporting bugs and vulnerabilities

Bugs go in a GitHub issue with the input you used and what you expected.
Security issues go through private reporting — see [SECURITY.md](SECURITY.md),
not a public issue.
