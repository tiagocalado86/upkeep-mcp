# ssl_check

Call:

```json
{ "name": "ssl_check", "arguments": { "domain": "expired.badssl.com" } }
```

Text returned to the conversation:

```
expired.badssl.com:443 certificate expires 2015-04-12 (-4165 days).
Issued by COMODO RSA Domain Validation Secure Server CA.
Chain does not verify (CERT_HAS_EXPIRED). Negotiated TLSv1.2.
Host matched via *.badssl.com.
Revocation not established: http://ocsp.comodoca.com could not answer: the responder is not authorised to answer for this certificate.

Needs attention:
- [critical] The certificate expired 4165 days ago.
- [critical] The certificate chain does not verify: CERT_HAS_EXPIRED.
- [unknown] Revocation could not be checked: http://ocsp.comodoca.com could not answer: the responder is not authorised to answer for this certificate.
```

Structured content:

```json
{
  "host": "expired.badssl.com",
  "port": 443,
  "checkedAt": "2026-09-06T17:56:58.822Z",
  "severity": "critical",
  "findings": [
    {
      "code": "cert_expired",
      "severity": "critical",
      "message": "The certificate expired 4165 days ago."
    },
    {
      "code": "chain_invalid",
      "severity": "critical",
      "message": "The certificate chain does not verify: CERT_HAS_EXPIRED."
    },
    {
      "code": "revocation_check_failed",
      "severity": "unknown",
      "message": "Revocation could not be checked: http://ocsp.comodoca.com could not answer: the responder is not authorised to answer for this certificate."
    }
  ],
  "expiresAt": "2015-04-12T23:59:59.000Z",
  "daysUntilExpiry": -4165,
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
  "revocation": {
    "checked": false,
    "status": null,
    "source": null,
    "responder": "http://ocsp.comodoca.com",
    "signatureVerified": false,
    "revokedAt": null,
    "reason": null,
    "producedAt": null,
    "nextUpdate": null,
    "unavailableReason": "http://ocsp.comodoca.com could not answer: the responder is not authorised to answer for this certificate"
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

# ssl_check on a revoked certificate whose chain still verifies

Call:

```json
{ "name": "ssl_check", "arguments": { "domain": "revoked.grc.com" } }
```

Text returned to the conversation:

```
revoked.grc.com:443 certificate expires 2026-10-18 (42 days).
Issued by Certera RSA DV SSL CA 2.
Chain verifies. Negotiated TLSv1.2.
Host matched via revoked.grc.com.
Revoked on 2025-09-18.

Needs attention:
- [critical] The certificate was revoked on 2025-09-18; browsers that check revocation will refuse the site.
```

Structured content:

```json
{
  "host": "revoked.grc.com",
  "port": 443,
  "checkedAt": "2026-09-06T17:56:59.240Z",
  "severity": "critical",
  "findings": [
    {
      "code": "cert_revoked",
      "severity": "critical",
      "message": "The certificate was revoked on 2025-09-18; browsers that check revocation will refuse the site."
    }
  ],
  "expiresAt": "2026-10-18T23:59:59.000Z",
  "daysUntilExpiry": 42,
  "issuedAt": "2025-09-17T00:00:00.000Z",
  "issuer": "Certera RSA DV SSL CA 2",
  "subject": "revoked.grc.com",
  "serialNumber": "67670F9947281AE16393D4DCBBFD5C88",
  "fingerprintSha256": "8F:43:B9:C1:D1:28:53:91:F7:0C:1B:05:9A:09:E6:5E:2D:34:B3:2E:8C:DC:ED:E3:E9:73:EE:35:2B:7B:A8:C7",
  "chain": {
    "valid": true,
    "error": null,
    "length": 3,
    "issuers": [
      "Certera RSA DV SSL CA 2",
      "Sectigo Public Server Authentication Root R46",
      "Sectigo Public Server Authentication Root R46"
    ],
    "revocationChecked": true
  },
  "revocation": {
    "checked": true,
    "status": "revoked",
    "source": "stapled",
    "responder": null,
    "signatureVerified": true,
    "revokedAt": "2025-09-18T23:46:29.000Z",
    "reason": null,
    "producedAt": "2026-09-03T01:41:17.000Z",
    "nextUpdate": "2026-09-10T01:41:16.000Z",
    "unavailableReason": null
  },
  "coverage": {
    "subjectAltName": "DNS:revoked.grc.com, DNS:www.revoked.grc.com",
    "coversRequestedHost": true,
    "matchedVia": "revoked.grc.com",
    "coversApex": false,
    "coversWww": false,
    "wwwResolves": true
  },
  "tls": {
    "protocol": "TLSv1.2",
    "cipher": "ECDHE-RSA-AES256-SHA384",
    "alpn": null
  }
}
```
