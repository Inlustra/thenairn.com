# The scan scheduler

**Designed, not built.** Written 2026-08-28, the day R-29 measured the scan curve and
R-30 disproved the cadence the rest of the design was resting on.

## Why this document exists

`sync.md` promised "new chapters surface within a minute" and costed a full quick
sweep at ~0.3 s. Measured on the real shfs mount, the quick tier is **linear at
~1.218 ms per chapter** (R-29). At the R-12 target of 710,000 chapters:

| Pass | Per chapter | At 710k chapters |
|---|---:|---:|
| Quick, warm | 1.218 ms | **865 s — 14.4 min** |
| Quick, cold | 8.38 ms | **5,950 s — 99 min** |
| Deep (stat every page, 24M files @ 17.2k/s) | — | ~1,395 s — 23 min |

A 30–60 s cadence is arithmetically impossible: the sweep does not fit inside its own
interval. But note what the numbers actually say — **the work is not large, the
interval was.** 865 s is 1.0% of a day. The failure was demanding it in 60 seconds,
not the cost of doing it.

**Scope.** This scheduler exists for **user-managed libraries only** — files dropped in
by hand, or an adopted Komga/Kavita tree. Everything Paperbox fetched itself is covered
by the targeted tier, which knows exactly which series moved and stays instant. If your
library is entirely Paperbox-managed, this scheduler is dead weight that never fires
usefully, and that is the correct outcome.

---

## 1. The rolling partial scan

### The unit of work is one series

Not a block, not a chapter, not a directory. A series.

**Why not smaller.** A new chapter is discovered only by listing the *series*
directory. A scheduler that scanned "blocks 1–4 of series X" could never find chapter
314, which is the entire point of scanning. Below the series, discovery is unsound.

**Why not larger.** A series is ~142 chapters at target average, so **~173 ms of work**
— fine-grained enough to interleave with page serving and to pre-empt at sub-quarter-
second granularity.

**The one exception.** A series over 1,000 chapters would hold the worker for >1.2 s.
Those split *after* the discovery readdir: one series readdir (cheap — ~7 ms, R-01),
then the chapter stat phase chunked at 250 chapters (~305 ms) per slice. Discovery is
still whole; only the verification is sliced.

### Three lanes, weighted round-robin, one worker

```
 ┌── floor ──  every series, strict rotation, no exceptions ──┐
 ├── hot   ──  read <24h · pinned · changed in last 2 passes ─┤ → one scan worker
 └── warm  ──  read <30d · any chapter held by a device ──────┘
```

**The floor lane is the load-bearing half.** It is a strict round-robin over the entire
library with a *guaranteed* share of the budget. Priority can pull a series forward; it
can never push one past the floor's rotation. That is what turns "worst case" from a
hope into a number.

The hot and warm lanes are a bet that hand-added files cluster in series the user is
currently reading. **That bet is unmeasured (R-33).** If it is wrong, the lanes are
theatre and only the floor matters — which is a perfectly good system, just a simpler
one. Build the floor first and the lanes second, in that order, so the fallback is the
thing that already works.

**Membership rules**

| Lane | A series enters when | It leaves when |
|---|---|---|
| Hot | read within 24 h; user-pinned; changed on either of its last two scans; upstream `latest_chapter` exceeds held count | the condition lapses |
| Warm | read within 30 d; any paired device holds ≥1 chapter of it | the condition lapses |
| Floor | always — every series, permanently | never |

Change-begets-change is deliberate: someone dropping in a backlog drops in several
folders over an evening, so a series that just moved is the likeliest to move again.

### Staleness, with numbers

Take the recommended at-rest budget below — **8% duty, split 50/30/20 floor/hot/warm**
— and assume 50 hot series and 500 warm at target scale.

| Lane | Work per rotation | Duty share | **Rotation period** |
|---|---:|---:|---:|
| Floor (5,000 series, 710k ch) | 865 s | 4.0% | **6.0 h** |
| Warm (500 series, 71k ch) | 86.5 s | 1.6% | **1.5 h** |
| Hot (50 series, 7.1k ch) | 8.65 s | 2.4% | **6 min** |

