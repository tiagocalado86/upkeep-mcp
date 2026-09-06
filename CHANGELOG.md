# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`site_crawl`, a new tool: technical SEO across a whole site.**
  [`docs/adr/0010`](docs/adr/0010-one-page-audit-instead-of-crawl-depth.md)
  turned down the brief's `depth` parameter on `seo_audit` and closed by naming
  the way back — "if a real crawl is wanted later it arrives as its own tool,
  with its own budget, rather than as a parameter that quietly makes this one
  expensive". This is that tool.

  It reports what one page cannot say about itself. Which pages **share a
  title**, and therefore compete with each other for one search result — three
  of sitemaps.org's own pages call themselves "sitemaps.org - Home". Which share
  a meta description. Which internal links are broken **and which page links to
  them**, which is the half of a broken-link report that makes it fixable. Which
  pages still ask not to be indexed after a rebuild. And how much of the site
  was reachable at all.

  Breadth-first from a starting page, one origin, `robots.txt` read first and
  obeyed for every URL before it is requested — an unreadable one refuses the
  crawl outright, per RFC 9309. Three budgets bound it: pages, depth, and a
  two-minute deadline, and whichever one ended the crawl is reported along with
  how many URLs were found and not visited, because a report that does not say
  it saw a quarter of the site is worse than no report.

  One origin, never two, and it is the origin the crawl was told to start on
  rather than the origin of the page in hand: `example.com` and
  `www.example.com` are different origins, and a crawl that followed links
  between them would report one site's pages as duplicates of the other's —
  true, and useless. A page whose final URL leaves the origin is counted and its
  links are not followed, because `robots.txt` was read for one origin and does
  not speak for anybody else. A URL is remembered without its fragment, because a
  fragment never reaches the server, so `/about`, `/about#team` and `/about`
  again are one request — and two addresses that redirect to one page are one
  page, so a `/a` and `/a/` pair is not reported as two pages competing for the
  same title.

  Sequential rather than parallel, which costs nothing: the per-host limiter
  already serialises requests to one origin at one every half second, so
  concurrency would buy queueing rather than speed — and a parallel crawl
  overshoots its page budget by however many requests were in flight when the
  last one landed. Twenty-five pages is about fifteen seconds.

  **It is deliberately not part of `portfolio_report`**, and that is the point of
  it being a tool of its own: twenty-five pages for each of twenty sites is five
  hundred requests, a different order of thing from the one page per site a
  portfolio costs today.
  [`docs/adr/0021`](docs/adr/0021-a-crawl-as-its-own-tool.md) records that, and
  what the crawl still does not do — it executes no JavaScript, submits nothing,
  and guesses no URLs.

- **`domain_check` asks a domain's own nameservers whether they agree about it.**
  Every other check here goes through a recursive resolver, which answers with
  whatever one authoritative server told it and does not say which. Two faults
  are invisible from there and both are ones a retainer is judged on. A
  nameserver decommissioned after a migration and left in the delegation
  answers `REFUSED`, or its own hostname stops resolving, and every resolver
  query that lands on it is slow or fails. And nameservers holding different
  versions of the zone resolve correctly for some visitors and not others,
  intermittently — the outage a client describes as "it works for me but not for
  my colleague".

  Each nameserver is now asked for the zone's SOA directly, in parallel, with
  recursion off. The serial is the zone's version number, so two servers
  reporting different ones are serving different data whatever else they agree
  about.

  **Over TCP port 53, with the DNS message built and read in this repository.**
  `node:dns` cannot ask: `setServers` sends UDP, which `docs/deploying.md` has
  recorded since v0.3 does not leave Cloud Run, and it exposes no `AA` flag, so
  an answer a server is authoritative for cannot be told from one it repeated.
  DNS-over-HTTPS is no help either — a DoH endpoint is itself a recursive
  resolver. `src/lib/dns-wire.ts` is about 300 lines that understand a header, a
  question, resource records and name compression, and refuse a pointer that
  loops, a record claiming more data than it has, and a message larger than one
  may be. The same decision as `der.ts`, for the same reason: this parses bytes
  a stranger's server chose.

  **This opens a third port on the hosted instance**, which until now contacted
  443 and 80 and said so in four places, now all updated. The destination is not
  a caller's to choose: it is whatever the target domain's own NS records name,
  resolved and put through the same public-target guard as every other
  destination — an NS record pointing at `169.254.169.254` is exactly why that
  guard is not optional — and the question asked is fixed. `PUBLIC_PORTS` in
  `src/lib/public-target.ts` remains the whole list of what may be opened.

  **What is a fault and what is merely unestablished are graded apart, and
  getting that wrong would have been worse than not shipping this.** A resolver
  asks over UDP first and this server can only use TCP, so a nameserver that
  refuses TCP is not broken: `sapo.pt`'s four all refuse it and the domain
  resolves perfectly. That is `info`, or `unknown` when it is true of every one
  of them, and never a warning. A hostname that does not resolve, or an answer
  without authority for the zone, is broken for every resolver on the internet
  and is a warning.

  **Serials disagreeing is `info` too.** Two ordinary things produce it: a
  domain served by two providers that do not transfer between them —
  `github.com`'s NS1 servers report `1656468023` while its Route 53 servers
  report `1`, because Route 53 always reports `1` — and a zone changed a minute
  ago, which is what `gov.uk` was doing when this was written, its two sets 301
  apart and equal again later. A transfer stuck for a week is real and is worth
  reporting, it cannot be told from those two in one snapshot, and so the report
  says what it saw and what it means instead of grading a guess. Both gradings
  came from running the check against real domains; against fixtures every one
  of them would have read as a fault.

  Bounded like everything else: at most eight nameservers, in parallel, on a
  five-second deadline each, through the same per-host limiter, cached for as
  long as any other DNS answer. `checkNameservers: false` turns it off, and
  `portfolio_report` passes exactly that: a portfolio would pay up to eight TCP
  connections per site, and a deployment whose egress blocks port 53 would grade
  every site `unknown` at once — which outranks `info` and would reorder the one
  report whose job is to say what needs doing first. The
  parent's delegation is deliberately not compared with the zone's own — that is
  a second hop and a different feature —
  [`docs/adr/0020`](docs/adr/0020-asking-the-nameservers-over-tcp.md) records
  that and the rest.

