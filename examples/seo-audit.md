# seo_audit

Call:

```json
{ "name": "seo_audit", "arguments": { "url": "https://example.com/" } }
```

Text returned to the conversation:

```
https://example.com/ answered 200. Title: "Example Domain".
1 h1, 0 images without alt, 0 internal links (0 checked, 0 broken).
Sitemap: the sitemap URL answered 404.

Needs attention:
- [warning] The page has no meta description, so search engines will write their own summary of it.
- [info] The page declares no canonical URL, which is how duplicate addresses for the same page get separated.
- [info] The page has no og:title or no og:image, so it will share poorly on social networks and in messaging apps.
- [info] There is no sitemap at https://example.com/sitemap.xml: the sitemap URL answered 404.
- [info] The site publishes no robots.txt. Nothing is blocked, but the sitemap cannot be declared there either.
```

Structured content:

```json
{
  "url": "https://example.com/",
  "finalUrl": "https://example.com/",
  "checkedAt": "2026-08-31T22:07:37.245Z",
  "severity": "warning",
  "findings": [
    {
      "code": "meta_description_missing",
      "severity": "warning",
      "message": "The page has no meta description, so search engines will write their own summary of it."
    },
    {
      "code": "canonical_missing",
      "severity": "info",
      "message": "The page declares no canonical URL, which is how duplicate addresses for the same page get separated."
    },
    {
      "code": "open_graph_incomplete",
      "severity": "info",
      "message": "The page has no og:title or no og:image, so it will share poorly on social networks and in messaging apps."
    },
    {
      "code": "sitemap_missing",
      "severity": "info",
      "message": "There is no sitemap at https://example.com/sitemap.xml: the sitemap URL answered 404."
    },
    {
      "code": "robots_txt_absent",
      "severity": "info",
      "message": "The site publishes no robots.txt. Nothing is blocked, but the sitemap cannot be declared there either."
    }
  ],
  "fetched": true,
  "status": 200,
  "contentType": "text/html",
  "truncated": false,
  "robots": {
    "url": "https://example.com/robots.txt",
    "availability": "absent",
    "allowsThisPage": true,
    "crawlDelaySeconds": null,
    "sitemaps": []
  },
  "page": {
    "title": "Example Domain",
    "titleLength": 14,
    "metaDescription": null,
    "metaDescriptionLength": null,
    "metaRobots": null,
    "canonical": null,
    "lang": "en",
    "hasViewport": true,
    "openGraph": {},
    "headings": [
      {
        "level": 1,
        "text": "Example Domain"
      }
    ],
    "h1Count": 1,
    "imagesTotal": 0,
    "imagesMissingAlt": [],
    "alternates": []
  },
  "links": {
    "internalTotal": 0,
    "externalTotal": 1,
    "checked": 0,
    "skippedByRobots": 0,
    "unchecked": 0,
    "broken": []
  },
  "sitemap": {
    "url": "https://example.com/sitemap.xml",
    "found": false,
    "missing": true,
    "kind": "unknown",
    "entryCount": 0,
    "sampleEntries": [],
    "problem": "the sitemap URL answered 404"
  }
}
```
