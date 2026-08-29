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

*Still true after the discovery pass landed (2026-08-29), and worth saying so
because it looks like a contradiction.* Discovery walks every chapter to decide
whether a series needs artwork — that is the `stat`, not the extraction — and
queues **one job per series**, which the duty budget then paces. There is still
no library-wide artwork sweep, and 146 core-hours at target is still the reason.

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

### The background scan is not surfaced — *settled 2026-08-28, **revised 2026-08-29***

**This entry used to read "The background scan is not a job", and that heading is
now wrong. Saying so plainly rather than editing it quietly:** the rolling scan
*is* a job, in the same queue as everything else. What has not changed is a
single thing the user sees.

[scheduler.md](scheduler.md) §3 is explicit: *"Scan running, nobody asked →
Nothing. No spinner, no ambient seam, no count."* A rotation that appeared in
`GET /api/jobs` would be permanently `running` and every client would draw a
permanent scan, which is how a background process becomes anxiety. **That
conclusion is right and is preserved exactly. It is a presentation decision, and
it had been implemented as an architectural one** — by keeping the rotation out
of the queue entirely, which bought a correct UI at the price of a second,
parallel way of doing background work, and of a scan that could not be recovered
after a restart or paced by the same code as everything else.

A job can exist without being surfaced. `silent` is a column on the row: the job
is queued, claimed, paced, recovered and cancellable like any other, and
`JobQueue.list()` omits it — so `counts()`, the ETag and every client omit it
too. The filter lives in the queue rather than in the route, because a rule the
route could forget to apply is one that would eventually be forgotten. The
rolling scan still reports **freshness** — when each series was last looked at,
whether the rotation is keeping up — and freshness is still the pencil layer
applied to time.

A scan the *user* asked for is the same job kind without the flag, runs as a
foreground errand with no duty cap, and earns a percentage, because asking made
it theirs. Deduplication may only ever **promote**: if the rotation has already
queued a silent scan of the series you just asked about, your ask clears the
flag rather than being swallowed by it — otherwise the work would happen and
nothing would ever appear.

### One queue, several job kinds — *settled 2026-08-29*

The same work reached the disk three different ways: a direct `await scan()` at
startup, a `scan` job kind for user-invoked scans, and a rolling rotation that
was deliberately not a job. Meanwhile artwork *was* a job and pixel height was
computed inline inside the scan. Five mechanisms, two of which were the same
thing wearing different clothes.

There is one now. `scan`, `art`, `cover` and `height` are kinds in one queue,
behind one runner, under one budget. Startup, user-invoked and rotation scans all
go through it; the scheduler decides *which* series and *when*, and submits.

What that bought, concretely: the rolling scan is now resumable across a restart
and paced by the same code as everything else, and a new kind of derived work
inherits progress, cancellation, deduplication, recovery and pacing by existing.

### A scan discovers; anything that opens a file is a job — *settled 2026-08-29*

**The rule.** A scan records only the facts that are free — names, page counts,
byte sizes, mtimes, and the fingerprint made of those sizes. It never opens a
file. Everything derived from what is *inside* a page — spine art, covers, pixel
height — is a job. **And the scan is what notices derived work is missing, and
enqueues it.**

The last clause is the load-bearing one, and it exists because the same bug
shipped twice: **something derived on a change trigger, with no path for content
that already exists.**

| | What it derived on | What it missed | What was bolted on |
|---|---|---|---|
| Spine art | the scheduler's `onChange` | a library that already existed — 12 series, 1,706 chapters, not one spine | an eager `backfillArt()` |
| Pixel height | the fingerprint's recompute trigger, inline in the scan | the identical hole | nothing |

Each shipped with its own bespoke catch-up, or none. The fix is not a third
backfill; it is that discovery belongs to the scan, which is the one thing that
looks at everything. One discovery path (`src/jobs/discover.ts`), run at the end
of every scan, so the next artefact type inherits correct behaviour instead of
repeating this.

**Discovery is eager; extraction is paced. They are not the same cost.** Leaving
discovery to the rotation was the original mistake: `intervalMs` is
`deadline / seriesCount`, so a twelve-series library takes the full six-hour floor
deadline merely to *notice* it has no spines. That paces discovery at
extraction's price — one `stat` per chapter against ~740 ms to cut a spine (R-22).
So discovery runs in full, at once, over whatever the scan covered; the queue and
the duty budget pace the expensive half.

**It has to settle, or it is not discovery, it is a loop.** Every check answers
"is the artefact there?" against the derived store or the scan's own facts, never
"did we try recently?". Two ways that could have failed are closed explicitly: a
chapter with no pages has nothing to derive and is skipped from the page count the
scan already holds, and a chapter whose pages cannot be decoded gets a recorded
`miss` under the same content-addressed key — so its absence is an answer rather
than a permanent question. Without the second, the 19 HTML-error-pages-saved-as-
`.jpg` in this library (R-38) would queue an art job the user can see, for every
affected series, after every scan, for ever.