- **`seo_audit` checks the sitemap against the rules of the protocol.** A file
  that answers `200` and parses is not the same as a file that works, and the
  check could not tell them apart: it counted `<loc>` elements and called that a
  sitemap. A root element with no `http://www.sitemaps.org/schemas/sitemap/0.9`
  namespace is dropped whole by anything reading it strictly; an entry on
  another host is discarded; a single unescaped `&` makes the document
  ill-formed XML and costs every entry after it. All three read as perfectly
  healthy to a check that counts entries, and all three are what a maintenance
  retainer is supposed to catch.

  The rules checked are the ones that decide whether a consumer keeps an entry:
  the namespace; `<loc>` present, absolute, escaped, within 2048 characters and
  on the host the sitemap was served from; `<lastmod>` a W3C Datetime; the seven
  values of `<changefreq>`; `<priority>` within 0.0 to 1.0; the 50,000-entry
  limit; and no `<url>`-only element inside an index entry.

  **Each is graded by what it costs.** A rule that drops the entry or the file
  is a `warning`; one whose value is merely ignored — a `<lastmod>` written
  `07/09/2026`, a `<changefreq>` of `often` — is `info`, because a portfolio
  report ranked by severity must not bury a certificate expiring on Friday under
  a page of sitemap pedantry. Defects are aggregated by rule and carry a count
  and one example: a mistake in a template breaks one rule in fifty thousand
  entries, and the report says so once.

  Two gradings came from running the checks against real sitemaps rather than
  fixtures, which is the only place a false alarm shows up. `cloudflare.com`
  declares its namespace as `https://www.sitemaps.org/...`, which is strictly a
  different namespace — a namespace is an opaque identifier, not an address that
  gets fetched — but every large consumer accepts it, so it is reported with the
  explanation and graded `info` rather than as a file nobody reads. An entry on
  the `www` sibling of the sitemap's own host is graded the same way, below an
  entry on a stranger's host. Against sitemaps.org, nytimes.com, gov.uk,
  wordpress.org and vercel.com the checks reported nothing at all; against
  nodejs.org they reported eight pages listed on a host the sitemap is not
  served from, which are genuinely not being submitted by that file.

  There is no XML parser and no schema validator, so this is not XSD validation
  and four rules are deliberately left unchecked — the 50 MB size limit, an
  index that lists another index, duplicate entries, and whether a `<lastmod>`
  is true. [`docs/adr/0019`](docs/adr/0019-sitemap-rules-without-a-schema-validator.md)
  records the decision and lists them.

### Changed

- **The release workflow waits ten minutes for npm, not two and a half.** The
  registry job checks that npm is serving the version before it lists it,
  because the registry validates a listing against the package. v0.5.0 outlasted
  that window: the publish succeeded, the wait failed, and the listing had to be
  recovered by re-running the job — which is exactly the recovery the two-job
  split exists for, but it is a manual step in a release that is otherwise wired
  to the tag. The loop still leaves the moment npm answers, so a normal release
  is no slower.

## [0.5.0] - 2026-09-06

### Added

