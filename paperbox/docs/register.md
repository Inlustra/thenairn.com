# The register — what we believe, and how sure we are

The design documents state a lot of numbers and constraints. Some were measured on
this box, some are projections from those measurements, and some are recollection
that nobody has checked. Prose cannot hold that distinction: once a figure is
written into a paragraph it reads as equally true as every figure beside it.

This file separates them, so that building the thing can *update* them.

**Why this exists.** Three claims this project acted on turned out to be wrong, and
in each case the cost was a decision made on a number nobody had marked as
unverified — `find -type f` used as a stat benchmark, page heights quoted from files
that had already been replaced, and a backup sweep described as excluding a
directory it in fact covers. None of those were careless readings. They were
confident sentences with no provenance attached.

## How to use it

Every entry is one falsifiable sentence with a status, the evidence behind it, and
what breaks if it is wrong. When implementation contradicts an entry, you change the
entry's status and add what you learned — you do not quietly edit the prose in
`sync.md` and leave the claim looking like it was always true.

| Status | Means |
|---|---|
| **Measured** | Run on the real box. Command and date recorded. |
| **Projected** | Arithmetic from a measurement, at a scale never tested. |
| **Assumed** | Believed, never tested. The dangerous tier. |
| **Decided** | A choice, not a fact. Cannot be disproved, only revisited. |
| **Disproved** | Was believed, turned out false. Kept so it is not re-adopted. |

**Blast radius** is the column that sets priority: how much design has to change if
the entry is wrong. Spike the wide ones before building on them, not after.

## Spike these first

Ordered by blast radius, not by effort. Each is an untested bet that other work is
already resting on.

1. **R-09** — that saliency cropping produces usable spines on real artwork. The
   colour half is measured and fixed; the "does it look right" half needs a person
   and one command (see the entry).
2. **R-23** — that the FMD2 module feed is a dependency we can carry.

**R-22 came off this list on 2026-08-28**, measured against the settled extraction
method rather than a cheaper stand-in. The answer is a number and a boundary: 740 ms
per chapter, fine per series, too much as a library-wide sweep. See Measured below.

**R-11 came off this list on 2026-08-28**, half-measured. The half that was a
question about a query is answered and moved to Measured below. The half that is a
question about a person — whether the subset it selects is *useful* — is not, and
the entry says so rather than letting the measured half stand in for both.

**R-02 came off this list on 2026-08-28**, measured rather than argued, and
**disproved** — see R-29 for the curve and R-30 for what it takes with it. The
synthetic-tree fixture it needed now lives in `bench/` and is reusable by the
remaining spikes.

**R-18 came off this list on 2026-08-28**, decided rather than spiked — see
`decisions.md`, "A chapter's number is a label, a sort key, and a sequence".

**R-05 came off this list on 2026-08-27**, resolved rather than spiked: settling the
target scale (R-12) decided it. Left here as a note because a question that stops
being open should say why, not just disappear.

---

## Measured

**R-01 · Directory traversal rates on shfs**
`readdir` alone reaches ~53k files/s; `stat` on every file reaches ~2.5k/s serial and
plateaus at ~17.2k/s at concurrency 32. Chapter directories alone: 0.089 s.
*Evidence:* run on the box, 2026-08-26. *Blast radius:* wide — every scan-tier cost
in `sync.md` derives from these.

**R-03 · Cold tree build is 13 ms**
Down from 17.3 s once fingerprints were persisted and page expansion made lazy.
*Evidence:* measured before and after, 2026-08-26, on the real library.
*Blast radius:* narrow. It is a floor, and the library was ~12 series.

**R-04 · Page heights exceed WebP's limit**
The tallest page in the library is 46,564 px; 701 pages exceed WebP's 16,383 px
dimension limit. *Evidence:* measured across the library, 2026-08-27.
*Blast radius:* medium — any "just serve WebP" plan needs a tiling or fallback path,
and this is the number that says so.

**R-26 · Upstream chapter identifiers are strings, not numbers**
The MangaUpdates releases API returns chapter identifiers including `7c`, `14-19` (one
release covering six chapters), `10a-c`, `50.5`, `Oneshot`, and null.
*Evidence:* queried live, 2026-08-28. *Blast radius:* wide — it is why the chapter
label is stored as a string and a float `number` was rejected as the identity. Any
future component that assumes a chapter number is numeric is wrong at the boundary.

