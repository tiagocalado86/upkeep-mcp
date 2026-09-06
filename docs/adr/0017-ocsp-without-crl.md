# 0017 — Revocation over OCSP, and not over CRL

Status: accepted.

## Context

A TLS handshake cannot tell you whether a certificate has been revoked. Node
performs no revocation lookup of any kind, so a certificate withdrawn an hour ago
completes a handshake and comes back `authorized: true`. Until this change
`ssl_check` said so plainly — `revocationChecked: false`, "Revocation is not
checked" — which was honest and still meant the tool reported a revoked
certificate as healthy. `revoked.grc.com` is the demonstration: the chain
verifies, every date is in range, and the certificate has been revoked since
September 2025.

Two mechanisms exist for asking. **OCSP** (RFC 6960) is a question about one
certificate, answered in a few hundred signed bytes. A **CRL** is the
authority's list of every serial it has ever revoked, published as one file.

The ground shifted in 2025. The CA/Browser Forum made OCSP optional, and
Let's Encrypt and Google Trust Services both shut their responders down and moved
to CRLs with short-lived certificates. Measured against live hosts while writing
this: DigiCert, Sectigo and SSL.com still publish OCSP responder URLs; Let's
Encrypt and Google Trust Services publish none at all. For a portfolio of small
client sites, that second group is most of it.

## Decision

Check revocation over OCSP only, and report the certificates that cannot be
checked as unchecked, with the reason.

**Prefer the stapled response.** `tls.connect({ requestOCSP: true })` asks the
server to include the authority's signed answer in the handshake. A server that
staples has already asked on the client's behalf, so the question is settled for
the cost of one TLS extension and no request at all. Only when there is no staple
is the responder in the certificate's Authority Information Access extension
asked directly.

**Believe an answer only once it verifies.** An OCSP response travels over plain
HTTP by design; the authority's signature, not the transport, is what makes it
evidence. The signature is checked against the issuing certificate, or against a
delegated responder certificate carried in the response — and that delegate is
only accepted once it is shown to have been issued by the same authority and to
carry the OCSP-signing extended key usage. Without that second condition, any
certificate the authority ever issued, including one for an ordinary website,
could sign revocation answers for the whole authority.

**Match the `CertID` before believing anything.** A stapled response arrives from
the same server that chose the certificate. Serving a revoked certificate
alongside a genuine, correctly signed response about a _different_ certificate is
the obvious way to fake a clean result, and refusing it costs one hash.

**Say nothing when there is nothing to say.** A certificate whose authority
publishes no responder produces an `unavailableReason` and no finding. It is not
a defect, it is not actionable by the site owner, and a finding there would land
on nearly every row of a portfolio report — the same reasoning that made an absent
DMARC record `info` rather than `warning` in 0.4.1. A responder that _was_ asked
and would not answer is a different thing: something that normally works did not,
and that gets one `unknown`.

## Consequences

A revoked certificate is now found on every host whose authority still runs a
responder, and it ranks `critical` — above an expiry, because a revoked
certificate is broken now rather than on a date in the future.

Most sites in a typical portfolio will report `checked: false` forever, and the
report has to be readable in that state. This is why `RevocationReport` is shaped
like `RdapRegistration`, with an `unavailableReason` rather than a bare boolean:
"could not be established" and "established to be fine" must not look the same,
and neither may look like a problem when it is not one.

DER parsing is now part of this project (`src/lib/der.ts`). That was the real
cost of the decision. It is about 150 lines and understands definite-length tags
and nothing else, because OCSP is a closed grammar of a dozen structures — much
closer to `robots.txt` (`0009`) than to HTML (`0008`), and a hand-written reader
avoids adding a dependency to the one part of this project that parses bytes a
stranger's server chose. It refuses indefinite lengths, refuses a length that
would run past its buffer, and never recurses.

## What was rejected

**Downloading CRLs.** It would cover the Let's Encrypt majority, and it is the
reason to revisit this decision one day. It is rejected for now because the cost
is wrong at the point of use: a shard of an authority's CRL is hundreds of
kilobytes to megabytes, fetched to answer one question about one certificate,
and a twenty-site `portfolio_report` would pull all of them. Doing it properly
means caching CRLs across runs and verifying each one's signature and freshness —
a larger feature than this one, not a fallback inside it.

**Sending a nonce.** RFC 6960 allows a request to include one, and it is what
would make an answer provably fresh rather than merely signed. Large authorities
pre-sign their answers and serve them from a CDN, so a nonce is either ignored or
refused; asking for one buys replay protection from nobody and costs answers from
several. `producedAt` and `thisUpdate` are reported instead, so the age of the
answer is visible.

**Signing the request.** RFC 6960 makes it optional and every public responder
accepts anonymous queries. Signing means holding a key, which principle 1 forbids
outright.

**RSASSA-PSS signatures.** Its parameters live in the algorithm identifier rather
than in the OID, so verifying one means a second parser for salt length and mask
function. No public responder has been observed using it; a response signed that
way is reported as unverified rather than misread.
