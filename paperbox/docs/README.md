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
| [register.md](register.md) | Every load-bearing claim, with its status: measured, projected, assumed, decided, disproved |

## Status at a glance

**Built, tested, deployed** — 159 tests passing.

- Path-derived identity with a metadata override
- The sync hash tree and a one-request diff endpoint
- Staged commits, so a failed download cannot blend two sources
- Per-chapter provenance with history
- Scoped scans with visible progress
- A consolidated status envelope keyed on content signals
- Read state, keyed `(reader, chapter)`, written and read by the compat API
- One selective-sync rule: keep the N most recent unread chapters of a series

**Designed but not built.**

- Selective sync rules beyond the one rolling window — see [rules.md](rules.md)
- Registry binding and series matching — see [upstream.md](upstream.md)
- Scan scheduling and the deep/verify tiers — see [sync.md](sync.md)

**Known gaps that block whole groups of users.**

- No archive (CBZ) support, which excludes every Kavita and Komga library
- `readstate.db` has no home in the compose file, so read state — the one thing
  here that cannot be rebuilt by rescanning — is not persisted unless someone sets
  `READSTATE_DB` by hand
- No delete endpoints for a chapter or a series

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
