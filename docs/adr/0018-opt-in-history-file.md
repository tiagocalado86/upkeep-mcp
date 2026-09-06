# 0018 — A history file, named by the user or not written at all

Status: accepted. Extends [`0011`](0011-in-memory-run-history.md), which stands.

## Context

`0011` decided to keep the previous portfolio run in memory and nowhere else,
and it was right about why: a history file says which client sites were broken
and when, and it is something this server would create on someone's disk without
being asked. It closed with the shape of the way out — "if persistence is ever
wanted, it belongs behind the same `RunHistory` interface, opted into by the
user, and it needs its own ADR". This is that ADR.

The cost of `0011` in ordinary use is larger than it looked when it was written.
An MCP server started by a desktop client is restarted whenever the client is,
which for most people is daily. "What changed since last time" therefore answers
"since you last opened this app", and the quarterly report — the thing the whole
project is arranged around — cannot be produced from it at all. A comparison that
never spans a restart is a comparison that never spans anything a retainer bills
for.

Principle 5 says "no persistent **sensitive** state", and permits "in-memory or
local-file caching with a TTL". The room was always there; `0011` chose not to
use it because there was no way to ask.

## Decision

Write one snapshot to one file, at a path the user names in their own portfolio
file, and write nothing otherwise.

```json
{ "version": 1, "history": "upkeep-history.json", "sites": [...] }
```

**The portfolio file is the consent.** It is the user's own file, in a location
they chose and already know; adding a line to it is a deliberate act in a way
that a default, a flag or an environment variable is not. Absent that line, the
behaviour is exactly `0011`: memory, lost on restart, and the report says so.

**The path is resolved against the portfolio file, not the working directory.**
A desktop MCP client starts this server in `/`, which `portfolio_report`'s own
input description already warns about. `"history": "upkeep-history.json"` has to
mean "beside my sites.json" or it means nothing anyone can predict.

**Owner-only permissions.** The file names a person's clients and says which of
them were broken. `0600` on creation, because the default umask on a shared
machine hands that to every other account on it.

**Ninety days.** A baseline older than a quarter compares this week against a
portfolio where every certificate has since renewed twice. Past the window the
snapshot is refused, and the refusal names the date and the age rather than
reading as a first run.

**One snapshot, still.** Not a series, not a trend. `0011` was right that a
history of quarters is a different feature with different storage, and nothing
here moves towards one: each run replaces the file.

**A report is never failed by its own bookkeeping.** A file that cannot be read
produces a reason and a comparison against nothing; a file that cannot be written
produces a note in the report. A run that found an expired certificate is worth
having even when it cannot be filed.

## Consequences

- Comparisons survive a restart for anyone who asks for it, which is what makes
  a quarter-over-quarter report possible at all.
- Something is now written to someone's disk, which was not true before. It is
  one file, at one path they typed, containing what a report already showed them
  on screen. `SECURITY.md` says so plainly rather than continuing to claim the
  server writes nothing.
- The structural test that used to assert "no module in `src` writes" now asserts
  that exactly one does, and that it writes only to the path its caller resolved.
  A second writer, or a default path, fails the suite.
- The file is machine-written and machine-read: it is validated on the way in and
  replaced when it does not validate, so editing it by hand is pointless rather
  than dangerous. A file this server did not write is ignored with a reason and
  overwritten by the run that found it, which is what keeps someone who points
  `history` at the wrong file from getting a silent, wrong comparison.
- A portfolio passed inline keeps no history. It has no file to sit beside and no
  identity to persist under, and inventing one would mean this server choosing
  where to write — the exact thing this decision exists to avoid.
- The hosted instance is unaffected, and not by a special case. A caller there
  passes their sites inline, and an inline portfolio resolves to memory, so no
  path through it reaches a file at all — the hosted instance is memory-only by
  construction rather than by a flag that could be forgotten. Someone running the
  published image themselves, with their own portfolio mounted, gets the same
  behaviour as a local install: a writable directory keeps history across
  restarts of that container, a read-only one produces the note saying the run
  could not be recorded, and the report says which it was either way.

## What was rejected

**On by default, in a state directory.** `~/.local/state`, `~/.cache` or the
equivalent. It would work for everybody without being asked, and that is exactly
the objection `0011` raised: a file naming a person's clients, in a directory
they did not choose, that they never agreed to.

**An environment variable.** Principle 1 is enforced by a test asserting that
nothing in `src` reads `process.env`, and the reason generalises: configuration
that lives outside the user's own files is configuration nobody can see.

**A tool input.** `portfolio_report` could take a `historyFile` argument. It is
more explicit per call and worse in use: the caller is usually a model, which
would have to pass the same path every time for a comparison to hold, and one
forgotten argument silently starts a new history. A setting belongs in the file
that holds the settings.

**A series of runs.** Rejected for the same reason as in `0011` — it is a
different feature, with a different storage question, and it should be asked for
on its own.