**R-27 · Upstream supplies the denominator, not the per-chapter key**
`latest_chapter` is structured and reliable (327 for Nano Machine, against our 313) and
is the "of 327" in the hold line. Season structure exists but only as markdown prose in
a free-text `status` field — `**S1** : 142 Chapters (1~142)` — so it is evidence for a
person to confirm, never an automatic import. AniList returned `chapters: null` for the
same ongoing series and is not a substitute. *Evidence:* queried live, 2026-08-28.
*Blast radius:* medium — it sets which side of the local/upstream line each field lives
on, and it is the reason the registry was rejected as the per-chapter authority.

**R-28 · A chapter number is not unique within a series**
`Episode 001` and `Spin-off #001` both exist in The Greatest Estate Developer, and both
are legitimately number 1. *Evidence:* measured across all 1,706 chapters, 2026-08-28 —
4 chapters collide after the strip-title parse, all of them this case.
*Blast radius:* wide — it is why `sequence` exists, and retrofitting it later is a
tree-shape change. It also breaks "a gap is a missing volume" on the spine shelf: a gap
in `main` is not a gap if the neighbour belongs to another sequence.

**R-29 · Scan cost is linear in chapters, at ~1.2 ms per chapter, on FUSE**
Measured 2026-08-28 with `bench/gen-tree.ts` + `bench/scan-curve.ts` against a
synthetic library on the real shfs mount. Four points, growing one tree:

| series | chapters | cold | warm (quick tier) | warm µs/chapter |
|---:|---:|---:|---:|---:|
| 100 | 14,204 | 220.7 s | 16.5 s | 1161 |
| 250 | 35,510 | 345.8 s | 43.7 s | 1231 |
| 500 | 71,020 | 593.0 s | 85.8 s | 1208 |
| 1,000 | 142,040 | 1,190.0 s | 173.0 s | 1218 |

Per-chapter cost is flat across a 10× range, so the curve is **linear** and the
extrapolation is a fit rather than a guess — and the largest point is 20% of the
R-12 target, not a distant one. *Evidence:* `bench/`, empty page files (the quick
tier never opens a page; it does one readdir and one stat per chapter).
*Blast radius:* wide — see R-30.
*Correction, 2026-08-29:* the evidence line above is what the benchmark measured, and
for a while it was not what the scanner did — pixel height was computed inline, opening
an image header per page, so the real scanner was doing work this figure explicitly
excludes. The scanner now matches the benchmark: `docs/decisions.md`, "A scan discovers;
anything that opens a file is a job". The number stands; what changed is that it is now
true of the code as well as of `bench/`.

**R-22 · Spine extraction costs 740 ms per chapter — cheap for a real library,
unaffordable as an eager backfill at target**
Measured 2026-08-28 with `bench/spine-cost.ts`, which benches `src/art/spine.ts`
itself rather than a proxy for it, over 59 real chapters spread across all 12 series.
The settled method is priced, not a cheaper substitute: saliency scored on a
downscaled proxy of three candidate pages from inside the chapter, balloons reranked
against, then the sliver cut from the original at native resolution.

| | mean | p50 | p90 | p99 | max |
|---|---:|---:|---:|---:|---:|
| per chapter | **740 ms** | 623 | 1,669 | 1,857 | 1,857 |

Split: **153.6 ms** per proxy decode × 3 candidates, plus **107.6 ms** for the
native-resolution cut. Cost is therefore linear in the candidate count, and that
count is the lever if anyone wants to trade quality of choice for time.

| Scale | Work |
|---|---|
| Real library, 1,706 chapters | **21 minutes** of one core |
| R-12 target, 710,000 chapters | **146 core-hours** |
| Store at target | 10.7 KB/spine → **7.8 GB** |

**The premise it was built on was wrong, but not by enough.** `architecture.md`
recorded that shrink-on-load is unavailable — true of the container's *ImageMagick*,
and not of `sharp`, which is libvips. But the saving is modest and not uniform:

