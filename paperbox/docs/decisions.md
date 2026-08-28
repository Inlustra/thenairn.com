# Decisions

What was decided, what was rejected, and what is still open. Dated 2026-08-27.

## Settled

### Identity derives from the path; the sidecar overrides

Positional identity caused the incident that started all of this. Ids are now
`pathUid(dir)` → `hash31(uid)`, with `paperbox.json` able to pin them. Verified by a
test that deletes every sidecar and asserts ids are unchanged.

**Cost paid once:** the id scheme change invalidated every cached client id, so
existing clients had to remove and re-add their series. Batched deliberately.

### A chapter's number is a label, a sort key, and a sequence

Settled 2026-08-28. Blocks, gap arithmetic and the hold line all consume a "chapter
number" that no document previously defined. It is now three stored fields:

| Field | What |
|---|---|
| `label` | The string, verbatim from the directory name. Never lossy. |
| `sortKey` | Derived once and **stored**. Used for ordering and for block keying. |
| `sequence` | `main` by default. `Episode 001` and `Spin-off #001` coexist on disk today. |

**Stored, never derived at read time.** This is the load-bearing half. A read-time
derivation means that improving the parser later silently re-keys every block hash and
invalidates every client's held state, with no migration and no signal. Stored, a
parser change is a visible migration someone chooses to run. The id-scheme change
already forced a full client re-add once; this is how the second one is avoided.

**Why a string label and not a float.** Upstream chapter identifiers are strings, and
the vocabulary is wider than a number: `7c`, `14-19` (one release covering six
chapters), `10a-c`, `50.5`, `Oneshot`, and null *[measured against the MangaUpdates
releases API, 2026-08-28]*. A float silently discards most of that, and the discovery
would come as a block collision long after the fact.

**Default population:** strip the series title from the front of the chapter name,
then take the first digit run. On the real library this takes collisions from 14 of
1,706 chapters down to 4 *[measured]* — and the residue is not a parsing failure but
the spin-off sequence above. Per-series overrides: an explicit pattern, or
ordinal-within-sequence for genuinely unnumbered runs. Human override outranks all of
it, consistent with "human flagging outranks checksums".

**Blocks key on `(sequence, sortKey ÷ 25)`**, with two corrections made 2026-08-28
when the implementation was checked against this paragraph:

- **Chapter 0 is numbered.** `sortKey` 0 means "no number derived", but `mark` is what
  actually distinguishes the two cases: `Chapter 000` has `mark: "0"` (a number was
  read, and it was zero), `Oneshot` has `mark: ""` (nothing numeric exists). 4 of the
  12 live series open at chapter 0, and all four had their first chapter filed in the
  block labelled `unnumbered`. `sortKey === 0` with a non-empty mark now keys to
  block 1; an empty mark still keys to the unnumbered block, because a chapter with no
  number has no position on the number line to interleave it at.
- **A ranged directory is filed into every block it spans.** `Chapter 24-27` crosses
  the `1-25`/`26-50` boundary. It used to file only by `sortKey`, so `keySpan()`
  counted chapters 26 and 27 while the block labelled `26-50` did not contain them --
  this document asserted a span with no implementation behind it. The alternative was
  to delete `keyEnd`/`keySpan`; it was rejected because `sortKeyEnd` is derived by the
  parser, persisted in every `paperbox.json`, carried on the `Chapter` type and
  written by the download path, so removing its only two readers would have left the
  field, the storage and the ambiguity exactly where they were. The cost accepted in
  exchange: one chapter node hangs under more than one block, so `diff` visits each
  node id once and a ranged chapter dirties every block it touches.

**Rejected, with the evidence:**

| Rejected | Why |
|---|---|
| Ordinal position in a sorted list | Lexical order ≠ numeric order for 5 of 12 series (unpadded names sort `1, 10, 100`). Sorting numerically requires parsing a number first, which is circular. And insertion renumbers everything after it — the positional-identity bug that started this project, one layer up |
| Source-supplied | Available only for chapters Paperbox itself fetched. 11 of 12 series carry zero provenance, so it is empty for exactly the adopted libraries the product targets |
| Registry as the per-chapter authority | Its own identifiers are strings and ranges; mapping them onto our directories is a second matching problem, not a lookup. 2 of 12 series also matched *wrong* at "high" confidence |

