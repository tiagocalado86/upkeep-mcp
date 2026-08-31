# domain_check

Call:

```json
{ "name": "domain_check", "arguments": { "domain": "example.com" } }
```

Text returned to the conversation:

```
example.com expires 2027-08-13 (346 days).
Registrar: RESERVED-Internet Assigned Numbers Authority.
Nameservers: elliott.ns.cloudflare.com, hera.ns.cloudflare.com.
Resolves: apex yes, www yes. DNSSEC: delegation signed.
```

Structured content:

```json
{
  "domain": "example.com",
  "unicodeDomain": null,
  "registrableDomain": "example.com",
  "checkedAt": "2026-08-31T09:58:12.361Z",
  "severity": "ok",
  "findings": [],
  "registration": {
    "source": "rdap",
    "rdapServer": "https://rdap.verisign.com/com/v1/",
    "registrar": "RESERVED-Internet Assigned Numbers Authority",
    "ianaRegistrarId": "376",
    "statuses": [
      "client delete prohibited",
      "client transfer prohibited",
      "client update prohibited"
    ],
    "registeredAt": "1995-08-14T04:00:00.000Z",
    "expiresAt": "2027-08-13T04:00:00.000Z",
    "daysUntilExpiry": 346,
    "unavailableReason": null,
    "expirySeverity": "ok"
  },
  "dns": {
    "apexResolves": true,
    "wwwResolves": true,
    "a": [
      "104.20.23.154",
      "172.66.147.243"
    ],
    "aaaa": [
      "2606:4700:10::6814:179a",
      "2606:4700:10::ac42:93f3"
    ],
    "ns": [
      "elliott.ns.cloudflare.com",
      "hera.ns.cloudflare.com"
    ],
    "mx": [
      {
        "exchange": "",
        "priority": 0
      }
    ],
    "txt": [
      "v=spf1 -all",
      "_k2n1y4vw3qtb4skdx9e7dxt97qrmmq9"
    ],
    "caa": []
  },
  "dnssec": {
    "delegationSigned": true,
    "source": "rdap"
  }
}
```
