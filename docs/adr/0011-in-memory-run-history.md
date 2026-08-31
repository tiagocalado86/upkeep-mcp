# 11. Keep the previous run in memory, and nowhere else

Status: accepted (2026-08-31)

## Context

`portfolio_report` is asked to report "what regressed since the last run". That
needs the last run, which means state that outlives a single tool call.

The obvious implementation is a file: a small JSON snapshot beside the portfolio.
It survives restarts, it is cheap, and every monitoring tool does it.

It is also a file that says which client sites were broken, and when. The
portfolio file itself already names clients, but the user wrote that one and
knows where it is; a history file is something this server would create on their
disk without being asked. Principle 5 is "no persistent sensitive state", and a
record of which client had an expired certificate in March is exactly the kind of
state that principle is about.

## Decision

Keep one snapshot of the previous run in memory, for the life of the server
process. Compare against it when it exists. Say plainly when it does not.

## Consequences

- Nothing is written to disk. There is still nothing to leak from a compromise
  of this server beyond what its user handed it.
- Comparison works within a session — which is the case that matters, because a
  portfolio owner runs the report, fixes something, and runs it again.
- A restarted server has nothing to compare against. The output says so
  explicitly (`comparedWithPreviousRun: false`), and the text summary says it in
  words, because an empty list of regressions must never be readable as "nothing
  regressed".
- A snapshot records which checks it measured, per site, and a comparison is
  made only where both runs measured the same things. Two runs that looked at
  different checks are not comparable at all, and saying otherwise turns the
  quick `checks: ["uptime"]` pass the tool itself recommends into a page of
  invented regressions.
- Only the previous run is kept, not a series. A trend over quarters is a
  different feature with different storage, and it would need the user's
  explicit decision about where that data lives.
- If persistence is ever wanted, it belongs behind the same `RunHistory`
  interface, opted into by the user, and it needs its own ADR.