*Measured read-only against the real library and the live derived store,
2026-08-29:* 1,706 chapters, 14 spines missing, 0 heights missing → 3 art jobs,
1 cover job, 0 height jobs, in 1.3 s wall including process start. A second pass
after those run queues nothing.

**What pixel height cost where it was.** `sharp().metadata()` reads an image
header per page. That is 24M header reads at the R-12 target — roughly 18 hours
after the concurrency fix — sitting on the critical path of a pass costed at
865 s *precisely because* [scheduler.md](scheduler.md) says the quick tier never
opens a page. The costing had been quietly false for as long as the call was
there. It is a job now, and one that only measures chapters with no height:
`chapterPixelHeight` returns 0 for a chapter it cannot read, and **0 is stored**,
because "we looked and got nothing" is an answer.

One correction that matters more than it looks: the height is invalidated only
when the fingerprint **actually changes**, not whenever the recompute trigger
fires. mtime is a cache key and never truth, so a backup restore moves every
chapter's mtime and recomputes every fingerprint to the value it already had —
and clearing on the trigger would have billed 24M header reads for a change that
did not happen.

### The floor deadline is 6 hours — *proposed; the row is the owner's*

`scheduler.md` §1 gives the whole table and says plainly that every row is
defensible. 6 h is implemented as the default (`SCAN_FLOOR_DEADLINE_MS`), and the
honest copy in §4 names that number out loud — so changing it means changing that
sentence in the same edit. Likewise §2's 50% idle duty: it is one worker, so the
ceiling is one core plus its share of the FUSE queue, but nobody has watched it.

### The provider abstraction — *settled 2026-08-29*

`src/identity/`. Three questions, answered; [upstream.md](upstream.md) carries the long
form.

**A provider supplies a normalised card and two methods** — `search(phrase)` and
`fetch(registryId)` — under four rules. It *reports and never scores* (one matcher, one
bar; a per-provider confidence is a second place to make the mistake that put two of
twelve wrong at "high"). *Unknown is never zero*: `latestChapter: null` means the
registry keeps no records and removes the gap line, `0` against a held library is a
contradiction that discards the candidate. *A registryId must be re-queryable*, and a
provider that cannot answer for its own id is believable but not bindable. And
*normalisation happens at the provider boundary*, so the matcher never learns a
provider's dialect.

**When two disagree: one binding, one provider, never a merge.** A second provider
corroborates or says nothing; it never contributes a field. Merging looks obvious and
loses the two things that make a number checkable — a single `asOf` and a single id to
re-query — so "you hold 313 of 327" stops having an author. Disagreement is therefore
rendered as *absence of corroboration*. The user never sees two registries arguing:
that is deliberation, and the interface shows conclusions.

**Identity from an embedded `ComicInfo.xml` is not a provider**, and making it one was
the mistake. A provider answers "what does the world know about this name"; a file
answers "what does this library say about itself", has no search surface and no id to
re-ask. It is an *assertion*, so it enters a level above the matcher: already decided,
corroborable, not overrulable. The interface shows it identified, with the file named as
the source, and **no gap line at all** — `latestChapter` is null, which is the honest
rendering of a series we can name and cannot follow. `<Count>` exists in the format and
is deliberately unused, because a denominator frozen at the file's write date would read
as live for ever.

**What binds automatically:** an exact match on a title the registry itself curates
(canonical *or* alternative), no contradiction, no rival. Not a score — measured against
the real twelve, all nine manhwa bind correctly *and all three that the earlier harvest
got wrong are among them*, because every correct answer is exact on an **alternative**
title of a record whose canonical title looks nothing like the folder (Omniscient
Reader's Viewpoint → "Omniscient Reader"; Reincarnation of the Suicidal Battle God →
"Doom Breaker"; The Greatest Estate Developer → "Yeokdaegeup Yeongji Seolgyesa"). All
three old wrong bindings were near-exact on a *canonical* title, of a novel.

**A human binding is frozen.** `decidedBy: "human"` lets a later match refresh the
card's facts from the same id and never the identity. "Human flagging outranks any
automated confidence" is a precondition in one place rather than a rule every call site
must remember.

**Comic Vine is a slot, not an integration** — it needs a key nobody has supplied. It
exists as an object anyway, because *unconfigured* is only expressible if something
declares the slot; without it the answer for three Warhammer series is "nothing knows
this", which is false and sounds permanent.

**Cost, and why there is no poller.** Identification is once per series ever: one search
plus at most five card reads, serialised at one request per second. Refresh is one card
read per bound series. Nothing a render can reach touches the network. A nightly refresh
at 5,000 series is therefore ~83 minutes of budgeted, resumable work — designed, written
down, and deliberately not built.

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
| Season boundaries are parsed but nothing confirms them | `POST /api/identity/:id/seasons` exists; no screen offers it, so `seasons` is always empty |
| Nothing refreshes a binding | A card is read once and kept; the nightly refresh is designed, not built |

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
