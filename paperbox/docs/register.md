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

1. **R-02** — the quick-scan cost at scale. Everything about scan cadence assumes it.
   Its synthetic-tree fixture is what most other spikes need, so build that first.
2. **R-11** — that a phone can hold a useful subset without a read-state model.
3. **R-09** — that saliency cropping produces usable spines on real artwork — and,
   separately, that extraction is affordable (R-22).
4. **R-23** — that the FMD2 module feed is a dependency we can carry.

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

---

## Projected

Arithmetic from a measurement, at a scale nothing has run at. Treat as assumption.

**R-02 · Quick scan is ~0.3 s at 24M files**
Derived from R-01's readdir rate. **Contested:** the scan as written also `readdir`s
every chapter directory and stats each one, which is not what R-01 measured, so the
true figure may be orders of magnitude higher. *Settles it:* generate a synthetic
tree at 5,000 series on the same filesystem and time one quick pass. Until then no
scan-cadence claim in `sync.md` is safe. *Blast radius:* wide — cadence, the "new
chapters within a minute" promise, and whether a scheduler is even viable.

**R-11 · A phone holds a useful subset**
The selective-sync design assumes a device can express what it wants and keep it
current. Never tested against a real reading pattern, and currently unevaluable —
read state is accepted and discarded, so a rule like "keep 10 unread" cannot be
computed at all. *Settles it:* persist read state for one series and evaluate one
rule against it. *Blast radius:* wide — the entire rules and eviction design.

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
The spine shelf assumes a narrow vertical sliver chosen by saliency, with balloons
penalised, reads well across real artwork. Early crops came back noticeably
desaturated and were never resolved. *Settles it:* generate spines for 100 chapters
across 5 series and look at them. *Blast radius:* medium — it is one view, but the
shelf is currently proposed as the default.

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

**R-22 · Spine extraction is affordable at scale**
Distinct from R-09, which is about whether spines *look* right. `architecture.md`
records that shrink-on-load is unavailable in this container's ImageMagick, so full
decode is the floor - and R-04 puts the tallest page at 46,564 px. At the document's
own 710,000-chapter target that is 710k full decodes across FUSE, plus a derived
store that no document currently names. *Settles it:* time decode + colour extraction
over 100 real pages including the tall ones, and multiply. *Blast radius:* medium -
falls back to dominant-colour-only, extracted lazily on first view.

**R-23 · The FMD2 module feed is a dependency we can carry**
`pullScripts()` fetches Lua modules from `dazedcat19/FMD2` on GitHub at every boot and
executes them in-process, with no ref, tag or commit pin and no staleness signal
*[verified: `src/lua/scripts.ts`, called from `init()` in `src/index.ts`]*. This is a
**fifth upstream** the design never names alongside registry, sources, publication and
ComicInfo - and it is the component most likely to break weekly.
*Settles it:* passively record, over four weeks, how many modules break and how we
found out. *If wrong:* modules need pinning, a local override path, and a "this
source's module is out of date" condition distinct from "source down".

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
  - **R-22 stops being hypothetical.** 710k full decodes needs a derived-image store
    with an invalidation rule, and no document currently names one.
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
