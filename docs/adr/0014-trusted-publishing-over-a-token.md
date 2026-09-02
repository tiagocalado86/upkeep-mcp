# 14. Trusted publishing, not a token in a repository secret

Status: accepted (2026-09-02)

## Context

The release workflow was written to publish on a version tag using an npm
automation token held in the repository secret `NPM_TOKEN`. That is the shape
almost every npm publishing guide still teaches, and it is the shape this
project shipped in 0.3.1 — untested, because the first publish had not happened
yet and a token cannot be issued for a package that does not exist.

Attempting that first publish is what exposed the problem. npm now refuses a
publish that is not backed by two-factor authentication, and offers exactly two
ways to satisfy it: an interactive 2FA challenge, or a granular access token
with 2FA bypass enabled. The second is the one CI can use, and it is being
withdrawn:

- **31 July 2026** — bypass-2FA tokens lost the ability to perform sensitive
  account, package and organisation operations.
- **January 2027** — they lose direct publishing. What remains is reading
  private packages and staging a publish that a human then approves with 2FA.

So the documented setup for this workflow had a known expiry roughly four months
out, and the secret it depended on had not yet been created. Building it and
then migrating would have meant doing the work twice and leaving a long-lived
credential in the repository in between.

## Decision

Publish over **OIDC trusted publishing**. GitHub Actions presents a short-lived
identity token; npm exchanges it for a credential scoped to that one publish,
having checked that the request comes from the repository and workflow file
named on the package's settings page.

No `NPM_TOKEN`. No repository secret of any kind for releases.

## Consequences

- There is no long-lived publish credential to leak, rotate, or discover has
  expired at the moment a release is wanted. This is the same reasoning that
  keeps credentials out of the server itself (principle 1); it was worth
  applying to the pipeline that ships it.
- Provenance stops being a flag and becomes a property. npm attaches an
  attestation to a trusted publish by itself, so `--provenance` is gone from the
  command rather than being something a future edit could quietly drop.
- The workflow installs `npm@latest` before publishing. Trusted publishing needs
  npm 11.5.1 or newer and `actions/setup-node` with Node 22 still provides
  10.x — an unpinned upgrade in CI, accepted because the alternative is pinning
  a version that goes stale silently and because the gate runs first.
- The trusted publisher is configured on npmjs.com, not in this repository, and
  **npm does not validate it when it is saved**. A typo in the workflow filename
  surfaces as a failed release, never as a warning. Renaming this file breaks
  publishing until the setting is updated to match.
- The first publish of a package still cannot use it: the configuration lives on
  a package page that does not exist yet. `0.3.1` was therefore published by
  hand under an interactive 2FA challenge, and every release after it is
  automated.
- Publishing now requires 2FA on the maintainer account, which the CLI could not
  enable — `npm profile enable-2fa` is refused for a browser-issued session.
  Enrolment is a web operation, and the recovery codes are the only way back
  into an account that owns a package name.