| format | proxy decode | native decode | saving |
|---|---:|---:|---|
| jpg (tall, 690×34,300) | 144 ms | 179 ms | 1.2× |
| jpg (short) | 45 ms | 111 ms | 2.4× |
| webp | 66 ms | 153 ms | 2.3× |
| png | 208 ms | 130 ms | **0.6× — slower** |

libvips has no shrink-on-load for PNG at all, so the proxy costs a full decode plus
a reduction. It is kept regardless, because it also bounds memory: a 1080×15,122
page is 49 MB of raw pixels and there are eight workers.

**The tall pages are not the problem.** The tallest page found (690 × 34,300, 8.6 MB)
costs 144 ms to proxy and 179 ms to decode natively — roughly 2× the median page, not
10×. R-04's 46,564 px is a real constraint on *format policy*; it is not what makes
extraction expensive. The expense is ordinary pages, in quantity.

*Verdict:* **affordable per chapter, and per library; not affordable as an eager
sweep at the R-12 target.** 146 core-hours under the 8% duty budget in
`scheduler.md` is 76 days of wall clock. The degradation is therefore built in
rather than proposed: artwork is derived lazily and by series, on demand and after
a change, never as a library-wide backfill. See `decisions.md`, "Artwork is derived
per series, never swept".

*Evidence:* `bench/spine-cost.ts`, on this box, against `/mnt/user/Media/Manga-new`.
*Blast radius:* medium — it sets whether the spine shelf can be the default view for
a large library on first run. It cannot; it can be the default view for a library
you are reading.

**R-38 · 19 pages in this library are HTML error pages saved as `.jpg`**
Found while measuring R-22: `Warhammer 40,000_ Exterminatus` and
`Warhammer 40,000_ Marneus Calgar` contain `.jpg` files whose first bytes are
`<!DOCTYPE ht`, 106 KB each, written 2023-07-19. A download saved a rate-limit or
error page as artwork and reported success. *Evidence:* magic-byte check across the
sampled pages, 2026-08-28. *Blast radius:* narrow for the artwork pipeline, which
treats an undecodable page as "no spine" and moves on — but it is a live instance of
`decisions.md`'s "work that reports success while producing nothing", and it means
**page count is not proof of a good download**. Nothing currently detects it.

**R-11 · A rolling-window rule is computable, and it is cheap**
*Superseded 2026-08-28: the measurement stands, the feature was removed. Read
state is not a server concern — see `decisions.md`. Kept because the number is
still the answer if the question returns with an identity model behind it.*
Measured 2026-08-28 with `bench/read-window.ts`, against `src/readstate/` (both since deleted) — a SQLite
store keyed `(reader, series, chapter)` and a resolver for one rule, "keep the N most
recent unread chapters of series X". Until it existed the rule could not be computed
at all: read state was accepted and discarded.

| catalogue | read-state rows | one rule p50 | p95 | 40 rules in one pass |
|---|---:|---:|---:|---:|
| real library — 12 series / 1,706 chapters | 1,706 | 0.174 ms | 0.391 ms | 2.73 ms (all 12 rules) |
| R-12 target — 5,000 series / 710,000 chapters | 710,000 | 0.150 ms | 0.258 ms | 5.60 ms |

A second run reproduced every figure within about 10% (0.181 / 0.442, 0.153 / 0.273,
6.08 ms), which is the resolution this measurement has — quote it to two significant
figures, not three.

A 416× larger catalogue does not make one rule slower, because the rule reads one
indexed range and sorts one series. `src/readstate/scale.test.ts` held it to that by
asserting the query plan is a `SEARCH` and not a table scan, so a later index change
cannot quietly turn a per-series cost into a per-catalogue one. Enumerating a
series' chapters is separate and is R-06's problem, not the rule's: 2.17 ms/series
from `paperbox.json` over FUSE on the real library, against 0.024 ms to hand the
resolver a list it already holds.

