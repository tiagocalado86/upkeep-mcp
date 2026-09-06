# 21. A crawl is its own tool, not a depth parameter on the audit

Status: accepted (2026-09-07)

## Context

[`docs/adr/0010`](0010-one-page-audit-instead-of-crawl-depth.md) turned down the
brief's `depth` parameter on `seo_audit` and closed by naming the way back:

> If a real crawl is wanted later it arrives as its own tool, with its own
> budget, rather than as a parameter that quietly makes this one expensive.

A crawl is wanted, and for a reason that a one-page audit cannot be extended
into. The findings worth having across a site are ones no single page can
produce about itself: that its title is the same as four other pages', so they
compete with each other for one search result; that a link on a page nobody
thought to audit is broken; that a `noindex` left over from staging is still on
three pages. Auditing each page separately and reading the results side by side
is the same work done by hand.

## Decision

`site_crawl`, a tool of its own. Breadth-first from a starting page, one origin,
`robots.txt` obeyed before every request, and three budgets — pages, depth, and
a deadline — with whichever one ended the crawl reported along with how many
URLs were left unvisited.

It reports what a crawl can see and `seo_audit` cannot: duplicate titles and
descriptions, broken internal links **with the page each was found on**, pages
asking not to be indexed, pages with no title, no description or no `h1`, and
the shape of what was covered. It deliberately does not repeat what `seo_audit`
already says about a single page — canonical, Open Graph, hreflang, images
without alt text, the sitemap — so running both does not produce two copies of
one list.

## Consequences

- The cost is explicit and in the caller's hands. One request per page, paced by
  the per-host limiter at one every half second: twenty-five pages is about
  fifteen seconds, the hundred it will allow is about a minute.
- **It is not wired into `portfolio_report`, and that is the point of it being
  separate.** Twenty-five pages for each of twenty sites is five hundred
  requests, which is a different order of thing from the one page per site that
  the portfolio costs today. A quarterly report runs `site_crawl` for the sites
  that warrant it, deliberately.
- Sequential rather than parallel. The limiter already serialises requests to
  one origin, so concurrency would buy queueing rather than speed — and a
  parallel crawl overshoots its page budget by however many requests were in
  flight when the last one landed.
- **One origin, never two**, and the origin is the one the crawl was told to
  start on rather than the one of the page in hand. `example.com` and
  `www.example.com` are different origins; a crawl that followed links between
  them would report one site's pages as duplicates of the other's, which is true
  and useless. Taking the origin from the page in hand was worse than that and
  was caught in review: one redirect off the site handed the crawl a new host to
  walk under the `robots.txt` of the origin it started from, which is to say
  under nobody's rules. A page whose final URL left the origin is now counted,
  not recorded, and its links are not followed.
- **Two addresses that redirect to one page are one page.** `/a` and `/a/` are
  ordinary on real sites, and counting them separately produced the tool's
  headline finding — two pages competing for one title — out of a trailing
  slash. Also caught in review.
- A URL is remembered without its fragment, because a fragment never reaches the
  server: `/about`, `/about#team` and `/about` again are one request.
- What it still does not do: JavaScript is not executed, so a site that renders
  its navigation client-side looks like a site with no links — the same limit
  `seo_audit` has and for the same reason. Nothing is submitted, no form is
  filled, and no URL is guessed: it follows links that exist.