**Worst-case staleness for a series at the back of the queue is 6.0 hours**, plus the
one in-flight slice (≤305 ms). It applies to a series nobody reads, no device holds,
that has not changed and is not pinned — i.e. the cold tail of a 5,000-series library.

When the box goes idle the same shares run at 50% duty:

| Lane | Rotation at rest (8%) | Rotation when idle (50%) |
|---|---:|---:|
| Floor | 6.0 h | **58 min** |
| Warm | 1.5 h | 14 min |
| Hot | 6 min | **1 min** |

The deadline is a *target*, not a guarantee the code gets for free. Contention with
page serving can stretch it. So the scheduler **measures its own rotation period and
reports it** — see the amber condition in §3. A deadline you assert and never check is
how R-30 happened.

### Choosing the deadline is choosing the budget

They are the same number. `duty = 865 s / D`, for the floor lane alone:

| Worst-case staleness D | Floor duty | Total duty (floor = 50% of budget) | Floor scan-seconds/day |
|---:|---:|---:|---:|
| 1 h | 24.0% | 48% | 20,740 |
| 4 h | 6.0% | 12% | 5,180 |
| **6 h** | **4.0%** | **8%** | **3,460** |
| 12 h | 2.0% | 4% | 1,730 |
| 24 h | 1.0% | 2% | 865 |

**Owner's call, not mine:** 6 h is the recommendation, but the whole row is defensible
and the choice is a product decision about how patient a hand-managed library is
allowed to make you. Pick the row, and the copy in §4 changes to match it.

### First run is not this

A cold sweep is **99 minutes of work**. At 8% duty that is 20 hours of wall clock,
which is not an adoption experience.

First run — and any user-invoked "scan my library" — is a **foreground errand**, run at
full concurrency with no duty cap, because the user asked for it and is watching. This
is also the escape hatch Komga and Kavita both ship and `sync.md` notes we lack. It is
the seam that resolves §3.

---

## 2. Budget

Three controls, in order of authority. The first two are hard; the third only ever
makes the scanner *faster*.

### (a) Concurrency cap — 8 in-flight FUSE operations

R-01 puts the stat plateau at ~17.2k/s at concurrency 32, with the knee at 8–16 and
`architecture.md` recording that parallelism caps at about 7×. **8 at rest.** Never 32:
the plateau is the point at which we have taken the whole FUSE daemon queue, and that
queue is shared with serving pages.

What that costs the mount, honestly: at 821 chapters/s the scan issues one readdir and
one stat per chapter ≈ **1,640 ops/s, about 9.5% of the measured FUSE ceiling while it
is running**. At 8% duty that is **~0.8% of the mount averaged**. That is the number to
defend the design with, and it is derived from R-29 + R-01, not asserted.

### (b) Duty cycle — 8% at rest

Expressed as *scanner wall time ÷ elapsed wall time*, measured over a 5-minute sliding
window, enforced by sleeping between work units. Not a token bucket over operations:
duty cycle degrades gracefully when the array is slow (the sleeps stay the same, the
rotation stretches, and §3 reports it) whereas an op-rate limit would silently consume
more of a contended mount exactly when it should back off.

**The array is 98% full and shared.** Scanning is pure read and allocates nothing, so
fullness is not a direct constraint — but it means the array is doing other work
(parity, mover, media) that this must not compound. 8% is chosen to be invisible.

### (c) Idle detector — an accelerator, never a gate

No HTTP request served and no download in flight for 120 s → duty rises to 50%. Any
inbound request drops it back to 8% immediately; the in-flight slice finishes (≤305 ms)
and the next one waits.

**Why an accelerator and not a gate.** A gate means a library that is used all day is
never scanned at all, and the failure is silent. As an accelerator, a busy box still
meets its 6 h deadline and an idle one beats it by 4×. The worst case never depends on
the detector being right — which matters, because "idle" is hard to tell from "a phone
is asleep mid-sync" (R-34).

**Owner's call:** whether 50% is too generous for a box that also runs 43 other
containers. It is one worker, so the ceiling is one core plus its share of the FUSE
queue, but nobody has watched it.

