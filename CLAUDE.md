# CLAUDE.md

Guidance for any AI coding session working in this repository. These are the
project's own rules; they override general defaults.

## What this is

An MCP server exposing the recurring checks behind ongoing website maintenance —
domains, SSL certificates, uptime, technical SEO, accessibility — for someone
managing a portfolio of client sites on a retainer. Everything it reads is
public information.

The tool that matters most is `portfolio_report`: the whole portfolio at once,
sorted by what needs action this week. When a design question is open, the
tiebreaker is whichever option shortens quarterly maintenance reporting.

## Inviolable principles

1. **Never ask for, accept or store credentials.** No API keys, tokens or
   passwords, for any service. A feature that needs one does not belong here.
2. **Public information only** — what anyone with a browser or a DNS resolver
   could read.
3. **Nothing intrusive.** No port scanning, no subdomain brute-forcing, no
   vulnerability probing. This inspects public configuration; it is not an
   offensive tool.
4. **Respect `robots.txt`** on any page crawl, with per-host rate limiting and
   an identifiable `User-Agent` carrying a contact URL (`src/lib/constants.ts`).
5. **No persistent sensitive state.** In-memory or local-file caching with a
   TTL. Nothing that needs a database.

No real client name, client domain or credential may appear anywhere in the
repository or in its git history.

## Stack

- Node.js 22+, TypeScript `strict`, ESM. Relative imports carry the `.js`
  extension (`NodeNext` resolution).
- `@modelcontextprotocol/server` v2. **Not** `@modelcontextprotocol/sdk` (v1) —
  the API differs.
- Zod v4, imported as `import * as z from 'zod/v4'`.
- Vitest, ESLint, Prettier.

The v2 API is documented at <https://ts.sdk.modelcontextprotocol.io/v2/>. Check
signatures there rather than recalling them: `serveStdio(factory)` replaces the
v1 pattern of constructing a transport and calling `server.connect`.

## Conventions

- No `any`. No `@ts-ignore`. If the type does not close, the design is wrong.
- **No exception crosses the MCP boundary.** Every handler is wrapped in `guard`
  (`src/lib/tool-result.ts`) and failures are returned as results with
  `isError: true` and an actionable message — `domain does not resolve`,
  `timed out after 10s`, `TLS handshake failed` — never `request failed`.
- Explicit timeout on every network operation. Nothing without a deadline.
- Bounded concurrency and per-host rate limiting for anything touching multiple
  targets.
- Cache with a TTL: RDAP and DNS are slow and change rarely.
- Dates always ISO 8601 with timezone. Days-until-expiry computed in UTC.
- Conventional Commits. The history is part of the portfolio piece.
- Error messages, documentation and comments in English.

## Structure

`src/tools/` holds one file per tool, each exporting its registration function.
`src/server.ts` only registers them. **No tool performs I/O directly** — it goes
through `src/lib/`, so tests can run without a network. `src/types.ts` holds the
shared result shapes.

Tests live in `test/`, mirroring `src/`, with recorded fixtures. The default
suite is offline; anything hitting the network belongs in `test/integration/`,
run separately by `npm run test:integration`.

## Documentation rules

Out-of-date documentation is worse than none. A behaviour change updates the
docs **in the same commit** — never "document it later". Landing a new tool
means updating the README table, `CHANGELOG.md`, and any affected `docs/`.

The `description` of each tool and each input field is not decoration: it is
what the model reads to decide when and how to call the tool. Every tool states
what it does, when it should be used, when it should **not** be used, and what
it returns. Every input field gets a description, the expected format and an
example (`domain: "example.com", no scheme, no trailing slash`). Write it for a
competent person who has never seen this project.

Everything exported from `src/lib/` carries JSDoc: purpose, parameters, return
value and which errors it throws. Comments explain _why_, never _what_ — a
specific timeout, an RDAP-to-WHOIS fallback, a parsing tolerance. If code needs
a comment to say what it does, rewrite the code.

## Commands

```bash
npm run dev          # run the stdio server from source
npm run check        # format + lint + typecheck + test, the same gate as CI
npm test             # offline suite
npm run build        # compile to dist/
```

## Phases

Phase 0 (scaffolding) is done. Phase 1 is `domain_check`, `ssl_check` and
`uptime_check`; then `seo_audit`; then `portfolio_report`; then
`accessibility_audit` and the Streamable HTTP transport.

**Stop and ask for confirmation at the end of each phase. Do not implement
future phases ahead of time.**
