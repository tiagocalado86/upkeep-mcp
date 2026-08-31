# 5. Cache in memory, with no database and no cache file

Status: accepted (2026-08-31)

## Context

RDAP and DNS are slow and change rarely, so caching is worth having. The brief
allows memory or a local file with a TTL, and rules out anything needing a database.

A file cache brings a state directory to choose, path configuration, concurrent
write handling between two clients running the server at once, and staleness bugs —
for a process that typically lives as long as one client session.

## Decision

In-memory TTL cache only (`src/lib/cache.ts`), roughly 50 lines, with the clock
injected so expiry is testable without fake timers.

The cache stores the in-flight **promise**, not the resolved value, so concurrent
misses collapse into one request. Checking twenty `.com` domains makes a single call
to `rdap.verisign.com`, not twenty.

TTLs: DNS records 5 minutes, negative DNS results 60 seconds, RDAP responses
6 hours, TLS probes 15 minutes. The IANA bootstrap file honours its own
`Cache-Control` and revalidates with `If-None-Match`. Uptime is never cached —
caching an uptime check defeats the tool.

## Consequences

- Nothing to install, no state on disk, no migration, and the public demo instance
  stays trivial to operate.
- A restart is a cold cache. For checks measured in seconds against data measured in
  months, that is not worth engineering around.
- Negative DNS results expire in a minute, so a delegation that has just been fixed
  does not appear broken for five.
- Phase 3's "what regressed since the last run" is **not** this cache. It is an
  explicit run-history store and gets designed separately.
