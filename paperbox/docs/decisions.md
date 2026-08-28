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

### Derived artefacts live outside the library — *settled 2026-08-28*

The only derived artefact Paperbox had was a cover, and it was written into the
user's library as `cover<ext>` next to their pages. That contradicts the ownership
promise in [ui.md](ui.md) — *never moved, never renamed, never rewritten* — and it
was two bugs rather than one, because the filename came from the **remote** url's
extension: fetching a `.png` cover for a series where the user had already put their
own `cover.png` overwrote their file in place, with no backup and no record. A test
asserting byte equality was seen to fail against that behaviour before it was fixed.

Everything derived now lives in `$DERIVED_DIR` (default `/data/derived`), outside
the library, with two properties that carry the design:

**It is safe to delete entirely.** `rm -rf $DERIVED_DIR` costs CPU and never data.
That is also why it may have a default path when `READSTATE_DB` may not, and why it
is mounted on `${LARGE_TEMP_DIR}` rather than under `${CONFIG_DIR}`: the weekly
rclone sweep covers Config, so a store there would replicate ~8 GB of regenerable
WebP to Google Drive every Sunday. Backing up a cache is cost with no recovery
value.

**A stale artefact cannot be served, because it cannot be addressed.** The key is
`sha256(ART_VERSION, kind, uid, fingerprint)`, so if the chapter's fingerprint moves
the key moves and the reader looks in a place nothing has been written to. There is
no "check whether this is out of date" step to forget. The obvious alternative — a
path per chapter plus a stored fingerprint to compare — fails in the one direction
that matters: skip the compare, or write the record before the picture, and the
server serves the wrong artwork with nothing anywhere saying so. `ART_VERSION` is in
the key for the same reason, so changing the extraction algorithm invalidates
everything at once with no purge step.

### Existing `cover.webp` files are adopted, never removed — *settled; whether to clean them up one day is open*

Covers already sitting in series directories are read, normalised into the store,
and **left exactly where they are**. Deleting them is not the pipeline's call:
some were put there by the user, some by Komga or Kavita, some by an earlier version
of Paperbox, and nothing on disk distinguishes the three. Removing them would be
the pipeline deleting files it did not create, which is the thing this change exists
to stop. **Whether they should eventually be cleaned up is the owner's decision**,
and it needs a rule for telling ours from theirs that does not currently exist.

### Artwork is derived per series, never swept — *settled 2026-08-28*

R-22 measured the settled extraction method at 740 ms per chapter. That is 21 minutes
of one core for the real library and **146 core-hours at the R-12 target** — 76 days
of wall clock under the 8% duty budget. So there is no library-wide artwork backfill
and there is not going to be one. Artwork is derived for one series at a time: when
the user asks, and when the rolling scan finds that series has changed.

The content-addressed key is what makes this cheap to repeat: re-running a series
after one chapter moved costs one extraction and N `stat`s, so the worker needs no
"what changed" bookkeeping of its own and cannot get it wrong.

### Background work is a persistent queue — *settled 2026-08-28*

`src/jobs/` — SQLite. Jobs survive a restart;
one that was *running* comes back `queued`, keeping its progress, because the only
thing we know for certain is that nothing is running it now. This is the failure the
download queue still has: an in-memory `Map`, so a restart loses every task with no
record it was ever asked for.

Deduplication is a partial unique index on `(kind, scope)` over unfinished jobs
rather than a check-then-insert, so two callers racing cannot both pass the check.
The list's ETag signature is derived from what a client renders, never a counter,
consistent with "every status signal is content-derived".

### The background scan is not a job — *settled 2026-08-28*

[scheduler.md](scheduler.md) §3 is explicit: *"Scan running, nobody asked →
Nothing. No spinner, no ambient seam, no count."* A rotation that appeared in
`GET /api/jobs` would be permanently `running` and every client would draw a
permanent scan, which is how a background process becomes anxiety. So the rolling
scan reports **freshness** — when each series was last looked at, whether the
rotation is keeping up — and freshness is the pencil layer applied to time.

A scan the *user* asked for is a job, runs as a foreground errand with no duty cap,
and earns a percentage, because asking made it theirs.

### The floor deadline is 6 hours — *proposed; the row is the owner's*

`scheduler.md` §1 gives the whole table and says plainly that every row is
defensible. 6 h is implemented as the default (`SCAN_FLOOR_DEADLINE_MS`), and the
honest copy in §4 names that number out loud — so changing it means changing that
sentence in the same edit. Likewise §2's 50% idle duty: it is one worker, so the
ceiling is one core plus its share of the FUSE queue, but nobody has watched it.

