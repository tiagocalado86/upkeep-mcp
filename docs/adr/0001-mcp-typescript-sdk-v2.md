# 1. Build on the MCP TypeScript SDK v2

Status: accepted (2026-08-31)

## Context

Two SDK lines exist. `@modelcontextprotocol/sdk` is v1; `@modelcontextprotocol/server`
is v2, implements the 2026-07-28 spec revision, and is the stable line. The APIs are
not compatible: v1 has the caller construct a transport and call `server.connect`,
while v2 owns the connection lifecycle through `serveStdio(factory)`.

Most material about MCP servers online — including this project's own brief — was
written against v1, so the v1 shape is what gets reproduced from memory.

## Decision

Use `@modelcontextprotocol/server` v2, and treat <https://ts.sdk.modelcontextprotocol.io/v2/>
as the authority for every signature rather than recalling one.

Server construction lives in a factory (`createServer` in `src/server.ts`) because
`serveStdio` expects one and calls it per connection. Two clients must not share
mutable per-connection state.

## Consequences

- Tool results use `structuredContent` alongside `content`, validated against a
  declared `outputSchema` before reaching the wire — a mismatch fails during
  development rather than silently at the client.
- Errors are values: a result with `isError: true`, never a thrown exception.
- Copying a v1 example will not compile. That is the intended outcome.
- The Streamable HTTP transport in Phase 4 comes from the same v2 family
  (`@modelcontextprotocol/node` or `@modelcontextprotocol/hono`), so the server
  factory is reused unchanged.