- **`seo_audit` reads a gzipped sitemap.** A `sitemap.xml.gz` is a gzip _file_,
  not a gzip-encoded response: it arrives with `Content-Type: application/gzip`
  and no `Content-Encoding`, so nothing in the HTTP stack unpacks it. Decoding
  those bytes as UTF-8 produced a page of replacement characters, and the check
  then reported a perfectly good sitemap as having no `<urlset>` root element —
  a broken sitemap where there was none, on a form the sitemaps protocol has
  always allowed and large sites use.

  The magic bytes decide, not the file name and not the content type. That is
  not fastidiousness: the New York Times declares
  `https://www.nytimes.com/sitemaps/new/news.xml.gz` in its `robots.txt` and
  serves it as plain `text/xml`, so keying on the extension would have unpacked
  XML and called a working sitemap broken. The first two bytes of a gzip member
  are the only thing here that is not a matter of opinion. An integration test
  pins that case.

  Unpacking is bounded twice. The compressed read was already capped at half a
  mebibyte; the unpacked size is now capped at sixteen, which is roughly thirty
  times that and comfortably past a full 50,000-URL sitemap at about ten
  megabytes of XML. Beyond it the document is refused with the reason, because a
  decompressor that trusts its input is the classic way to be handed a bomb.

  A gzip stream the read limit cut short still yields what decompressed cleanly,
  so an oversized sitemap gives a floor count rather than an error — the same
  contract the uncompressed path already had. One that unpacks to nothing at all
  says so in those words, rather than being passed on as an empty document and
  reported as having no root element, which of a gzipped file is true only in
  the least useful sense. Either way something was served and it is unreadable,
  so it is graded as a defect rather than as an absent sitemap.

- **`portfolio_report` can compare across restarts.** The previous run was kept
  in memory and nowhere else, which `docs/adr/0011` chose deliberately and for a
  good reason: a history file says which client sites were broken and when, and
  it is not something this server should put on someone's disk unasked. What that
  decision cost in practice turned out to be larger than it looked. A server
  started by a desktop client restarts whenever the client does, which for most
  people is daily, so "what changed since last time" answered "since you last
  opened this app" — and the quarterly report, the thing this whole project is
  arranged around, could not be produced from it at all.

  `docs/adr/0011` closed by naming the way out, and this is it: one line in the
  portfolio file.

  ```json
  { "version": 1, "history": "upkeep-history.json", "sites": [...] }
  ```

  The path is resolved beside the portfolio file rather than against the working
  directory, because a desktop client starts this server in `/` and "beside my
  sites.json" is the only reading anyone intends. One snapshot is written there,
  replaced on every run, created readable by the owner alone — the file names a
  person's clients and says which were broken, and a default umask would hand
  that to every other account on a shared machine. Without that line nothing is
  written at all, and the behaviour is exactly what it was.

  A baseline older than ninety days is refused rather than used. A quarter is the
  unit this project reports in, and past it the comparison stops meaning
  anything: every certificate has renewed twice, so "improved since March" in a
  weekly review is noise dressed as information. The refusal names the date and
  the age.

  Nothing here can fail a report. A history file that is missing, unreadable, or
  written by somebody else produces a sentence explaining which of those it is
  and a comparison against nothing; a file that cannot be written produces a note
  in the report. A run that found an expired certificate is worth having even
  when it cannot be filed, and the report now always says where its history is
  kept and why it had nothing to compare against when it had nothing — the field
  is `previousRunUnavailable`, and it exists because an empty list of regressions
  must never read as "nothing regressed".

  Still one snapshot and not a series. A trend over quarters remains a different
  feature with a different storage question, exactly as `docs/adr/0011` said.
  [`docs/adr/0018`](docs/adr/0018-opt-in-history-file.md) records what was
  decided and what was turned down — a state directory, an environment variable,
  a tool argument.

  The structural test that asserted "nothing in `src` writes to disk" now asserts
  that exactly one module does and that it writes only where its caller said, so
  a second writer or a default path fails the suite.

