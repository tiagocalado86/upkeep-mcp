# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/tiagocalado86/upkeep-mcp/commits/main
