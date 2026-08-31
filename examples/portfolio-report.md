# portfolio_report

Call:

```json
{ "name": "portfolio_report", "arguments": { "sites": [ /* three public domains */ ] } }
```

Text returned to the conversation:

```
3 sites checked: 0 critical, 2 warning, 0 unknown, 1 fine.

Needs action:
- [warning] Example Ltd: Plain HTTP does not redirect to HTTPS.
- [warning] Example Ltd: No Strict-Transport-Security header is sent.
- [warning] Example Net: Plain HTTP does not redirect to HTTPS.
- [warning] Example Net: No Strict-Transport-Security header is sent.

Nothing comparable in this session yet, so no change is reported. A run is comparable only against one that measured the same sites the same way.

Nothing to do: Example Foundation.
```

Structured content:

```json
{
  "generatedAt": "2026-08-31T23:07:50.038Z",
  "source": "inline",
  "file": null,
  "siteCount": 3,
  "severity": "warning",
  "summary": {
    "critical": 0,
    "warning": 2,
    "unknown": 0,
    "info": 0,
    "ok": 1
  },
  "needsAttention": [
    {
      "site": "Example Ltd",
      "url": "https://example.com/",
      "check": "uptime",
      "code": "no_https_redirect",
      "severity": "warning",
      "message": "Plain HTTP does not redirect to HTTPS."
    },
    {
      "site": "Example Ltd",
      "url": "https://example.com/",
      "check": "uptime",
      "code": "hsts_missing",
      "severity": "warning",
      "message": "No Strict-Transport-Security header is sent."
    },
    {
      "site": "Example Net",
      "url": "https://example.net/",
      "check": "uptime",
      "code": "no_https_redirect",
      "severity": "warning",
      "message": "Plain HTTP does not redirect to HTTPS."
    },
    {
      "site": "Example Net",
      "url": "https://example.net/",
      "check": "uptime",
      "code": "hsts_missing",
      "severity": "warning",
      "message": "No Strict-Transport-Security header is sent."
    }
  ],
  "changes": {
    "comparedWithPreviousRun": false,
    "previousRunAt": null,
    "sitesCompared": 0,
    "regressed": [],
    "improved": [],
    "newFindings": []
  },
  "notes": [],
  "sites": [
    {
      "name": "Example Ltd",
      "url": "https://example.com/",
      "domain": "example.com",
      "tags": [],
      "notes": null,
      "severity": "warning",
      "soonestExpiryDays": 56,
      "findings": [
        {
          "code": "no_https_redirect",
          "severity": "warning",
          "message": "Plain HTTP does not redirect to HTTPS.",
          "check": "uptime"
        },
        {
          "code": "hsts_missing",
          "severity": "warning",
          "message": "No Strict-Transport-Security header is sent.",
          "check": "uptime"
        },
        {
          "code": "csp_missing",
          "severity": "info",
          "message": "No Content-Security-Policy header is sent.",
          "check": "uptime"
        },
        {
          "code": "nosniff_missing",
          "severity": "info",
          "message": "No X-Content-Type-Options: nosniff header is sent.",
          "check": "uptime"
        }
      ],
      "checks": [
        {
          "check": "domain",
          "ran": true,
          "severity": "ok",
          "headline": "example.com expires 2027-08-13 (346 days).",
          "error": null
        },
        {
          "check": "ssl",
          "ran": true,
          "severity": "ok",
          "headline": "example.com:443 certificate expires 2026-10-27 (56 days).",
          "error": null
        },
        {
          "check": "uptime",
          "ran": true,
          "severity": "warning",
          "headline": "https://example.com/ answered 200 in 19ms.",
          "error": null
        }
      ]
    },
    {
      "name": "Example Net",
      "url": "https://example.net/",
      "domain": "example.net",
      "tags": [],
      "notes": null,
      "severity": "warning",
      "soonestExpiryDays": null,
      "findings": [
        {
          "code": "no_https_redirect",
          "severity": "warning",
          "message": "Plain HTTP does not redirect to HTTPS.",
          "check": "uptime"
        },
        {
          "code": "hsts_missing",
          "severity": "warning",
          "message": "No Strict-Transport-Security header is sent.",
          "check": "uptime"
        },
        {
          "code": "csp_missing",
          "severity": "info",
          "message": "No Content-Security-Policy header is sent.",
          "check": "uptime"
        },
        {
          "code": "nosniff_missing",
          "severity": "info",
          "message": "No X-Content-Type-Options: nosniff header is sent.",
          "check": "uptime"
        }
      ],
      "checks": [
        {
          "check": "uptime",
          "ran": true,
          "severity": "warning",
          "headline": "https://example.net/ answered 200 in 168ms.",
          "error": null
        }
      ]
    },
    {
      "name": "Example Foundation",
      "url": "https://example.org/",
      "domain": "example.org",
      "tags": [],
      "notes": null,
      "severity": "ok",
      "soonestExpiryDays": 56,
      "findings": [],
      "checks": [
        {
          "check": "domain",
          "ran": true,
          "severity": "ok",
          "headline": "example.org expires 2027-08-30 (363 days).",
          "error": null
        },
        {
          "check": "ssl",
          "ran": true,
          "severity": "ok",
          "headline": "example.org:443 certificate expires 2026-10-27 (56 days).",
          "error": null
        }
      ]
    }
  ]
}
```