- **`ssl_check` checks whether a certificate has been revoked.** It was the
  largest hole in the tool and the one the README named first: Node performs no
  revocation lookup of any kind, so a certificate withdrawn an hour ago still
  completes a handshake and still reports `authorized: true`. The previous
  release said so honestly — `revocationChecked: false` on every result — and
  still called a revoked certificate healthy. `revoked.grc.com` is the
  demonstration: the chain verifies, every date is in range, and the certificate
  has been revoked since September 2025. It is now `critical`.

  The answer is preferred where it costs nothing. `requestOCSP` asks the server
  to include the issuing authority's signed reply in the handshake itself, and a
  server that staples has already put the question to the authority on the
  client's behalf — one TLS extension, no request. Only a certificate with no
  staple has its responder asked directly, on its own six-second deadline,
  through the same target guard and per-host limiter as every other outbound
  call, and cached for an hour by certificate fingerprint rather than by host.

  Nothing is believed on sight. The signature is verified against the issuing
  certificate, or against a delegated responder certificate carried in the
  response — and a delegate is only accepted once it is shown to have been issued
  by the same authority _and_ to carry the OCSP-signing extended key usage,
  without which any certificate that authority ever issued could sign revocation
  answers for the whole authority. The `CertID` is matched against the
  certificate actually served, because a server serving a revoked certificate
  alongside a genuine signed response about a different certificate is the
  obvious way to fake a clean result, and refusing it costs one hash. An answer
  that verifies against nothing is reported with `checked: false` and ranks below
  a fact rather than being discarded or believed.

  **Most healthy certificates will report `checked: false` forever, and that is
  not a finding.** Since 2025 Let's Encrypt and Google Trust Services publish no
  OCSP responder at all and distribute revocation by CRL, which between them is a
  large share of a small-business portfolio. Grading that would put an
  unactionable line on nearly every row of a `portfolio_report` — the same
  reasoning that made an absent DMARC record `info` in 0.4.1, taken one step
  further to no finding at all. A responder that _was_ asked and would not answer
  is a different thing and gets one `unknown`, so the report distinguishes "there
  was nobody to ask" from "I asked and got nothing".

  Certificate revocation lists are deliberately not downloaded, and
  [`docs/adr/0017`](docs/adr/0017-ocsp-without-crl.md) records why: a CRL shard is
  hundreds of kilobytes to megabytes fetched to answer one question about one
  certificate, and doing it properly means caching and verifying CRLs across runs
  — a larger feature than this one, not a fallback inside it.

  This adds DER parsing to the project (`src/lib/der.ts`), which was the real cost
  of the decision. About 150 lines that understand definite-length tags and
  nothing else: OCSP is a closed grammar of a dozen structures, much closer to
  `robots.txt` than to HTML, and a hand-written reader keeps a dependency out of
  the one part of this project that parses bytes a stranger's server chose. It
  refuses indefinite lengths, refuses a length running past its buffer, and never
  recurses.

  Verified against live authorities as well as recorded fixtures: DigiCert
  stapling a good answer, Sectigo answering GitHub's certificate on request,
  SSL.com and Certera both reporting their own deliberately revoked test hosts as
  revoked over RSA and ECDSA, and Let's Encrypt correctly reported as having no
  responder to ask.

## [0.4.1] - 2026-09-05

### Added

- **`domain_check` reads SPF and DMARC.** Email authentication is the recurring
  complaint of anyone maintaining client sites — "the contact form's mail goes
  to spam" — and until now the tool returned the TXT records that answer it
  without interpreting them. It now reports what each record says: which servers
  SPF authorises and what it tells receivers about the rest, whether DMARC
  exists, whether it enforces or only watches, and where its reports go.

  It costs one extra DNS query. DMARC lives at `_dmarc.<domain>`, which rides in
  the same parallel batch under the same deadline as the other eight, so the
  ninth question adds no wall-clock. SPF was already in the TXT set.

  The severity split is deliberate. An **absent** record is `info`: it is a
  standing improvement, and `portfolio_report` ranks a whole portfolio by
  severity, so grading every client without DMARC as a warning would bury the
  certificate expiring on Friday. A record that is **present and wrong** is a
  `warning`, because it fails now — two SPF records make receivers skip SPF
  entirely, and `+all` is worse than publishing nothing at all.

  The SPF lookup count is reported as a lower bound and only warned on once it
  already exceeds the limit of ten that receivers enforce. Counting the true
  total means following `include:` into other people's zones; a bound that is
  provably over is worth reporting, and a guess is not.

  **DKIM is deliberately absent.** A DKIM key lives at `<selector>._domainkey`
  and a selector cannot be discovered, only guessed one query at a time — which
  is subdomain enumeration, ruled out by principle 3. A domain with no DKIM and
  one whose selector was not guessed stay indistinguishable rather than the
  second being reported as the first.

  Verified against live DNS as well as fixtures: `github.com` counts 8 lookups
  without counting its many `ip4:` terms, and `example.com` is correctly flagged
  for publishing a DMARC policy with no `rua` address.

### Changed

- **The MCP registry listing is published by the release workflow.** It was the
  one step still done by hand, and it behaved the way hand-done steps do: npm
  and the hosted instance reached 0.4.0 while the registry still offered 0.3.3 —
  three versions back, so anyone who found the server there installed one
  without the request guard that 0.3.5 shipped as a security fix.

  A tag now lists the release as well as publishing it. `mcp-publisher` — a Go
  binary from the registry's own releases, not an npm package — authenticates
  with `login github-oidc` against the same short-lived identity npm already
  uses, so this adds no secret to the repository. It runs as a separate job that
  first waits for npm to serve the new version, because the registry validates
  the listing against the package; separate, because `npm publish` cannot be
  repeated for a version that already exists, and a registry failure has to be
  re-runnable on its own.

## [0.4.0] - 2026-09-05

### Added

- **The hosted instance runs `accessibility_audit`.** The published image ships
  the Chromium headless shell, and every tool now answers the same there as on
  your own machine. The rule that decided it is the owner's: someone who cannot
  run a server themselves should not get a weaker tool than someone who can, so
  one tool answering "not here" was a defect rather than a documented limit.

  `--only-shell` installs 196 MB where the full browser is several hundred more,
  and `chromium.launch({ headless: true })` uses it — verified against a browser
  directory containing nothing else. The base image moves from Alpine to Debian,
  which is forced rather than preferred: `playwright-core` publishes no musl
  build, so installing on Alpine succeeds and the browser dies at launch. The
  deployment moves to `--memory 1Gi` and `--execution-environment gen2`, the
  latter because gen1's gVisor is where a browser is most likely to fail.
  Chromium started there without `--no-sandbox`, so that flag is deliberately
  absent and its own sandbox is intact.

  What made this safe was the request guard released in 0.3.5.
  [ADR 0016](docs/adr/0016-a-browser-in-the-published-image.md) records the
  reversal, the measured cost — over 18,000 audits a month inside the free tier
  — and what would reopen it.

