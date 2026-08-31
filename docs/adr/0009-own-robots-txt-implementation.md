# 9. Implement robots.txt matching rather than depend on it

Status: accepted (2026-08-31)

## Context

Respecting `robots.txt` is principle 4 of this project, not a nicety, and from
`seo_audit` onwards every request the server makes to a page depends on it.

`robots-parser` 3.0.1 does the job in zero dependencies, but its last publication
was 2023-02-21. Depending on unmaintained code for the one rule the project
declares inviolable is the wrong trade, and it is also the piece a reviewer is
most likely to read closely.

The rules themselves are small and precisely specified by RFC 9309: select the
group by product token, longest match wins, `allow` breaks a tie, `*` and a
trailing `$` are the only operators, and an unreachable file means "disallowed".

## Decision

Implement parsing and matching in `src/lib/robots.ts`, citing the section of
RFC 9309 that each rule comes from.

## Consequences

- No dependency, and the behaviour is pinned by 23 tests covering the cases the
  RFC calls out: group selection and merging, tie-breaking, wildcards, `$`
  anchoring, percent-encoding, and rules written before any `user-agent` line.
- Path matching is a two-pointer wildcard match, **not** a regular expression.
  A pattern such as `/*a*a*a*a*a*a*a*b` compiled to `.*` alternations backtracks
  exponentially, and the pattern comes from a remote host — a hang triggered by
  a file we are obliged to read. A test asserts it stays fast.
- The three fetch outcomes are kept apart because RFC 9309 §2.3.1 draws opposite
  conclusions from them: 2xx is a rule set, 4xx means nothing is disallowed, and
  5xx or an unreachable host means everything is.
- `Crawl-delay` is read even though it is not in the RFC. It is widely used, and
  ignoring a host that asks to be crawled slowly would contradict the principle
  this module exists to serve.
