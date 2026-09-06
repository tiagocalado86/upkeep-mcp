# domain_check

Call:

```json
{ "name": "domain_check", "arguments": { "domain": "example.com" } }
```

Text returned to the conversation:

```
example.com expires 2027-08-13 (340 days).
Registrar: RESERVED-Internet Assigned Numbers Authority.
Nameservers: elliott.ns.cloudflare.com, hera.ns.cloudflare.com (2 of 2 answered, all on serial 2413856909).
Resolves: apex yes, www yes. DNSSEC: delegation signed.
Email: SPF -all, DMARC p=reject.

Needs attention:
- [info] DMARC publishes no "rua" address, so no reports arrive to show whether it is working.
```

Structured content:

```json
{
  "domain": "example.com",
  "unicodeDomain": null,
  "registrableDomain": "example.com",
  "checkedAt": "2026-09-06T23:57:24.612Z",
  "severity": "info",
  "findings": [
    {
      "code": "dmarc_no_reporting_address",
      "severity": "info",
      "message": "DMARC publishes no \"rua\" address, so no reports arrive to show whether it is working."
    }
  ],
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
    "daysUntilExpiry": 340,
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
    "dmarcTxt": [
      "v=DMARC1;p=reject;sp=reject;adkim=s;aspf=s"
    ],
    "caa": []
  },
  "dnsResolved": true,
  "dnssec": {
    "delegationSigned": true,
    "source": "rdap"
  },
  "email": {
    "spf": {
      "present": true,
      "record": "v=spf1 -all",
      "recordCount": 1,
      "all": "fail",
      "directLookups": 0
    },
    "dmarc": {
      "present": true,
      "record": "v=DMARC1;p=reject;sp=reject;adkim=s;aspf=s",
      "recordCount": 1,
      "policy": "reject",
      "reportingAddresses": []
    }
  },
  "nameservers": {
    "checked": true,
    "unavailableReason": null,
    "answers": [
      {
        "host": "elliott.ns.cloudflare.com",
        "address": "108.162.195.228",
        "outcome": "authoritative",
        "serial": 2413856909,
        "problem": null
      },
      {
        "host": "hera.ns.cloudflare.com",
        "address": "173.245.58.162",
        "outcome": "authoritative",
        "serial": 2413856909,
        "problem": null
      }
    ],
    "serials": [
      2413856909
    ],
    "agree": true
  }
}
```