**What upstream does supply.** `latest_chapter` — structured, reliable, and the
denominator in "you hold 313 of 327". Season structure exists too, but only as
markdown prose in a free-text `status` field (`**S1** : 142 Chapters (1~142)`), so it
is evidence for a person to confirm, never an automatic import.

### The hash tree, not a journal

See [sync.md](sync.md). Decided on scoping: a journal cannot be selective, and
selective sync is the normal case. `src/journal.ts` exists, is not wired in, and is
kept for reference only.

### Never reconcile below chapter granularity

Return `(chapter, page_count)` and let the client enumerate pages. Turns a 7.9 KB
response into ~150 bytes and makes every set-reconciliation sketch unnecessary.

### Blocks keyed by chapter number, not array position

25 per block. Prevents an insertion dirtying every block after it. A directory
covering a range belongs to every block in that range, not only the one it starts in.

### Node ids are versioned; `gone` is only meaningful within one version

`treeVersion`, on `/api/sync/tree` and on every `/api/sync/diff` result. It is the
shape version of the *ids*, not of the content.

Block ids changed from `b:<uid>:<start>` to `b:<uid>:<seq>:<start>` and nothing on
disk moved -- but a client that had synced before saw every id it held appear in
`gone` and every id we returned appear as `added`. A client reading `gone` as "the
server deleted this" would have thrown away a correct library on the strength of a
renaming.

**The contract: a `treeVersion` different from the one your `have` set was built
against means drop the `have` set and re-diff from empty. It never means delete
content.** Currently 2.

### Parents hash child *identity*, not just child hashes

Otherwise a membership swap can be invisible.

### mtime is a cache key, never truth

Page mtime must not enter the fingerprint — a backup restore would otherwise bill
every client a full re-download. A gate may be wrong in the false-positive direction
only.

### Downloads stage then swap

A failed download must not blend two sources. Pages are written to a hidden staging
directory and swapped in by rename, so the live chapter is either the old one or the
new one.

### Every status signal is content-derived, never a counter

A counter answers "did we do work"; a content signal answers "did anything change".
Only the second is what a polling client is asking. A scan loop every 30 s would make
a counter churn forever and the endpoint would never return 304.

### Rename detection: dropped

It works, via fingerprint matching. It answers a question the product should not be
asking — reorganising should be something Paperbox performs, not detects.

### Registries are plural and pluggable

There is no single database of comics. See [upstream.md](upstream.md).

### Automatic lookup by default, confirmation for the uncertain

But confidence alone cannot gate silence — two of our twelve series matched at "high"
confidence and were wrong.

## Rejected, with reasons

| Rejected | Why |
|---|---|
| Append-only journal | Cannot be selective; no self-check; cannot bootstrap |
| Prolly trees / Merkle Search Trees | Provide history independence that key ranges already have; pay off at 10⁴–10⁵ entries, not 400 |
| IBLT / PinSketch / CPI | Optimise discovery; our difference is already ~150 bytes against ~1.1 GB of payload |
| Rateless IBLT | Best of the set; still a 0.0017% saving bought with a probabilistic decode |
| Filesystem watching | Architecturally unavailable on FUSE; ~770 MB of kernel memory at scale even if it worked |
| Bypassing the FUSE layer | Trades parity protection for milliseconds, and only helps one installation |
| Sidecar-first identity | Makes the file a prerequisite; bootstrap problem on every path in |

## Open

### The eviction contradiction

Adds-only eviction and rolling unread windows cannot both be true. Blocks the rule
system. See [rules.md](rules.md).

### Where the index lives

Should be SQLite off the FUSE layer. Currently in the sidecars, which at 5,000 series
means thousands of FUSE reads before a single gate can be evaluated. Identity should
probably stay in the tree even after the cache moves, because it travels with a
renamed folder.

### Where `readstate.db` lives, and whether that path is backed up

**Flagged 2026-08-28, deliberately not decided here.** Read state is the first
table in Paperbox that **cannot be rebuilt by rescanning**. Fingerprints, chapter
keys and ids are all either on disk in `paperbox.json` or re-derivable from the
library; where somebody got to in a series is not. Losing it is not a slow start,
it is a reader opening a series they were 200 chapters into and being told they
have read nothing.