**What this does not measure — and the distinction is the whole point of the
entry.** It measures that the rule is *computable and cheap*. It says nothing about
whether the subset it picks is *useful*. Whether ten unread is the right shape for a
real reader — whether the window keeps up with how fast they read, whether the
part-read carve-out matters in practice, whether anybody would rather express this a
different way entirely — is unobserved, and cannot be settled by a benchmark. It
needs a person reading on a phone for a month. Do not let the numbers above be
quoted as evidence that selective sync works; they are evidence that the arithmetic
is affordable, which is a smaller claim.

*Evidence:* `bench/read-window.ts`, run on this box. Real library read-only, from
`paperbox.json`; synthetic catalogue in SQLite with one row per chapter, which is
the pessimistic case for index selectivity. *Blast radius:* wide — the rules and
eviction design rested on it. *Superseded 2026-08-28: rules are a client concern
(see `decisions.md`), so this measured a cost the server will never pay. The
eviction contradiction it deferred to is closed for the same reason — it is client
policy, and clients may differ.*

**The store it measured no longer exists**, and neither does the question of where
it should live.


---

## Projected

Nothing sits here at present. R-11 was the only entry and moved to Measured on
2026-08-28. The tier stays because the next projection will want it, and because a
projection filed as a measurement is how R-30 happened.

---

## Assumed

Believed, never tested. Each of these is load-bearing somewhere.

**R-05 · The sidecar can carry the index**
`paperbox.json` currently holds identity *and* the fingerprint cache. At 5,000 series
this is thousands of FUSE reads before a single gate can be evaluated, and it writes
into the user's library on every scan — which sits badly beside the ownership promise
in `ui.md` that files are never rewritten. *Settles it:* R-02's synthetic tree
answers this at the same time. *Blast radius:* wide, and it contradicts R-06.

**R-06 · The index should live in SQLite off the FUSE layer**
Recorded as open in `decisions.md`. Note this and R-05 cannot both be right; the
register's job is to make that visible rather than let both sit in prose.
*Blast radius:* wide — rules, eviction, read state and device pairing all queue
behind wherever the index lands.

**R-09 · Saliency cropping yields usable spines**
Still assumed, and deliberately still here: the half that needs a person has not been
done. The half that is a colour bug has been measured and is no longer a mystery.

**The desaturation defect is located.** `bench/spine-colour.ts` eliminates two
mechanisms and finds the third:

| Candidate mechanism | Measured 2026-08-28 | Verdict |
|---|---|---|
| Colour profile / colourspace on decode | **0 of 60** sampled pages carry an embedded ICC profile (48 srgb/uchar, 12 rgb16/ushort); decoding with and without an explicit `toColourspace("srgb")` agrees to four decimal places of mean chroma on every one | not the cause |
| Cutting from a downscaled raster, where the reduction averages pixels | sliver chroma 0.0628 native vs 0.0628 from a 200 px proxy — ratio **1.000** | not the cause |
| **Deriving the tint as a mean colour** | mean-derived tint chroma **0.0558** vs mode-derived **0.1882** — the mean is **3.4× less chromatic** | **this is it** |

A mean over comic artwork converges on mud, and a foot band painted in it is exactly
"noticeably desaturated". `src/art/spine.ts` derives the tint by histogram mode with
paper and ink excluded, and `extractSpine` now reports source and output chroma on
every extraction so the defect cannot return silently — measured at **0.992** output
over source across 59 real chapters, i.e. the encode is faithful.

**The balloon penalty is partly effective, and the gap is now named.** 24 real
chapters were dumped and the first twelve looked at:

| Mask | Text-heavy crops in 12 |
|---|---|
| flat near-white only | **2** — white lettering on flat black caption plates, which score high on edge energy and paid no penalty at all |
| flat near-white **or** near-black | **2** — the black-plate ones fixed; text over a mid-green panel and white text over a blue sky gradient are not |

So the flat-region proxy catches text on flat grounds in either polarity and cannot
catch text on coloured grounds. The two-sided mask ships because a flat black
caption plate is unambiguously not artwork, but it is a partial answer, not the
answer. Closing the rest needs real text detection (stroke-width transform, MSER),
which is a design decision rather than a tweak.