### What the scheduler does not run

- **Verify** (read bytes, sha256) stays **manual, forever**. R-21 already establishes
  the right answer is a content digest computed **once at download commit while the
  bytes are in hand**, never by scanning.
- **Deep** (stat every page) is the same machinery with a different unit cost: ~1,395 s
  of work at target. A weekly deep floor is **0.23% duty** — nearly free, and it closes
  the "a page was added to an existing chapter" hole that the quick tier's directory
  gate cannot see. Recommended, **owner's call** whether it runs unattended.

---

## 3. What the user is told

### It is not a third lane. It is the pencil layer, applied to freshness.

`ui.md`'s two progress domains describe **acquisition errands** — something was asked
for and is arriving. A background scan is not an errand. Nothing arrives, there is no
completion the user is waiting on, and the user did not ask. Filing it in either lane
imports the wrong properties: far-lane dated sentences imply an arrival, near-lane
percentages imply an errand that is theirs.

The existing vocabulary already covers it, applied to *knowledge* instead of
*possession*:

> **Ink is what the server has looked at. Pencil is what it has not looked at
> recently.**

That is the same move `ui.md` already makes twice — pencil for skeleton loaders is the
language applied to *time*, and "ink is device-relative on the phone" is it applied to
*place*. This is the third: applied to *freshness*. No new colour, no new noun, and
**still no green** — "fully scanned" is the resting state of a library, not an event.

### Concretely

| Situation | Treatment | Copy |
|---|---|---|
| Series scanned within its lane's period | Normal. Ink. No stamp, no chrome. | — |
| Series past its deadline (stale) | Pencil-weight freshness stamp on the series only | *"Last looked at Tuesday."* |
| Scan running, nobody asked | **Nothing.** No spinner, no ambient seam, no count. | — |
| Scan running because the user asked | Near lane — it is their errand | series counted, percentage, bytes |
| Rotation period >2× target for 2 consecutive rotations | Amber, no retry affordance | *"Scanning is running behind. The library is busy."* |
| Library root unreadable / permission denied | Red, one verb | *"Paperbox can't read /mnt/user/Comics."* → **Choose folder** |

**Dated sentences, never a ticking number**, for the background case — the far lane's
rule, for the far lane's reason: it is not something the user can influence. The
percentage appears only on the user-invoked scan, and it appears *because* asking made
it theirs.

**No ambient presence.** `ui.md` reserves the animating seam for the near lane. A
permanently-scanning server would animate it permanently, which is how a background
process becomes anxiety.

The "was anything harmed" rule still applies: a scan **never** rewrites, moves or
deletes (`ui.md`, Ownership), so the honest answer is always *nothing was touched* —
and per the failure triage, we say it anyway rather than let it be inferred.

---

## 4. Honest copy

Replacing *"new chapters surface within a minute"*:

> **Anything Paperbox downloads appears at once. Anything you add yourself is found
> within six hours — sooner for series you've been reading.**

It is two sentences because the two paths are genuinely different and collapsing them
is what produced the false claim. It names the deadline rather than an average, it
tells the truth about the priority lanes without promising they work, and it is true at
5,000 series with the recommended budget.

Attached at the point of use — the library settings row that offers **Look now** — per
`ui.md`'s copy rule. If the deadline in §1 changes, this line changes with it; it must
never outlive its number.

**Do not ship** the tempting shorter version — *"new chapters are found automatically"*
— it is true and says nothing, and vagueness is what let the last claim survive
unexamined for weeks.

---

## 5. What must be measured next

Register entries, ordered by blast radius. To be appended to `register.md` under
**Assumed** unless noted.

