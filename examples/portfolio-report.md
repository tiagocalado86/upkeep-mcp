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

No change is reported: this server has not run a report on this portfolio before, and the portfolio names no history file, so nothing survived the last restart.
History for this portfolio is kept in memory only. To compare across restarts, add a "history" path to the portfolio file.

Nothing to do: Example Foundation.
```

Structured content:

```json
{
  "generatedAt": "2026-09-06T17:57:01.674Z",
  "source": "inline",
  "file": null,
  "siteCount": 3,
  "severity": "warning",
  "summary": {
    "critical": 0,
    "warning": 2,
    "unknown": 0,
    "info": 1,
    "ok": 0
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
    "previousRunUnavailable": "this server has not run a report on this portfolio before, and the portfolio names no history file, so nothing survived the last restart",
    "historyKeptIn": "memory",
    "sitesCompared": 0,
    "sitesMeasuredDifferently": 0,
    "sitesNewSincePreviousRun": 0,
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
      "soonestExpiryDays": 51,
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
          "code": "dmarc_no_reporting_address",
          "severity": "info",
          "message": "DMARC publishes no \"rua\" address, so no reports arrive to show whether it is working.",
          "check": "domain"
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
          "severity": "info",
          "headline": "example.com expires 2027-08-13 (340 days).",
          "error": null
        },
        {
          "check": "ssl",
          "ran": true,
          "severity": "ok",
          "headline": "example.com:443 certificate expires 2026-10-27 (51 days).",
          "error": null
        },
        {
          "check": "uptime",
          "ran": true,
          "severity": "warning",
          "headline": "https://example.com/ answered 200 in 23ms.",
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
          "headline": "https://example.net/ answered 200 in 103ms.",
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
      "severity": "info",
      "soonestExpiryDays": 51,
      "findings": [
        {
          "code": "dmarc_no_reporting_address",
          "severity": "info",
          "message": "DMARC publishes no \"rua\" address, so no reports arrive to show whether it is working.",
          "check": "domain"
        }
      ],
      "checks": [
        {
          "check": "domain",
          "ran": true,
          "severity": "info",
          "headline": "example.org expires 2027-08-30 (357 days).",
          "error": null
        },
        {
          "check": "ssl",
          "ran": true,
          "severity": "ok",
          "headline": "example.org:443 certificate expires 2026-10-27 (51 days).",
          "error": null
        }
      ]
    }
  ]
}
```
