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

**Blocks key on `(sequence, sortKey ÷ 25)`.**

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

25 per block. Prevents an insertion dirtying every block after it.

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

### Read state

Accepted and discarded. Blocks rolling windows, blocks migration fidelity from
Tachiyomi backups, blocks cross-device reading. Has surfaced as a blocker three
separate times.

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
| Read state not persisted | Rolling windows, migration fidelity, cross-device |
| No delete endpoints | Removing anything adoption brought in |
| No scan scheduler | Deep scans for user-managed libraries |
| `listDirs` stats every entry | ~1,700 serial FUSE round trips per scan |
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