### Fixed

- `seo_audit` and `accessibility_audit` reported a refused target as
  `unexpected`, which tells a caller the server broke when what happened is that
  they asked for an address it will not contact. Both fetch `robots.txt` before
  anything else, and on a public instance that is where the target guard
  refuses; the refusal escaped a function whose contract says it never throws,
  so the outer wrapper never saw its category. The message was right and the
  code was wrong — and the code is what a client branches on. Found by calling
  the deployed instance rather than by any test.

## [0.3.5] - 2026-09-05

### Fixed

- The browser used by `accessibility_audit` made unchecked requests. The target
  guard inspected the page's own URL and nothing else, so every script, image,
  font and stylesheet that page embedded was fetched without passing any policy
  — and an `<img src="http://169.254.169.254/…">` was enough to make the server
  request cloud metadata from its own address, with whether it loaded observable
  from the page. Every request the browser makes now goes through the same
  `assertReachable` as the rest of the project, and one it refuses is aborted.
  Decisions are memoised per origin — host and port together, since a different
  port on an allowed host is a different decision — so a page pulling forty
  files off one CDN resolves that hostname once.

  This was reachable today by anyone running the HTTP entrypoint with a browser
  installed, not only by a future hosted instance.
  [ADR 0013](docs/adr/0013-playwright-core-and-an-optional-browser.md) recorded
  the gap as accepted and now records it as closed, along with what remains: the
  guard resolves a name and the browser then requests by name, which ADR 0012
  already covers.

## [0.3.4] - 2026-09-05

### Added

- The README now names the hosted instance, and says what it is: a demo that may
  be switched off, with `npx -y upkeep-mcp` as the supported way to run this. The
  section it lives in is rewritten to separate pointing a client at that URL from
  running an HTTP instance yourself, and to state plainly that a hosted caller
  gets the same answers a local one does — except `accessibility_audit`, which
  needs a browser the image deliberately does not ship.

### Fixed

- `domain_check` reported that a domain publishes no CAA record when what had
  actually happened is that it could not find out. On Cloud Run the platform
  resolver answers A, AAAA, NS, MX and TXT and declines record type 257, and
  `optional()` turns any failed query into an empty result — so the hosted
  instance described `google.com` and `github.com`, which publish CAA, as
  publishing none. An empty CAA set is how a domain with no certificate-issuance
  restriction looks, so the failure arrived in the shape of a clean answer.
  CAA is now asked over DNS-over-HTTPS whenever the resolver returns none, using
  the endpoint already there for DS records. A hosted instance answers what a
  local one does, which is the point: nobody should get a weaker check because
  they cannot run the server themselves.

  The fallback is composed in `ports.ts`, alongside the DS lookup, rather than
  inside `resolveRecords`. That function races every query against a single
  deadline, so a third party inside the race can spend the whole budget and
  reject a lookup whose other five record sets had already arrived — and
  `domain_check` reads a rejected lookup as `domain_does_not_resolve`, critical.
  A slow endpoint would have promoted a healthy site to the top of a portfolio
  report. Composed outside it, the fallback runs only after the lookup has
  succeeded, cannot fail it, and is paced by the same per-host limiter as every
  other third-party call — without which a twenty-site run would have opened
  twenty unpaced requests at one endpoint, and a throttled answer reads as `[]`,
  which is the silent absence this entry is about.

## [0.3.3] - 2026-09-05

### Fixed

- A portfolio run with `seo_audit` enabled was roughly four times slower than
  the pacing it advertises. The per-host limiter woke one waiter per freed slot,
  from the front of the queue — and because a page's whole link list is
  dispatched at once, the front of the queue is almost always another request to
  a host that is already busy. The wake-up was spent on a waiter that could not
  move, and the slot idled until something else finished. It now wakes every
  waiter and lets the same admission check decide, which changes no limit: still
  one request in flight per host, half a second apart, five across all hosts.
  Twenty sites with every check but accessibility went from 6.5 minutes to
  1 minute; the offline reproduction went from 3.7x the ideal wall clock to 1.0x.

### Changed

- `accessibility_audit` on a hosted instance told the caller to run
  `npx playwright install chromium`, which is the fix on the machine the server
  runs on and unfollowable by someone connecting to somebody else's — it read as
  a broken deployment rather than as a documented limit. A public instance now
  answers that it runs no browser, that every other check still works, and that
  auditing a page means running the server yourself. The tool's description says
  the same thing before anyone calls it.