**R-31 · The series-directory mtime gate is sound on shfs**
*Assumed. Blast radius: very wide — it is the one measurement that could make most of
this document unnecessary.* If a series directory's mtime reliably moves when a chapter
directory is added or removed, the floor pass collapses from 710,000 chapter probes to
**5,000 directory stats — ~0.3–2 s**, roughly 400× cheaper, and a 60-second cadence
becomes affordable again for chapter *discovery*. The doubt is specific and structural:
shfs is a **union over several disks**, and it is unknown which branch's mtime it
presents for a directory that exists on more than one. If it presents disk 1's while
the new chapter landed on disk 2, the gate produces a **silent false negative** — the
one direction `sync.md` says a gate may never be wrong in.
*Settles it:* on the real mount, create a series directory spanning two array disks;
add a chapter folder to each branch in turn; stat the merged path each time and check
whether mtime moves. Then repeat under the mover.
*Regardless of the outcome, the full per-chapter pass stays* as the slow backstop — the
gate can only ever be an accelerator, because it cannot see a page added inside an
existing chapter.

**R-32 · A scan at concurrency 8 does not measurably degrade page-serve latency**
*Assumed. Blast radius: wide — the entire budget model.* The duty-cycle design assumes
scanner and reader are additive on the FUSE queue. If they contend non-linearly, the
budget must become a **latency SLO with feedback control** (back off when p95 page
latency rises) rather than a fixed percentage, which is a different scheduler.
*Settles it:* serve a page-read workload at a fixed rate, measure p50/p95, then run the
scanner alongside at concurrency 4, 8 and 16 and compare.

**R-33 · Hand-added chapters cluster in recently-read series**
*Assumed. Blast radius: medium — it is the sole justification for the hot and warm
lanes.* If change is uniformly distributed across the library, priority buys nothing
and the floor lane alone is the whole design. *Settles it:* log which series the floor
lane finds changes in, for four weeks, and correlate against last-read time. Costs
nothing and can run from day one.
*If wrong:* delete the lanes, give the floor 100% of the budget — worst case improves
from 6.0 h to 3.0 h, which is the pleasant failure mode.

**R-34 · Per-chapter cost holds at the scheduler's concurrency, not the bench's**
*Assumed. Blast radius: medium — every period in §1 scales directly with it.* R-29's
1.218 ms/chapter was measured by `bench/scan-curve.ts` at whatever concurrency it used;
the scheduler proposes 8. This is the same class of error as R-14 and R-30 — a rate
borrowed from one operating point and applied to another — and it is being flagged
*before* being built on rather than after.
*Settles it:* re-run `bench/scan-curve.ts` at the 1,000-series point with concurrency
pinned to 4, 8, 16 and 32, and publish the four numbers.

**R-35 · Cold first scan is ~99 minutes at target**
*Projected from R-29's cold column (8.38 ms/chapter × 710k). Blast radius: medium — it
sets the adoption experience, which is the product's stated target case.* Never run
above 142,040 chapters, and cold cost is the one that could be superlinear (cache
pressure, not traversal). *Settles it:* run the cold pass once at the 1,000-series
fixture with the page cache dropped, and confirm the 8.38 ms holds.

**R-36 · A weekly deep floor is affordable at 0.23% duty**
*Projected from R-01's 17.2k/s stat plateau × 24M files. Blast radius: narrow — if
wrong, deep stays manual, which is where it is today.* The number has never been run
against the synthetic tree, only inferred. *Settles it:* extend `bench/scan-curve.ts`
with a deep tier and measure the 1,000-series point.

**R-37 · The scheduler can tell idle from a sleeping client**
*Assumed. Blast radius: narrow, by construction — the idle detector is an accelerator,
so being wrong costs a slower scan and never a missed deadline.* Recorded so that the
narrowness is deliberate rather than lucky. *Settles it:* falls out of R-32's
instrumentation.

---

## What this changes elsewhere

- `sync.md` — the scan-tier table's Cadence column: Quick becomes *"rolling, 6 h floor"*
  rather than *"not viable as a sweep"*; Deep becomes *"rolling, weekly floor"*.
- `decisions.md` — "No scan scheduler" moves out of Known gaps and into Settled, or
  into Open pending the owner's calls in §1 and §2.
- `ui.md` — "Still to resolve" gains nothing; §3 above deliberately resolves the
  freshness question *inside* the existing state language rather than adding a row.
- `README.md` — "Scan scheduling and the deep/verify tiers" stays under *Designed but
  not built*, now pointing here.
