# 7. Use tldts for registrable-domain extraction

Status: accepted (2026-08-31)

## Context

Registration is a property of the registrable domain, so `www.example.co.uk` and
`shop.example.org` must both reduce correctly before an RDAP query. Getting the
public suffix list right by hand is a well-known source of bugs — `example.co.uk`
is not `co.uk`, and the naive "last two labels" rule is wrong for a long tail of
suffixes.

The RDAP bootstrap match itself does _not_ need this: it matches label-wise from the
right, so `example.co.uk` correctly resolves through the `uk` entry.

The alternatives were `psl`, whose failure mode is a stale bundled list, and
`parse-domain`, which fetches the list at build time and so breaks offline and
sandboxed installs.

## Decision

`tldts`, as the only runtime dependency.

## Consequences

- One production dependency: MIT, one transitive package (`tldts-core`), list
  bundled so installation makes no network request.
- Subdomains and multi-part suffixes work without a hand-written table.
- The list ages with the package, so it is updated like any other dependency.
- `sites.example.json` keeps its per-site `domain` override, so a caller can always
  state the registrable domain explicitly and bypass inference entirely.