- [ADR 0013](docs/adr/0013-playwright-core-and-an-optional-browser.md) is
  amended for a container that is no longer only a demo: the decision not to
  ship a browser survives the change, the guard gap is stated as what it is —
  subresources bypass the port rule, because only the page's own URL is
  checked — and the reason adding Chromium is not a one-line change is written
  down. `playwright-core` has no musl build; `playwright install` succeeds on
  Alpine and the browser dies at launch.

- The documented Cloud Run deployment moves to a European region, pins the
  execution environment and names its request timeout. The old command chose a
  US region to keep a free gibibyte of North American egress; priced out, that
  allowance is worth about half a cent a month to a server that pulls pages
  (ingress, free) and returns 5.6 KB reports, while the latency it cost applied
  to every outbound check. `docs/deploying.md` also gained the two things that
  bite on a first deploy — the `roles/run.builder` grant, whose absence reports
  itself as an internal platform error, and a logs exclusion, which is the one
  runaway cost that neither `--max-instances` nor a spend cap contains.

- Why the deployment target is Cloud Run is now written down in
  [ADR 0015](docs/adr/0015-cloud-run-as-the-deployment-target.md), along with
  what would reopen the question. It records one constraint found while
  checking: outbound UDP to arbitrary internet hosts does not leave Cloud Run,
  so the day `dns.ts` queries authoritative nameservers directly, every such
  query fails there — and `optional()` would report the failure as "no such
  record" rather than as an error.

## [0.3.2] - 2026-09-02

### Added

- The first version to actually reach npm, so `npx -y upkeep-mcp` works. 0.3.1
  described that install and could not deliver it: npm had begun requiring 2FA
  to publish, and had stopped enrolling authenticator apps, so the account
  needed a passkey and the first publish a browser challenge.

### Changed

- Releases publish over **OIDC trusted publishing** instead of an npm token in
  a repository secret. npm now requires 2FA to publish, and the one form of that
  a workflow could use — a granular token with 2FA bypass — loses the ability to
  publish in January 2027, so the documented setup shipped in 0.3.1 had an
  expiry date and a secret that had never been created. There is now no
  long-lived publish credential at all, and provenance is attached by npm rather
  than asked for with a flag. See
  [ADR 0014](docs/adr/0014-trusted-publishing-over-a-token.md).

- `portfolio_report` now says _why_ it could not compare part of a run, not only
  how much of it: `1 of 5 sites comparable; 4 of them measured different checks
last time — run two full reports back to back to compare them`. The count on its
  own reads as a fault and leaves the reader to guess; the reason, and the fix,
  do not. Sites the previous run did not check at all are counted separately,
  and both counts are in the structured output.

## [0.3.1] - 2026-09-01

### Added

- Everything needed to publish, so that installation becomes `npx -y upkeep-mcp`
  rather than four steps — the brief's first definition-of-done line, and the
  last one open.
  `playwright-core` downloads no browser on install, so that stays a small
  fetch. A second binary, `upkeep-mcp-http`, starts the Streamable HTTP
  entrypoint, which an installed package previously had no way to reach.
- `server.json` and the matching `mcpName`, for the official MCP registry, and
  `.github/workflows/release.yml`, which publishes on a version tag with npm
  provenance so the tarball is tied to the commit it was built from. The
  workflow re-runs the whole gate and refuses a tag whose version does not match
  `package.json`. Tests keep `server.json`, `package.json` and `SERVER_VERSION`
  from drifting apart.

### Changed

- `exports` no longer publishes the stdio entrypoint as the package's API:
  `import 'upkeep-mcp'` started a server. `.` is now the server factory and
  `./http` the HTTP entrypoint.
- The message for a missing portfolio file said "copy sites.example.json to
  sites.json", which is unactionable for anyone whose client started the server
  somewhere else — Claude Desktop starts them in `/`, so `sites.json` was looked
  for at `/sites.json`. Both the tool and the `portfolio://sites` resource now
  say where the path is resolved from, and `file` asks for a full path.

### Fixed

- The HTTP entrypoint answered _every_ path with the landing page and a 200,
  so a crawler, a browser asking for a favicon and a person with a typo were all
  told they had found something. Only `/` serves the page now; anything but
  `/mcp` is a 404 naming the endpoint.
- The public-target guard checked the port on the TLS path and nowhere else, so
  a public instance would have fetched `https://any-host:22/` and reported back
  whether the connection was refused — a port scan run from the deployment's
  address, wearing this project's `User-Agent`, needing no DNS trickery at all.
  Three documents claimed "only public addresses, only on port 443" while this
  was true. Every outbound path — `hop`, `text`, `robots`, `browser` and `tls` —
  now goes through one helper that checks host and port together, and
  `test/lib/ports.test.ts` asserts it for each of them. The rule is per scheme:
  443 over HTTPS, 80 over plain HTTP, because `uptime_check` exists partly to
  answer whether plain HTTP still answers and upgrades, and 443 cannot answer
  that. See `docs/adr/0012-public-target-guard.md`, which also records why the
  DNS-rebinding gap is accepted on Cloud Run specifically and what would change
  that.