### Read state is not a server concern

Settled 2026-08-28, and it reverses a decision taken the same day. A SQLite
store keyed `(reader, chapter)` was built, wired into both compat surfaces, and
measured (a rolling-window rule resolves in ~0.15 ms at the 710,000-chapter
target). It has been removed.

**The reasoning is about the want, not the cost.** Read state was only ever
needed so that a rule like "keep 10 unread" could be evaluated, and so that
progress could follow a person across devices. Both of those need to know *which
person*, which needs a user model, which needs auth. Building an accounts system
inside a single-user server is a large, permanent tax to reach a small feature.

And the want underneath was never really read state. It surfaced as "I tried to
share my library with someone and couldn't" — an **identity** problem. AT
Protocol was assessed as a way to get identity without operating an accounts
system; the identity half is shipped and would fit, but the private-data half
("Atproto Spaces", announced 2026-08-20) is explicitly alpha and unencrypted, so
nothing there is worth building on yet. Revisit when identity is genuinely
wanted, not as a side effect of wanting a reading position.

**What the compat surfaces do now:** accept progress and ignore it. Every
chapter reports unread. The clients that have their own sync (Paperback, Mihon,
iCloud on iOS) keep using it, and nothing here pretends to be a source of truth
it cannot honour.

**What this costs, stated plainly:**

- Selective-sync rules phrased in terms of *unread* cannot be evaluated
  server-side. See [rules.md](rules.md).
- The scan scheduler's hot lane loses its read-recency signal and now leans on
  recent *change* alone — a weaker predictor of what will change next.

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

### Rules belong to the client; the server always grabs — *settled 2026-08-28*

Upstream and downstream were being treated as one selective-sync system, and they
are not symmetric.

**Server ← source: there is nothing to decide.** If a chapter exists upstream and
the series is in the library, fetch it. Selectivity here buys nothing — the box
has the disk, and a chapter the server skipped is one no client can ever ask for.

**Client ← server: everything is a decision**, and only the client can make it.
Free space, reading position, whether it is on data, what its owner actually
wants — none of that is the server's to know, and a phone with 8 GB free and a
laptop with 2 TB have no reason to agree.

So there is no rules engine on the server. What the server owes a client is a
truthful account of what exists, cheap enough to ask often, which is the hash
tree, and it is already built.

**This settles three things that were open:**

- **The eviction contradiction** — adds-only versus rolling unread windows. It was
  never one question with one answer; it is client policy, and clients may differ.
  Removed from this file's open list.
- **Read state on the server** — a rule phrased in terms of *unread* runs where the
  reading happens. The server is not missing information it should have.
- **Reading recency as a scan-priority signal.** The hot lane assumed the server
  chooses what to acquire, so knowing what you were reading would predict where the
  next chapter lands. It does not: the server already takes everything, so the only
  question is what upstream has published, and that has nothing to do with what
  anyone is reading. The lane keeps its change-based signal; `readRecency` stays
  declared and defaulted to null, unused.

### Where the index lives

Should be SQLite off the FUSE layer. Currently in the sidecars, which at 5,000 series
means thousands of FUSE reads before a single gate can be evaluated. Identity should
probably stay in the tree even after the cache moves, because it travels with a
renamed folder.

### Read state — built, then removed, same day

Persisted on 2026-08-28 and removed on 2026-08-28. The full reasoning is under
"Read state is not a server concern" above; this entry survives only so the
reversal is visible rather than looking like it never happened.

Four sub-decisions were made while it existed, and they are worth keeping in
case the question returns behind a real identity model: key by reader from the
first write (a household position is `max(everyone)`, and per-reader rows are
not recoverable from the collapse); three states rather than two, with a
part-read chapter held outside the quota; furthest-wins merge with an epoch for
deliberate resets, because last-write-wins fails by silently rewinding a
reader's place; and a window that defaults to the *next* unread rather than the
most recent, since comics are read in order.

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
| No read-state import/export | Migration fidelity from Tachiyomi backups; cross-device |
| No delete endpoints | Removing anything adoption brought in |
| Nothing detects a page that is not an image | 19 `.jpg` files in this library are HTML error pages (R-38); page count is not proof of a good download |
| Deep and verify tiers are still manual | The rolling scan runs the quick tier only (R-36) |
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
