# A portfolio review, end to end

One session, captured on 2026-09-01 against a five-site demo portfolio. Every
block marked _tool output_ is verbatim: the questions and the replies around
them are what the conversation actually looked like.

The portfolio is public demo infrastructure, never a client list. Two of the
sites are there because they are reliably broken, which is what makes the report
worth reading:

| Site in the report  | Actually            | Why                                         |
| ------------------- | ------------------- | ------------------------------------------- |
| Example Ltd         | `example.com`       | Reserved by IANA for documentation          |
| Example Foundation  | `example.org`       | The same, and the only site with nothing wrong |
| Example Net         | `example.net`       | The same                                    |
| Legacy Shop         | `expired.badssl.com` | A certificate that expired in 2015          |
| Campaign Microsite  | The W3C's [Before and After Demonstration](https://www.w3.org/WAI/demos/bad/before/home.html) | A page built to fail accessibility rules |

---

**You:** It is the first Monday of the quarter. Anything on the retainer list
that needs me this week?

**Claude:** Running the whole portfolio.

```json
{
  "name": "portfolio_report",
  "arguments": {
    "sites": [
      { "name": "Example Ltd", "url": "https://example.com", "checks": ["domain", "ssl", "uptime"], "tags": ["retainer"] },
      { "name": "Example Foundation", "url": "https://example.org", "checks": ["domain", "ssl"], "tags": ["retainer"] },
      { "name": "Example Net", "url": "https://example.net", "checks": ["uptime"], "tags": ["retainer"] },
      { "name": "Legacy Shop", "url": "https://expired.badssl.com", "checks": ["ssl", "uptime"], "tags": ["retainer"], "notes": "Old storefront, kept online for order history." },
      { "name": "Campaign Microsite", "url": "https://www.w3.org/WAI/demos/bad/before/home.html", "checks": ["uptime", "accessibility"], "tags": ["retainer"] }
    ]
  }
}
```

_Tool output:_

```
5 sites checked: 2 critical, 2 warning, 0 unknown, 1 fine.

Needs action:
- [critical] Legacy Shop: The certificate expired 4160 days ago.
- [critical] Legacy Shop: The certificate chain does not verify: CERT_HAS_EXPIRED.
- [critical] Campaign Microsite: Images must have alternative text (33 elements, image-alt).
- [critical] Campaign Microsite: Select element must have an accessible name (1 element, select-name).
- [warning] Campaign Microsite: Links must have discernible text (7 elements, link-name).
- [warning] Campaign Microsite: Elements must meet minimum color contrast ratio thresholds (2 elements, color-contrast).
- [warning] Campaign Microsite: <html> element must have a lang attribute (1 element, html-has-lang).
- [warning] Example Ltd: Plain HTTP does not redirect to HTTPS.
- [warning] Example Ltd: No Strict-Transport-Security header is sent.
- [warning] Example Net: Plain HTTP does not redirect to HTTPS.
- [warning] Example Net: No Strict-Transport-Security header is sent.

Nothing comparable in this session yet, so no change is reported. A run is comparable only against one that measured the same sites the same way.

Nothing to do: Example Foundation.
```

Two things are urgent and the rest is housekeeping.

Legacy Shop is serving a certificate that expired eleven years ago, so a browser
refuses the site outright — the uptime check could not even complete, because
the connection never got past the handshake. That is the one to fix today.

Campaign Microsite fails five WCAG 2 AA rules, and 33 images with no alternative
text is the sort of thing that turns into a complaint rather than a ticket. It
is one page of work.

Example Ltd and Example Net both serve plain HTTP without redirecting to HTTPS
and send no HSTS header. Worth a line in the report, not worth an evening.

Example Foundation has nothing wrong.

---

**You:** What exactly is wrong with the Legacy Shop certificate?

**Claude:**

```json
{ "name": "ssl_check", "arguments": { "domain": "expired.badssl.com" } }
```

_Tool output:_

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

It is a wildcard certificate that does cover the host, issued by a CA that no
longer exists under that name, and it expired on 12 April 2015. Nothing is
misconfigured in a subtle way: renewal simply stopped happening. Whoever hosts
it needs to point an ACME client at it, or the site needs to come down.

---

**You:** I have asked the host to deal with it. While I wait — is anything
actually down right now?