**What is still open, and cannot be closed by a benchmark:** whether the crops *look*
right, across 100 of them, to a person. *Settles it:*
`bun run bench/spine-cost.ts --chapters 100 --dump out/` writes 100 real spines and
their per-crop diagnostics; somebody looks at them. That is now a one-command errand
rather than a project, which is the only part of this entry an implementation could
change. *Blast radius:* medium — it is one view, but the shelf is currently proposed
as the default.

**R-10 · One hiatus-return notification per year, per twenty-series shelf**
Modelled, not observed. It is the sole justification for the only loud state in the
product. *Settles it:* replay a year of release history for twenty real series.
*Blast radius:* narrow, but it decides whether notifications exist at all.


**R-21 · Name-and-size is proof enough for the eviction floor**
`rules.md` makes a *verified* copy a hard floor before eviction, and `ui.md` calls the
"was anything harmed" line a checked fact. The tree's leaf is `hash(name + byte size)`
truncated to 8 bytes, and `sync.md` says plainly it is "change detection, not
security". Against this product's own documented adversary - a source that served
byte-perfect files of a different comic - name-and-size proves nothing.
*Settles it:* time a content digest over one 313-chapter series to price the Verify
tier. *If wrong (it is):* either weaken the copy, or compute a per-chapter content
digest **once, at download commit, while the bytes are already in hand** - never by
scanning. That option only exists if it is decided before the download path is
rewritten. *Blast radius:* medium, but the window closes early.

**R-23 · The FMD2 module feed is a dependency we can carry**
`pullScripts()` fetches Lua modules from `dazedcat19/FMD2` on GitHub at every boot and
executes them in-process, with no ref, tag or commit pin and no staleness signal
*[verified: `src/lua/scripts.ts`, called from `init()` in `src/index.ts`]*. This is a
**fifth upstream** the design never names alongside registry, sources, publication and
ComicInfo - and it is the component most likely to break weekly.
*Settles it:* passively record, over four weeks, how many modules break and how we
found out. *If wrong:* modules need pinning, a local override path, and a "this
source's module is out of date" condition distinct from "source down".

**R-31 · The series-directory mtime gate is sound on shfs**
*Blast radius: very wide — it is the one measurement that could make most of
`scheduler.md` unnecessary.* If a series directory's mtime reliably moves when a
chapter directory is added, the floor pass collapses from 710,000 chapter probes to
5,000 directory stats, ~400× cheaper. The doubt is structural: shfs is a union over
several disks and it is unknown which branch's mtime it presents for a directory
that exists on more than one — a false negative in the one direction `sync.md` says
a gate may never be wrong in. *Settles it:* see `scheduler.md` §5. **Not used by the
implementation**: `src/jobs/scheduler.ts` does the full per-series pass, so the gate
can only ever be added later as an accelerator.

**R-32 · A scan at concurrency 8 does not measurably degrade page-serve latency**
*Blast radius: wide — the entire budget model.* `src/jobs/budget.ts` assumes scanner
and reader are additive on the FUSE queue. If they contend non-linearly the budget
must become a latency SLO with feedback control, which is a different scheduler.
*Settles it:* `scheduler.md` §5.

**R-33 · Hand-added chapters cluster in recently-read series**
*Blast radius: medium — the sole justification for the hot and warm lanes.*
`ScanScheduler` records `changesByLane` from day one precisely so this can be
settled by looking rather than arguing. *If wrong:* delete the lanes and give the
floor 100% of the budget — the worst case improves from 6.0 h to 3.0 h, which is the
pleasant failure mode.

**R-34 · Per-chapter scan cost holds at concurrency 8, not the bench's**
*Blast radius: medium — every rotation period scales directly with it.* R-29's
1.218 ms/chapter was measured at whatever concurrency `bench/scan-curve.ts` used;
the scheduler runs 8. Same class of error as R-14 and R-30, flagged before being
built on rather than after.

**R-35 · Cold first scan is ~99 minutes at target**
*Projected from R-29's cold column. Blast radius: medium — it sets the adoption
experience.* Never run above 142,040 chapters, and cold cost is the one that could
be superlinear.

**R-36 · A weekly deep floor is affordable at 0.23% duty**
*Projected from R-01 × 24M files. Blast radius: narrow — if wrong, deep stays
manual, which is where it is today.* **Not implemented**: the scheduler runs the
quick tier only.

