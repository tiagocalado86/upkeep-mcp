# Contributing

Thanks for taking a look. This is a small, opinionated project; the sections
below cover what you need to work on it without guessing.

> **Status:** Phase 0 (scaffolding) is complete — the toolchain below works
> and the server runs, with `health` as its only tool. Phase 1 adds
> `domain_check`, `ssl_check` and `uptime_check`.

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

You need **Node.js 20 or newer**.

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
| `npm run test:integration` | Integration tests — real network, not run in CI |

`npm run check` is the same gate CI applies, on Node.js 20 and 22. Run it before
opening a pull request.

## Testing

The normal suite never touches the network. Responses are recorded as fixtures
under `test/` and the `lib/` module doing the I/O is stubbed, which is the whole
reason tools never make network calls directly (see
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
  http.ts      entrypoint, Streamable HTTP transport
  server.ts    builds the McpServer and registers tools
  tools/       one file per tool: definition + handler
  lib/         all I/O — dns, tls, http-client, cache, rate-limit, robots
  types.ts     shared result types
test/          mirrors src/, with recorded fixtures
```

The split matters: **no tool performs I/O directly**, it goes through `lib/`.
That is what makes the tools testable without a network. `server.ts` only
registers; it holds no logic.

## Adding a tool

1. Create `src/tools/<name>.ts` exporting the tool definition and its handler.
2. Put any new network access in `lib/`, with an explicit timeout. Never call
   out from the tool file.
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