**Claude:** That is the quick pass: uptime only, no certificates, no
registrations.

```json
{
  "name": "portfolio_report",
  "arguments": { "sites": [ /* the same five */ ], "checks": ["uptime"] }
}
```

_Tool output:_

```
5 sites checked: 0 critical, 3 warning, 1 unknown, 1 fine.

Needs action:
- [warning] Example Foundation: Plain HTTP does not redirect to HTTPS.
- [warning] Example Foundation: No Strict-Transport-Security header is sent.
- [warning] Example Ltd: Plain HTTP does not redirect to HTTPS.
- [warning] Example Ltd: No Strict-Transport-Security header is sent.
- [warning] Example Net: Plain HTTP does not redirect to HTTPS.
- [warning] Example Net: No Strict-Transport-Security header is sent.

No change since 2026-09-01T09:49:19.079Z (1 of 5 sites comparable).

Nothing to do: Campaign Microsite.
```

Nothing is down. Legacy Shop is the `1 unknown`: the request cannot complete
while the certificate is refused, and a check that established nothing is
reported as unknown rather than as a failure.

Read the comparison line carefully, because it is doing real work. This run
measured only uptime, so it could be compared against the full run on one site —
Example Net, the only one that asked for uptime alone both times. The other four
measured different things in the two runs and were not compared at all. That is
deliberate: comparing an uptime-only pass against a full run would have
announced that Legacy Shop's expired certificate had improved from critical to
fine, purely because this run never looked at it.

Example Foundation also picked up two warnings it did not have before. It did
not get worse — the first run never checked its uptime.

---

**You:** The host says it is fixed. Run everything again before I write the
client note.

**Claude:**

_Tool output:_

```
5 sites checked: 2 critical, 2 warning, 0 unknown, 1 fine.

Needs action:
- [critical] Legacy Shop: The certificate expired 4160 days ago.
- [critical] Legacy Shop: The certificate chain does not verify: CERT_HAS_EXPIRED.
- [critical] Campaign Microsite: Images must have alternative text (33 elements, image-alt).
- [critical] Campaign Microsite: Select element must have an accessible name (1 element, select-name).
- [warning] Campaign Microsite: Links must have discernible text (7 elements, link-name).
- [warning] Campaign Microsite: Elements must meet minimum color contrast ratio thresholds (2 elements, color-contrast).
- [warning] Campaign Microsite: <html> element must have a lang attribute (1 element, html-has-lang).
- [warning] Example Ltd: Plain HTTP does not redirect to HTTPS.
- [warning] Example Ltd: No Strict-Transport-Security header is sent.
- [warning] Example Net: Plain HTTP does not redirect to HTTPS.
- [warning] Example Net: No Strict-Transport-Security header is sent.

No change since 2026-09-01T09:49:21.224Z (1 of 5 sites comparable).
```

It is not fixed. The same certificate, the same expiry date, still refused.

Note what the comparison says here too: the previous run in this session was the
uptime-only pass, and only one site is comparable against it. The history holds
the last run, not a series, so a quick pass between two full runs is what gets
compared against. To compare two full runs, run them back to back.

---

**You:** Fine. Draft the quarterly note for the client.

**Claude:** That is what the `quarterly_report` prompt is for — it runs the
portfolio and then writes the client-facing text, in a fixed order: one
paragraph up front, then what needs a decision from them with dates and
consequences, then what was found and handled, then a table of every site.

In Claude Desktop or Claude Code it appears as a prompt named
**Quarterly maintenance report**, taking `period` (`"Q3 2026"`), optional `tags`
to limit it to part of the portfolio, and optional `language`.

The instruction it carries is deliberately strict about one thing: write nothing
the report does not contain, and where a check could not run, say so. A report
that quietly omits Legacy Shop would read better and be worse.

---

## What this shows

- One call answers "what needs me this week?" across the whole portfolio, worst
  first, with the sites that need nothing named at the end.
- A site that cannot be checked is a finding, not a failed report. Legacy Shop's
  uptime check could not run, and the report says so instead of reporting the
  site as fine or giving up on the other four.
- The comparison against the previous run refuses to compare unlike runs, and
  says how many sites it could compare. See
  [`docs/adr/0011-in-memory-run-history.md`](../docs/adr/0011-in-memory-run-history.md).
- Nothing here needed a credential, and nothing was written to disk.