The container mounts two paths — the library at `/manga` and `/scripts` — and no
state volume. So there is no correct default for a module to pick: anything it
chose would sit on the container's writable layer and be deleted by the next
`--force-recreate`. `READSTATE_DB` is therefore **required**, and unset means read
state is not persisted, said out loud at boot. The store also refuses outright to
open a database inside the library root.

What it needs is a named host path in `docker-compose.paperbox.yml`, and somebody
to confirm that path is actually swept — by listing the backup destination, not by
reading the script that is supposed to write to it.

### Read state — persisted 2026-08-28, for the compat API only

Was: accepted and discarded, a blocker that had surfaced three separate times.
`src/readstate/` now stores it, keyed `(reader, series, chapter)`, and the
Paperback/Suwayomi compat API both writes and reads it — that surface is the only
place read state exists, and it previously reported `isRead: false` and
`unreadCount == chapterCount` unconditionally while answering `success` to every
mutation.

Settled with it, and worth not re-deriving:

- **Keyed by reader from the first write**, though one reader ships and there is no
  auth. A household's position is `max(everyone)`, which is computable from
  per-reader rows; per-reader rows are not computable from the collapse, and the
  compat mutations carry no identity at all, so the information needed to split it
  later is never written down. One TEXT column now against a guess later.
- **Three states, not two.** A part-read chapter is held *outside* the window's
  quota, so "keep 10 unread" holds 10 or 11. Counting part-read as unread makes the
  window churn as you open a chapter; counting it as read makes the chapter under
  your finger an eviction candidate.
- **Merge is furthest-wins on position**, with an `epoch` for deliberate resets, and
  the read flag is two max-merged timestamps. No HLC. Max-merge is commutative,
  associative and idempotent, so reconnect order cannot change the result;
  last-write-wins fails by silently rewinding a reader's place, furthest-wins by
  making them scroll back a few pages.
- **The window defaults to `next`, not `latest`.** Comics are read in order, and
  `latest` hands a reader 60 chapters behind ten they cannot open. Both are
  implemented and they agree exactly once the reader is caught up.

Still open: migration fidelity from Tachiyomi backups, and cross-device reading —
neither has a path in or out yet.

### The provider abstraction

What must a registry supply to be treated uniformly? What happens when two disagree?
What does the interface show when identity came from an embedded `ComicInfo.xml`
rather than a provider?

### Push notifications

Rejected in one design as contestable. The hiatus-return case — a series silent for
months publishes again — may be the one that earns an interruption. Modelled at
roughly one per year on a twenty-series shelf.

## Known gaps

| Gap | Blocks |
|---|---|
| No archive (CBZ) support | Every Kavita and Komga library |
| No home for `readstate.db` | Read state surviving a container recreate |
| No read-state import/export | Migration fidelity from Tachiyomi backups; cross-device |
| No delete endpoints | Removing anything adoption brought in |
| No scan scheduler | Deep scans for user-managed libraries |
| `listDirs` stats every entry | ~1,700 serial FUSE round trips per scan |
| Slugs are de-duplicated per scan, not pinned | A colliding directory's `-2` suffix moves if the directory it collided with is removed |
| Far and near lanes share no vocabulary | The API cannot express the distinction the UI needs |

## Mistakes worth remembering

**Work that reports success while producing nothing.** A download "completed" having
written a blend of two sources; a sharded analysis logged clean completion lines. An
artefact you can count is a claim you can check; a log line is only a claim.

**Measuring the wrong thing.** `find -type f` was used as a stat benchmark; it calls
zero `stat()`s. That produced a scaling estimate roughly 6× too pessimistic and sent
the design after the wrong bottleneck.

**Quoting a constraint that had been personally removed.** Page heights of ~19,000 px
were repeated as current after those files had been replaced. The number was stale for
this box; the constraint remains live for the product, because other pipelines still
emit them.

**Blind regex on a pattern that also matched its own definition.** Rewriting
`task.updatedAt = Date.now()` into `touch(task)` rewrote the line inside `touch()`,
making it infinitely recursive. It typechecked perfectly, because infinite recursion
is well-typed, and no test exercised it because the download path has no coverage.
