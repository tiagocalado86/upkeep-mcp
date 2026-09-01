# ssl_check

Call:

```json
{ "name": "ssl_check", "arguments": { "domain": "expired.badssl.com" } }
```

Text returned to the conversation:

```
expired.badssl.com:443 certificate expires 2015-04-12 (-4160 days).
Issued by COMODO RSA Domain Validation Secure Server CA.
Chain does not verify (CERT_HAS_EXPIRED). Negotiated TLSv1.2.
Host matched via *.badssl.com.
Revocation is not checked.

Needs attention:
- [critical] The certificate expired 4160 days ago.
- [critical] The certificate chain does not verify: CERT_HAS_EXPIRED.
```

Structured content:

```json
{
  "host": "expired.badssl.com",
  "port": 443,
  "checkedAt": "2026-09-01T09:48:53.782Z",
  "severity": "critical",
  "findings": [
    {
      "code": "cert_expired",
      "severity": "critical",
      "message": "The certificate expired 4160 days ago."
    },
    {
      "code": "chain_invalid",
      "severity": "critical",
      "message": "The certificate chain does not verify: CERT_HAS_EXPIRED."
    }
  ],
  "expiresAt": "2015-04-12T23:59:59.000Z",
  "daysUntilExpiry": -4160,
  "issuedAt": "2015-04-09T00:00:00.000Z",
  "issuer": "COMODO RSA Domain Validation Secure Server CA",
  "subject": "*.badssl.com",
  "serialNumber": "4AE79549FA9ABE3F100F17A478E16909",
  "fingerprintSha256": "BA:10:5C:E0:2B:AC:76:88:8E:CE:E4:7C:D4:EB:79:41:65:3E:9A:C9:93:B6:1B:2E:B3:DC:C8:20:14:D2:1B:4F",
  "chain": {
    "valid": false,
    "error": "CERT_HAS_EXPIRED",
    "length": 3,
    "issuers": [
      "COMODO RSA Domain Validation Secure Server CA",
      "COMODO RSA Certification Authority",
      "AddTrust External CA Root"
    ],
    "revocationChecked": false
  },
  "coverage": {
    "subjectAltName": "DNS:*.badssl.com, DNS:badssl.com",
    "coversRequestedHost": true,
    "matchedVia": "*.badssl.com",
    "coversApex": true,
    "coversWww": true,
    "wwwResolves": true
  },
  "tls": {
    "protocol": "TLSv1.2",
    "cipher": "ECDHE-RSA-AES128-GCM-SHA256",
    "alpn": "http/1.1"
  }
}
```
