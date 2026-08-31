# 2. Describe schemas with Zod v4

Status: accepted (2026-08-31)

## Context

SDK v2 accepts any Standard Schema implementation — Zod, Valibot, ArkType — and
derives the JSON Schema it advertises to clients from it. One had to be chosen and
used consistently.

## Decision

Zod v4, imported as `import * as z from 'zod/v4'`.

Every field carries `.describe()`. In an MCP server those strings are not
decoration: they are what the model reads to decide when and how to call a tool.

## Consequences

- One schema per tool serves three jobs: runtime validation, the TypeScript type,
  and the JSON Schema clients see.
- `z.iso.datetime()` accepts **only** a `Z` suffix. It rejects `+01:00` offsets,
  which RDAP does emit, so every timestamp is normalised through
  `new Date(value).toISOString()` before it reaches a schema.
- Output schemas describe successful readings. Failures do not go through them —
  see `fail()` in `src/lib/tool-result.ts`.