- `SECURITY.md` still named `0.1.x` as the supported release.

## [0.3.0] - 2026-09-01

### Added

- `accessibility_audit`: axe-core over a headless browser, reporting the WCAG
  rules a page fails, how many elements fail each, and where they are. The
  browser is optional — `playwright-core` downloads nothing on install — so a
  machine without one gets an actionable message naming the single command that
  fixes it, and every other check keeps working. Browsers get their own
  concurrency pool: an audit holds a slot for seconds while the browser makes
  requests the limiter never sees, so sharing one starved every other check
  without pacing any browser traffic. See
  `docs/adr/0013-playwright-core-and-an-optional-browser.md`.
- A Streamable HTTP entrypoint, `src/http.ts`, for a public demo instance: the
  SDK's own handler behind a hand-written `node:http` adapter, so no HTTP
  framework joins the dependency list. It builds its tools on guarded ports,
  admits callers through a token bucket (60 a minute, burst of 20, 8 in flight
  across everyone), caps request bodies, answers a browser with a plain-text
  page, and shuts down cleanly on SIGTERM. The port comes from `--port`, never
  from the environment.
- A Dockerfile and `docs/deploying.md` for Google Cloud Run, chosen because it
  runs an ordinary container: edge runtimes cannot read a peer certificate, so
  `ssl_check` would be dead there while everything else looked fine.
- A target guard for public deployments: `createDefaultPorts({ publicTargetsOnly:
true })` refuses any host resolving outside public unicast space — loopback,
  private ranges, and the link-local address where cloud metadata lives — and
  opens no port but 443. Off by default, because a local operator pointing the
  tool at their own staging box is the tool working as intended. See
  `docs/adr/0012-public-target-guard.md`, which also states the gap it leaves.
- `docs/prior-art.md`: the MCP servers that already check certificates, domains,
  uptime and accessibility, what several of them do better than this one, and
  the gap none of them fills — every one answers about a single target, and
  nothing aggregates a portfolio or reports what changed since the last run.

- `examples/conversation.md`: one portfolio session end to end — the Monday
  triage across five sites, a drill-down into the certificate that caused it, a
  quick uptime-only pass, and a second full run — with every tool output
  verbatim. `examples/accessibility-audit.md` joins it, captured against the
  W3C's own "before" demonstration page, which is built to fail.

### Fixed

- `portfolio_report` said nothing at all when it had compared this run against
  the previous one and found that nothing had moved. Silence was
  indistinguishable from a comparison that never happened, in the one tool whose
  reason to exist is answering "what changed since last time". It now always
  states the outcome, with how many sites were comparable: `No change since
2026-09-01T09:49:19.079Z (1 of 5 sites comparable)`.
- A finding that appeared on a site whose severity did not move was computed,
  put in the structured output, and never mentioned in the text — so a site that
  was a warning for an expiring registration and picked up an expiring
  certificate read as unchanged.
- `accessibility_audit` counted everything in the plural: "1 rules could not be
  decided automatically and need a person to look".

## [0.2.0] - 2026-09-01

### Added

- `seo_audit`: title and meta description with their lengths, heading structure,
  canonical, `lang`, viewport, Open Graph, `hreflang` alternates, images with no
  `alt` attribute, the state of `robots.txt` and the sitemap, and which internal
  links are broken. It audits one page and checks that page's internal links; it
  does not crawl. See `docs/adr/0010-one-page-audit-instead-of-crawl-depth.md`.
- `robots.txt` parsing and matching to RFC 9309, written here rather than taken
  from an unmaintained package, with path matching that cannot be made to
  backtrack by a hostile file. See
  `docs/adr/0009-own-robots-txt-implementation.md`.
- HTML parsing with `parse5`, so pages are read the way a browser reads them,
  broken markup included. See `docs/adr/0008-parse5-with-own-extraction.md`.
- A structural sitemap check that recognises the commonest failure: an HTML 404
  page served at the sitemap URL with a 200 status.
- `getText`, which reads a response body up to a byte limit and reports whether
  it was cut off, so no remote host decides how much this process allocates.
- `portfolio_report`: every check across a whole portfolio, with bounded
  concurrency, returned as one report ordered by what needs action first. Reads
  the portfolio inline or from a local JSON file, filters by tag, and reports
  what regressed since the previous run. A site that cannot be checked is a
  finding, not a failed report.
- The `portfolio://sites` resource, exposing the site list to a client without
  spending a tool call, and the `quarterly_report` prompt, which turns a
  portfolio run into the report a client reads.
- Comparison with the previous run, held in memory for the life of the server
  process and never written to disk. Only sites that both runs measured the same
  way are compared, and the report says how many that was: comparing a quick
  `checks: ["uptime"]` pass against a full run would otherwise report every
  certificate and registration finding as newly appeared — or, in the other
  order, announce that a site with a certificate expiring in three days had
  improved. See `docs/adr/0011-in-memory-run-history.md`.
