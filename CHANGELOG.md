# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-31

### Added

- `domain_check`: registration expiry and registrar over RDAP, DNS records, and
  whether the delegation is signed with DNSSEC. Registries that publish no expiry
  date are named as such rather than reported as unknown.
- `ssl_check`: certificate expiry, issuer, chain validity, which hostnames the
  certificate covers and via which SAN entry, and the negotiated TLS version.
  Expired, self-signed and untrusted certificates are inspected, not refused. A
  certificate becomes a warning inside 14 days rather than 30, because ACME
  clients renew with 30 days left and the wider window would fire on healthy
  sites. A certificate whose dates cannot be read is reported as `unknown`, never
  as nothing wrong.
- `uptime_check`: status, response time, the full redirect chain, whether plain
  HTTP is upgraded to HTTPS, the HSTS policy and the security headers worth
  reporting on. Status codes are graded rather than lumped together: 5xx, 404 and
  410 are critical, 401 and 403 are a warning because they are normal for a
  staging site, and 429 is `unknown` because a throttled check establishes
  nothing.
- In-memory TTL caching that collapses concurrent lookups, and per-host rate
  limiting keyed by the host actually contacted. A DNS lookup that found nothing
  is held for a minute rather than five, so a delegation that has just been fixed
  is not reported as broken for the rest of the TTL.
- Every check returns its findings ordered worst first, so the order is a
  contract the aggregation in `portfolio_report` can rely on rather than an
  accident of the order things were detected in.
- `examples/` with real captured output from each tool, and
  `docs/architecture.md`.
- Project scaffolding: TypeScript in `strict` mode, ESM, ESLint, Prettier and
  Vitest, with a `npm run check` gate that runs all four.
- An MCP server over the stdio transport, built on the MCP TypeScript SDK v2.
- A `health` tool reporting the server name, version, Node.js version and
  uptime — enough to confirm a client is talking to the server.
- `guard`, a wrapper applied to every tool handler so that no exception can
  cross the MCP boundary.
- GitHub Actions CI running format, lint, typecheck, tests and build on
  Node.js 22 and 24.
- `CLAUDE.md` recording the project principles and conventions.
- `docs/adr/` recording the structural decisions, including the choice to ship
  without a WHOIS fallback and the move to a Node.js 22 baseline.

### Changed

- The minimum supported Node.js version is 22, not the 20 originally planned.
  Node 20 reached end of life on 2026-04-30, and every certificate and DNS API
  this release needs sits on that boundary. See
  `docs/adr/0003-node-22-baseline.md`.

[Unreleased]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tiagocalado86/upkeep-mcp/releases/tag/v0.1.0
