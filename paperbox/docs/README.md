# Paperbox — design documentation

Written 2026-08-27, after a day that started with "chapter 71 is showing the wrong
comic" and ended somewhere quite different.

## What is here

| Document | Covers |
|---|---|
| [architecture.md](architecture.md) | The three layers, identity, and why the folder tree is the source of truth |
| [sync.md](sync.md) | Change detection, the hash tree, scan tiers, the two progress domains |
| [upstream.md](upstream.md) | Registries, sources, matching, and what "upstream" actually means |
| [rules.md](rules.md) | Selective sync — what a client keeps and how it says so |
| [ui.md](ui.md) | Interface decisions — the state language, failure, the shelf, client boundaries |
| [decisions.md](decisions.md) | What was decided, what was rejected, and what is still open |
| [scheduler.md](scheduler.md) | The rolling partial scan — lanes, budget, and what the user is told |
| [register.md](register.md) | Every load-bearing claim, with its status: measured, projected, assumed, decided, disproved |

## Status at a glance

**Built, tested, deployed** — 267 tests passing.

- Path-derived identity with a metadata override
- The sync hash tree and a one-request diff endpoint
- Staged commits, so a failed download cannot blend two sources
- Per-chapter provenance with history
- Scoped scans with visible progress
- A consolidated status envelope keyed on content signals
- Read state, keyed `(reader, chapter)`, written and read by the compat API
- One selective-sync rule: keep the N most recent unread chapters of a series
- A derived-artefact store outside the library: covers, spine art and per-chapter
  dominant colour, content-addressed so a stale artefact cannot be addressed
- A persistent job queue with progress, cancellation and an ETag'd `/api/jobs`
- The rolling partial scan from [scheduler.md](scheduler.md), under one
  concurrency and duty budget shared with the artwork workers

**Designed but not built.**

- Selective sync rules beyond the one rolling window — see [rules.md](rules.md)
- Registry binding and series matching — see [upstream.md](upstream.md)
- The deep and verify scan tiers — the rolling scan runs the quick tier only,
  see [scheduler.md](scheduler.md)

**Known gaps that block whole groups of users.**

- No archive (CBZ) support, which excludes every Kavita and Komga library
- Read state is deliberately absent server-side; every chapter reports unread.
  Removed 2026-08-28 — see `decisions.md`.
- No delete endpoints for a chapter or a series
- Nothing detects a page file that is not an image. 19 `.jpg` files in this library
  are HTML error pages a download wrote as artwork (R-38), and page count does not
  reveal it

## The incident these documents came from

A user opened chapter 71 of one series and saw a different comic entirely.

The files were correct. Every byte on disk matched what the source served, and the
chapter banners were right. What had failed was **identity**: manga ids were array
positions from a directory scan, the library's shape changed, and a client holding
id 3 for one series later resolved it to another. Refreshing could not fix it,
because refresh re-fetches the chapter list *for the id the entry holds* — and the
id itself was wrong.

Almost everything in these documents follows from that: identity must be derived
from content, never from position, and a system that reports confidence must be
able to prove it.

Along the way the same source turned out to have served byte-perfect files of a
completely different comic across seven chapters, which is why nothing here treats
"the server is confident" as "the server is right".