**R-37 · The scheduler can tell idle from a sleeping client**
*Blast radius: narrow by construction — the idle detector is an accelerator, so
being wrong costs a slower scan and never a missed deadline.* Recorded so the
narrowness is deliberate rather than lucky; `budget.test.ts` asserts the accelerator
property directly.

**R-39 · A duty cycle measured over wall time bounds the mount as intended**
*Assumed. Blast radius: medium.* `Budget` sleeps between units so that scanner and
worker wall time stays under 8% of a 5-minute window. Nothing has yet watched the
FUSE queue while it runs, so "8% of wall time" is assumed to mean "roughly 8% of the
mount", which is the same shape of inference as R-14 and R-30 — a rate borrowed from
one measurement and applied to another. *Settles it:* falls out of R-32.

**R-24 · The rule sentence resolves fast enough to render**
"Right now this means ch. 297-306 - 74 MB" is recomputed on every render of every rule
row, and it needs byte totals the index does not currently hold.
*Settles it:* resolve six series from the index and time it. *If wrong:* persist
per-chapter byte totals at scan time - a free by-product, since every page is already
stat-ed to build the fingerprint. *Blast radius:* narrow, but dropping the megabytes
weakens the argument that an abstract rule is unpredictable.

---

## Decided

Choices, not facts. They cannot be disproved — only revisited, and then only with a
reason recorded here.

