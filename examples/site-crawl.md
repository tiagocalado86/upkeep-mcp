# site_crawl

Call:

```json
{ "name": "site_crawl", "arguments": { "url": "https://www.sitemaps.org/", "maxPages": 12 } }
```

Text returned to the conversation:

```
Crawled 5 pages of https://www.sitemaps.org, 2 levels deep.
0 broken internal links, 1 title used more than once.

Needs attention:
- [warning] 1 title is used by more than one page, so those pages compete with each other in search results; the widest is "sitemaps.org - Home" on 3 pages.
- [info] 1 meta description is used by more than one page, so search engines will write their own summary for all but one of them.
- [info] 2 pages of 5 have no meta description, so search engines will write their own summary of them.
```

Structured content:

```json
{
  "startUrl": "https://www.sitemaps.org/",
  "origin": "https://www.sitemaps.org",
  "checkedAt": "2026-09-06T23:57:23.955Z",
  "severity": "warning",
  "findings": [
    {
      "code": "duplicate_titles",
      "severity": "warning",
      "message": "1 title is used by more than one page, so those pages compete with each other in search results; the widest is \"sitemaps.org - Home\" on 3 pages."
    },
    {
      "code": "duplicate_meta_descriptions",
      "severity": "info",
      "message": "1 meta description is used by more than one page, so search engines will write their own summary for all but one of them."
    },
    {
      "code": "pages_without_a_meta_description",
      "severity": "info",
      "message": "2 pages of 5 have no meta description, so search engines will write their own summary of them."
    }
  ],
  "crawl": {
    "pagesFetched": 5,
    "deepestLevel": 2,
    "skippedByRobots": 0,
    "leftTheOrigin": 0,
    "notVisited": 0,
    "stoppedBecause": "nothing left to visit"
  },
  "pages": [
    {
      "url": "https://www.sitemaps.org/",
      "requestedUrl": "https://www.sitemaps.org/",
      "status": 200,
      "depth": 0,
      "linkedFrom": null,
      "title": "sitemaps.org - Home",
      "metaDescription": "The Sitemaps protocol enables webmasters to information earch engine about pages on their site that are available for crawling.",
      "h1Count": 2,
      "canonical": null,
      "noindex": false,
      "isHtml": true
    },
    {
      "url": "https://www.sitemaps.org/faq.html",
      "requestedUrl": "https://www.sitemaps.org/faq.php",
      "status": 200,
      "depth": 1,
      "linkedFrom": "https://www.sitemaps.org/",
      "title": "sitemaps.org - FAQ",
      "metaDescription": null,
      "h1Count": 2,
      "canonical": null,
      "noindex": false,
      "isHtml": true
    },
    {
      "url": "https://www.sitemaps.org/protocol.html",
      "requestedUrl": "https://www.sitemaps.org/protocol.php",
      "status": 200,
      "depth": 1,
      "linkedFrom": "https://www.sitemaps.org/",
      "title": "sitemaps.org - Protocol",
      "metaDescription": null,
      "h1Count": 2,
      "canonical": null,
      "noindex": false,
      "isHtml": true
    },
    {
      "url": "https://www.sitemaps.org/terms.html",
      "requestedUrl": "https://www.sitemaps.org/terms.php",
      "status": 200,
      "depth": 1,
      "linkedFrom": "https://www.sitemaps.org/",
      "title": "sitemaps.org - Home",
      "metaDescription": "The Sitemaps protocol enables webmasters to information earch engine about pages on their site that are available for crawling.",
      "h1Count": 2,
      "canonical": null,
      "noindex": false,
      "isHtml": true
    },
    {
      "url": "https://www.sitemaps.org/index.html",
      "requestedUrl": "https://www.sitemaps.org/index.php",
      "status": 200,
      "depth": 2,
      "linkedFrom": "https://www.sitemaps.org/faq.html",
      "title": "sitemaps.org - Home",
      "metaDescription": "The Sitemaps protocol enables webmasters to information earch engine about pages on their site that are available for crawling.",
      "h1Count": 2,
      "canonical": null,
      "noindex": false,
      "isHtml": true
    }
  ],
  "broken": [],
  "duplicates": {
    "titles": [
      {
        "value": "sitemaps.org - Home",
        "urls": [
          "https://www.sitemaps.org/",
          "https://www.sitemaps.org/terms.html",
          "https://www.sitemaps.org/index.html"
        ]
      }
    ],
    "descriptions": [
      {
        "value": "The Sitemaps protocol enables webmasters to information earch engine about pages on their site that are available for crawling.",
        "urls": [
          "https://www.sitemaps.org/",
          "https://www.sitemaps.org/terms.html",
          "https://www.sitemaps.org/index.html"
        ]
      }
    ]
  }
}
```
