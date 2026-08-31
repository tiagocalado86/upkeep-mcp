# 10. Audit one page, with link checking, instead of a crawl depth

Status: accepted (2026-08-31)

## Context

The brief specifies `seo_audit` with `url` and an optional `depth`, defaulting
low. Implementing depth means auditing the pages a page links to, which
multiplies the work by the branching factor of the site.

Two constraints make that expensive here. Requests to one host are serialised by
the rate limiter with a minimum gap, because politeness is a project principle;
and `portfolio_report` will call this tool once per site across a whole
portfolio.

Broken internal links, which are the reason to look at other URLs at all, do not
need a crawl: they need one request per link, and only the status matters.

## Decision

Audit exactly one page. Check the status of that page's internal links, capped
and configurable, and expose `checkLinks` and `maxLinks` instead of `depth`.

## Consequences

- The cost of an audit is predictable: one `robots.txt`, one page, one sitemap
  and at most `maxLinks` requests, all paced by the limiter.
- Broken links are still found, which is what `depth` was wanted for.
- Auditing several pages of a site means calling the tool several times, which
  is explicit in cost and lets the caller choose the pages.
- Links the audit did not reach are reported as `unchecked` with a finding,
  never silently dropped — a count of zero broken links means nothing without
  knowing how many were looked at.
- If a real crawl is wanted later it arrives as its own tool, with its own
  budget, rather than as a parameter that quietly makes this one expensive.