- A site whose requested checks cannot all run reports them anyway, with
  `ran: false`; one whose checks can none of them run is `unknown`, never `ok`.
  A portfolio must not read as healthy having checked nothing.
- `maxLinks` per site in the portfolio file, and inline in `portfolio_report`:
  how many internal links the `seo` check may request, `0` for none. Measured
  over twenty public domains, a portfolio takes about eight seconds without
  `seo` and around forty with it, because link checking is one request per link
  paced at half a second per host — so the budget belongs to whoever owns the
  portfolio, not to a constant in the code.
- `npm run coverage`, and tests for the pieces that had none: the DNS record
  mapping, the certificate chain walk, error categorisation, the RDAP lookup
  path and the portfolio machinery.

### Fixed

- `uptime_check` reported a site as healthy when its redirect pointed at a host
  that could not be reached: the failed hop was swallowed and the result read
  `severity: ok`, `reachable: true`, no findings. A chain that stops dead is now
  a critical finding naming the URL that refused.
- `domain_check` reported "The domain does not resolve at all" — critical — when
  the DNS lookup had merely timed out, directly above the warning saying so. The
  empty records that stand in for a failed lookup are no longer read as fact,
  and `dnsResolved` says which happened.
- `ssl_check` read an unanswered DNS lookup as "www does not resolve", which
  switched off the www coverage check and passed a certificate that does not
  cover it. `wwwResolves` is now null when nothing was established, and the gap
  is reported.
- `seo_audit` never fetched a sitemap declared with a relative path, reporting
  "Invalid URL" instead; a sitemap on another host is now checked against that
  host's `robots.txt` before it is requested; a sitemap cut off at the read
  limit says so instead of reporting a partial count as the total; and switching
  link checking off no longer blames a limit of zero.
- `seo_audit` refuses a document nested thousands of levels deep instead of
  parsing it. HTML tree construction costs roughly the square of the nesting
  depth, so two mebibytes of `<div>` would have blocked the event loop for
  minutes — a hang any hostile page could trigger.
- A certificate with no common name is now named by its first subject
  alternative name, as `CertificateSummary` always claimed. The CA/Browser
  Forum deprecated the common name, so certificates that omit it exist, and they
  were being reported with no subject at all.

## [0.1.0] - 2026-08-31

### Added

- `domain_check`: registration expiry and registrar over RDAP, DNS records, and
  whether the delegation is signed with DNSSEC. Registries that publish no expiry
  date are named as such rather than reported as unknown.
- `ssl_check`: certificate expiry, issuer, chain validity, which hostnames the
  certificate covers and via which SAN entry, and the negotiated TLS version.
  Expired, self-signed and untrusted certificates are inspected, not refused. A
  certificate becomes a warning inside 14 days rather than 30, because ACME
  clients renew with 30 days left and the wider window would fire on healthy
  sites. A certificate whose dates cannot be read is reported as `unknown`, never
  as nothing wrong.
- `uptime_check`: status, response time, the full redirect chain, whether plain
  HTTP is upgraded to HTTPS, the HSTS policy and the security headers worth
  reporting on. Status codes are graded rather than lumped together: 5xx, 404 and
  410 are critical, 401 and 403 are a warning because they are normal for a
  staging site, and 429 is `unknown` because a throttled check establishes
  nothing.
- In-memory TTL caching that collapses concurrent lookups, and per-host rate
  limiting keyed by the host actually contacted. A DNS lookup that found nothing
  is held for a minute rather than five, so a delegation that has just been fixed
  is not reported as broken for the rest of the TTL.
- Every check returns its findings ordered worst first, so the order is a
  contract the aggregation in `portfolio_report` can rely on rather than an
  accident of the order things were detected in.
- `examples/` with real captured output from each tool, and
  `docs/architecture.md`.
- Project scaffolding: TypeScript in `strict` mode, ESM, ESLint, Prettier and
  Vitest, with a `npm run check` gate that runs all four.
- An MCP server over the stdio transport, built on the MCP TypeScript SDK v2.
- A `health` tool reporting the server name, version, Node.js version and
  uptime — enough to confirm a client is talking to the server.
- `guard`, a wrapper applied to every tool handler so that no exception can
  cross the MCP boundary.
- GitHub Actions CI running format, lint, typecheck, tests and build on
  Node.js 22 and 24.
- `CLAUDE.md` recording the project principles and conventions.
- `docs/adr/` recording the structural decisions, including the choice to ship
  without a WHOIS fallback and the move to a Node.js 22 baseline.

### Changed

- The minimum supported Node.js version is 22, not the 20 originally planned.
  Node 20 reached end of life on 2026-04-30, and every certificate and DNS API
  this release needs sits on that boundary. See
  `docs/adr/0003-node-22-baseline.md`.

[Unreleased]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.3.5...v0.4.0
[0.3.5]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.3.1...v0.3.3
[0.3.2]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.3.1...2767d10
[0.3.1]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tiagocalado86/upkeep-mcp/releases/tag/v0.1.0
