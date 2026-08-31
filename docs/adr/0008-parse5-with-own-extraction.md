# 8. Parse HTML with parse5 and extract with our own helpers

Status: accepted (2026-08-31)

## Context

`seo_audit` reads one page and reports what is in its markup: title, meta
description, headings, canonical, Open Graph, `hreflang`, images without `alt`
and the internal links.

The pages this runs against are real client sites, which means unclosed tags,
stray close tags, metadata after `<body>` has already started and attributes
without quotes. A tolerant parser that guesses differently from a browser would
report problems the visitor never has — the worst kind of finding to put in
front of a client.

Three candidates, checked against npm rather than from memory on 2026-08-31:

- **`cheerio` 1.2.0** — the familiar choice, jQuery-style selectors, built on
  parse5. Eleven direct dependencies, including `undici`: an entire HTTP stack
  this project does not need, because it already has `src/lib/http-client.ts`.
- **`node-html-parser` 9.0.2** — two dependencies, CSS selectors included,
  actively maintained. Its own tolerant parser, not the HTML5 tree construction
  algorithm.
- **`parse5` 8.0.1** — one dependency (`entities`), implements the spec that
  browsers implement. No selector engine.

## Decision

`parse5`, with the extraction written in `src/lib/html.ts`.

## Consequences

- Documents are read the way a browser reads them, including the broken ones.
- One production dependency and one transitive package, against eleven for the
  familiar option.
- No CSS selector engine, so extraction is one traversal collecting elements in
  document order and a `switch` over tag names. What this project needs to
  select is narrow and fixed — roughly ten element types — so a selector engine
  would be carried for nothing.
- `src/lib/html.ts` returns plain data, never nodes. No tool traverses a DOM,
  which keeps parser choice an implementation detail of one module.
- `<template>` contents are skipped deliberately: they are inert until a script
  clones them, and counting a heading inside one would report markup no visitor
  has seen.
