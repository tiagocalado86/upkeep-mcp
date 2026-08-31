# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `domain_check`: registration expiry and registrar over RDAP, DNS records, and
  whether the delegation is signed with DNSSEC. Registries that publish no expiry
  date are named as such rather than reported as unknown.
- `ssl_check`: certificate expiry, issuer, chain validity, which hostnames the
  certificate covers and via which SAN entry, and the negotiated TLS version.
  Expired, self-signed and untrusted certificates are inspected, not refused.
- `uptime_check`: status, response time, the full redirect chain, whether plain
  HTTP is upgraded to HTTPS, the HSTS policy and the security headers worth
  reporting on.
- In-memory TTL caching that collapses concurrent lookups, and per-host rate
  limiting keyed by the host actually contacted.
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
  Node.js 20 and 22.
- `CLAUDE.md` recording the project principles and conventions.
- `docs/adr/` recording the structural decisions, including the choice to ship
  without a WHOIS fallback and the move to a Node.js 22 baseline.

### Changed

- **Breaking:** the minimum supported Node.js version is now 22. Node 20 reached
  end of life on 2026-04-30, and every certificate and DNS API this release needs
  sits on that boundary. See `docs/adr/0003-node-22-baseline.md`.

[Unreleased]: https://github.com/tiagocalado86/upkeep-mcp/commits/main
