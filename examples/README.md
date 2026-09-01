# Examples

Real, unedited output from each tool, captured against public control targets —
never a client site. Regenerate them after a behaviour change so they stay true.

| File                               | Target               | What it shows                                                             |
| ---------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| [domain-check.md](domain-check.md) | `example.com`        | A healthy registration: expiry, registrar, nameservers, signed delegation |
| [ssl-check.md](ssl-check.md)       | `expired.badssl.com` | An expired certificate, reported rather than refused                      |
| [uptime-check.md](uptime-check.md) | `http://github.com`  | An HTTP→HTTPS upgrade, the redirect chain and the HSTS policy             |
| [seo-audit.md](seo-audit.md)       | `example.com`        | A page with no description, no canonical, no sitemap and no robots.txt    |
| [portfolio-report.md](portfolio-report.md) | three public domains | A whole portfolio ranked by urgency, with the sites that need nothing named |
| [accessibility-audit.md](accessibility-audit.md) | the W3C's "before" demo page | A page built to fail: which WCAG rules, how many elements, and where |
| [conversation.md](conversation.md) | a five-site demo portfolio | A whole session: the weekly triage, a drill-down, a quick pass, and what the comparison will and will not claim |

Every file but the last shows the call, the text a person reads in the
conversation, and the structured content a script or a later tool consumes.
`conversation.md` is a dated capture of a whole session: the tool output in it is
verbatim, the wording around it is what the assistant said.
