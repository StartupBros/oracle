# Upstream relationship

- **Upstream:** https://github.com/steipete/oracle
- **Divergence (as of 2026-07-24):** +15 ahead / -86 behind upstream default branch
- **Fork type:** Contribution/maintenance fork
- **Sync cadence:** Manual.

## StartupBros-specific delta

Intentional differentiated fork of the oracle browser bridge, used by the pro-gate review ladder.

## Why this file exists

An org-wide audit on 2026-07-24 found that comparing only the *default* branch made
several forks look like zero-delta mirrors when they actually carried unmerged
StartupBros fixes on side branches. Any future fork-pruning pass must enumerate and
author-check **all** branches, not just default-branch ahead/behind.
