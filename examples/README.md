# Examples

Real, unedited output from each tool, captured against public control targets —
never a client site. Regenerate them after a behaviour change so they stay true.

| File                               | Target               | What it shows                                                             |
| ---------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| [domain-check.md](domain-check.md) | `example.com`        | A healthy registration: expiry, registrar, nameservers, signed delegation |
| [ssl-check.md](ssl-check.md)       | `expired.badssl.com` | An expired certificate, reported rather than refused                      |
| [uptime-check.md](uptime-check.md) | `http://github.com`  | An HTTP→HTTPS upgrade, the redirect chain and the HSTS policy             |
| [seo-audit.md](seo-audit.md)       | `example.com`        | A page with no description, no canonical, no sitemap and no robots.txt    |

Each file shows the call, the text a person reads in the conversation, and the
structured content a script or a later tool consumes.