- **R-12** · **Target scale is ~5,000 series / ~710k chapters / ~24M files.**
  Settled by Thomas, 2026-08-27, as intent rather than observation - the real library
  is ~12 series / ~1,706 chapters, and no installation has reached the target. It is
  recorded here as a *decision* because it is a choice about what to build for, and
  because a great deal of design difficulty is downstream of it. Consequences that
  follow immediately, rather than waiting for a spike:
  - **R-05 is effectively dead and R-06 wins.** At 255 bytes per chapter *[measured:
    Nano Machine's sidecar, 80 KB / 314 chapters]*, sidecar-as-index is ~181 MB of
    JSON written inside the user's library, read over FUSE before any gate can be
    evaluated. The sidecar keeps *identity*, which is small and travels with a rename;
    the cache and the index move off FUSE.
  - **R-02 becomes mandatory, not optional.** No scan-cadence claim can be written
    until the synthetic-tree spike has run.
  - **R-22 stops being hypothetical.** 710k decodes needs a derived-image store with
    an invalidation rule. *Built 2026-08-28* — `src/art/store.ts`, content-addressed
    on `(ART_VERSION, kind, uid, fingerprint)`, outside the library, safe to delete.
    The measurement it forced (R-22, now Measured) is what ruled out ever deriving
    artwork for the whole catalogue at once.
  - **Registry polling becomes a scheduler with a budget**, not a "polled nightly"
    chip: 5,000 series against rate-limited providers needs staleness tiering (a
    completed series does not need nightly polling) and a first-run backfill plan.
  - **The stated reason for rejecting prolly trees / content-defined chunking goes
    stale.** `decisions.md` rejects them as paying off "at 10⁴-10⁵ entries, not 400" -
    and 710k chapters is inside that range. The rejection is probably still right,
    because key-range partitioning is already history-independent, but the *reason on
    file* no longer holds and someone will re-litigate it. Rewrite the reason.

- **R-07** · Blocks are keyed by chapter number, 25 per block. Insertion dirties one
  block rather than every block after it.
- **R-08** · Never reconcile below chapter granularity. Return `(chapter, page_count)`
  and let the client enumerate.
- **R-13** · No green in the state palette. Done is the resting state of a library,
  not an event.

---

## Disproved

Kept deliberately. A wrong belief that is merely deleted gets re-adopted by the next
person who reasons their way back to it.

**R-14 · "`find -type f` measures stat cost"**
It calls zero `stat()`s — it reads `d_type` from `getdents64`. Produced a scaling
estimate roughly 6× too pessimistic and sent the design after the wrong bottleneck.

**R-15 · "Pages reach ~19,955 px"**
Stale for this box — those files had already been replaced when the figure was being
quoted. The real maximum is 46,564 px (R-04). The constraint is real for the product;
the number was wrong.

**R-16 · "Identity can be a position in a directory listing"**
The incident that started all of this. Ids were array positions from a scan; the
library's shape changed and a client holding id 3 resolved it to a different series.

**R-17 · "A dump taken while the service runs is complete"**
Not from this project, but the same shape and worth carrying: a database dump taken
without stopping the writers missed two hours of subsequent writes while reporting
itself complete.

**R-18 · "Chapter number can be parsed from the directory name"**
The parser takes the first digit-run in the name *[verified 2026-08-27]*. On the real
library all five `Warhammer 40,000_ Exterminatus Issue #N` directories resolve to
chapter **40** - so five distinct issues collide on one number and one block. Two
series start at `Chapter 0` and two at `Chapter 000`, so "count" and "highest number"
already disagree with nothing to say which drives the hold line. `The Greatest Estate
Developer` names its chapters `Episode 038`.
**Resolved 2026-08-28** by the label/sortKey/sequence decision in `decisions.md`; R-26 and R-27 carry what settled it.
The missing decision was not "parse better" - it is *what a chapter number is*: parsed,
ordinal, source-supplied, or registry-reconciled, and which wins on disagreement.
**Changing this later re-keys every block hash and invalidates every client's held
state** - which would be the second forced re-add after the id-scheme change.

**R-19 · "Identity is only written to disk on a hash collision (~0.6% at 5,000)"**
False against the live library: all twelve series carry a pinned `uid` *and* `apiId`
for every chapter *[verified 2026-08-27]* - 314 of each in Nano Machine's 80 KB
sidecar, 1,706 across the library. The sidecar is a full identity manifest, not a
sparse collision record. Two consequences: the "delete every sidecar and ids come back
identical" property is asserted by a test the live data does not exercise, and the
sidecar-as-index costs roughly 180 MB at target scale, inside the user's library,
versus the ~104 MB SQLite index proposed to replace it. The sidecar is the more
expensive option, in the worse place.

**R-20 · "Chapters remember who served them"**
Provenance is populated only for chapters Paperbox itself fetched. On the box, 11 of
12 series have **zero** provenance records; only SSS-Class Suicide Hunter has any, on
all 151 chapters, because it was re-sourced today *[verified 2026-08-27]*. So the
provenance chip and the per-chapter source line are permanently empty for every
library adopted from Komga or Kavita - exactly the adoption case the product targets.
The source-succession story is a *registry release-log* fact, not a provenance one.

**R-25 · "`listDirs` stats every entry - ~1,700 serial FUSE round trips per scan"**
Still listed as a known gap in `decisions.md`; it was fixed (`readdir` with
`withFileTypes`, `d_type` fast path) *[verified]*. Retired here rather than left to be
re-quoted, which is the whole point of this file.

**R-30 · "Quick scan is ~0.3 s at 24M files"**
Disproved 2026-08-28. The real figure at the R-12 target of 710,000 chapters is
**~865 s (14.4 minutes)**, from the measured per-chapter cost in R-29 — about
**2,900× the claim**. Cold first scan projects to roughly 99 minutes.

The claim was arithmetic from R-01's flat readdir sweep, but the scanner does one
readdir *and* one stat per chapter directory, so the dominant term is per-chapter,
not per-file. Multiplying a file count by a readdir rate measured a different
operation. This is the same failure as R-14 (`find -type f` as a stat benchmark):
a rate borrowed from one operation and applied to another.

What it takes with it:

- **The 30–60 s quick-scan cadence is impossible.** One full quick pass takes
  14 minutes; scheduling it every 30 s would mean ~29 overlapping scans.
- **"New chapters surface within a minute" has no mechanism** at target scale, and
  `sync.md` should stop saying so until one exists.
- **A scheduler must be a rolling partial scan** with a priority order, not a full
  sweep — which changes Activity copy and every freshness stamp.
- **Targeted scan is unaffected** and remains the good case: after a download we
  know which series moved, so that path stays instant.
- **R-06 gets much stronger.** At ~1.2 ms per chapter dominated by FUSE round
  trips, moving the index off the FUSE layer is the whole game.
