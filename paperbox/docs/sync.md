# Sync and change detection

## What answers "what changed?"

A five-level Merkle tree, keyed by content, walked **server-side**.

```
root → series → block → chapter → page
```

| Decision | Chosen | Because |
|---|---|---|
| Block key | chapter **number** ÷ 25 | Grouping by key, not position — an insertion dirties one block, not all after it |
| Id shape | `treeVersion`, sent on every reply | An id rename is not a deletion, and a client cannot tell the two apart from `gone` alone |
| Leaf value | `hash(name + byte size)` | Stat-only. Never mtime, which changes on any copy or restore |
| Parent value | `hash(child id + child hash, …)` | Covers identity, so a membership swap cannot hash the same |
| Truncation | 8 bytes / 16 hex | Change detection, not security |
| Walk | server-side, one round trip | The server holds every hash; making the client descend is pure latency |
| Granularity | never below chapter | Return `(chapter, page_count)`; the client enumerates. 7.9 KB → 150 B |

### The parent-covers-identity rule

Parents hash `(child id, child hash)` pairs, not child hashes alone. Without this, a
membership change can be invisible: swap one chapter for another whose pages happen
to hash the same and the parent is unmoved. This was a real bug, caught by a test
that failed twice before the cause was found.

### Blocks are keyed by number, never by position

Blocks of 25, as `1–25`, `26–50`, and so on. A new chapter 152 lands in its own
block; inserting 71.5 dirties only `51–75`.

Blocking by array index would shift membership on every insertion and dirty every
block after it — the same mistake as positional identity, one layer up, and it
would make the tree report constant false change.

Two chapters are not where a first reading puts them. **Chapter 0 belongs in `1–25`**:
`sortKey` 0 is ambiguous between "the number is zero" and "there is no number", and
`mark` is what separates them — `Chapter 000` marks as `0`, `Oneshot` marks as empty.
Only the second belongs in the `unnumbered` block. **A directory covering a range
belongs to every block it spans**: `Chapter 24-27` hangs under `1–25` *and* `26–50`,
because `resolve: "nodes"` exists so a screen can say "something in chapters 26–50
changed" and chapters 26 and 27 are in there. The consequence is that a chapter node
can be reached twice during a walk; `diff` visits each node id once, so the plan still
lists each image exactly once.

### `treeVersion`: an id rename is not a deletion

Every `/api/sync/tree` and `/api/sync/diff` reply carries `treeVersion`, currently
**2**. It versions the *spelling of the ids*, not the content behind them.

v1 → v2 changed block ids from `b:<uid>:<start>` to `b:<uid>:<seq>:<start>`, moved
chapter 0 out of the unnumbered block, and started filing ranged chapters into every
block they span. No image moved. A v1 client diffing against a v2 server nonetheless
sees every block id it holds in `gone` and every block id we return as `added`.

**On a `treeVersion` it does not recognise, a client must drop its `have` set and
re-diff from empty. It must never treat the resulting `gone` as an instruction to
delete content.** `gone` is only meaningful between two parties on the same
`treeVersion`.

This is the **boundary-shift problem**, named in LBFS (2001). The general form:
boundary shift is caused by grouping by *position*, and cured by grouping by any
function of the key alone. A rolling hash is one such function; a key-range
partition is another, and it is the simpler one.

## Everything is a leaf

The tree does not care what a leaf *is*, only that it hashes. So metadata is not a
separate mechanism — it is a leaf with structured content.

```
root
└── series
    ├── meta          one leaf: title, status, upstream count, genres, cadence
    ├── cover         one leaf: the image
    └── blocks
        └── chapters
            └── pages
```

**A metadata change costs almost nothing to locate.** The series hash moves, the
client descends one level, the block hashes match and prune immediately, and `meta`
is the only thing that differs. Two or three comparisons.

An earlier draft of this document proposed per-facet hashes — a `contentHash` and a
`metaHash` on every node — on the theory that a metadata refresh would otherwise
make a client re-descend into unchanged content. **That was wrong.** Unchanged
subtrees prune on the first comparison; there is no re-descent to avoid. Facets
would have bought a marginal byte saving in exchange for two hashes everywhere and
two invalidation paths.

Nor is it a problem that the root hash moves when a registry refresh changes an
upstream chapter count with nothing on disk having moved. Something *did* change,
and a client is entitled to know. A root that churns when something changed is the
tree working.

### The meta leaf is one blob per series

Around a kilobyte. Splitting title from status would buy nothing and cost another
node, and any metadata change refetching all of it is free at this size.

### Provenance sits under the chapter

Which means re-sourcing a chapter whose pages are byte-identical still moves the
chapter hash — the pages did not change, but where they came from did. That is
correct for a client displaying provenance, but it means **"the chapter changed" no
longer strictly means "the bytes changed"**, and anything reasoning about the two
should not assume they are the same claim.

### What stays out of the tree

**Device-authored state.** Sync rules are configuration the device wrote, not a
server fact to compare against. Read positions merge — furthest wins — rather than
propagate. Neither belongs in a structure whose premise is that the server is the
source and the client compares against it.

That is one exception, not a second mechanism.

## Why not a journal

An append-only log with a cursor was proposed independently by three separate design
studies, and rejected. The reason is decisive and structural:

**A journal cannot be selective.** With 5,000 series and a client holding five,
every entry in the log concerns something the client does not have. The ways out are
all bad — the client reads the whole log and discards 99.9% of it; or the server
filters by subscription, which reintroduces per-client sync state; or there is a
journal per series, and "one request" becomes N requests.

**The tree scopes natively.** `scope: s:<uid>` and you never descend into what you
did not ask about. Cost is proportional to what the client cares about, not to
library churn. Selective sync is the normal case for this product, not an edge case.

The journal's one genuine advantage — ordering, so you can say "chapter 45 arrived
at 03:12" — does not survive scrutiny either. The client knows when *it* fetched
something, and the server's acquisition time already rides on the chapter as
`provenance.fetchedAt`. Arrival semantics are derivable from node data plus local
knowledge.

A tree is also a **proof**: if the root hashes match, everything beneath matches, and
corruption surfaces at the next comparison. A journal has no self-check — miss one
write during a crash and a client diverges permanently with nothing to notice.

A partial implementation exists in `src/journal.ts` and is **not wired in**. It is
kept for reference, not for use.

## Rejected alternatives

Documented so they are not re-litigated. Full reasoning lives in the design research.

- **Prolly trees / Merkle Search Trees** — exist to provide history independence,
  which a key-range partition already has. The constant does not disappear, it
  becomes a target average with added variance. Every real user of content-defined
  grouping over file collections enables it at 10⁴–10⁵ entries; our degenerate case
  is a ~16 KB node.
- **IBLT, PinSketch, CPI** — optimise *discovery*, but chapters are atomic so our
  difference is already ~150 bytes against ~1.1 GB of payload. Each introduces a
  probabilistic failure mode we do not have.
- **Rateless IBLT** — genuinely the best algorithm of the set, and still a 0.0017%
  saving bought with a probabilistic decode in the correctness path.

## Scan tiers

Four tiers. Which run on a schedule depends entirely on who writes the files.

| Tier | Work | Today | At 24M files | Cadence |
|---|---|---|---|---|
| **Targeted** | one series, after a write we performed | instant | instant | every download |
| **Quick** | readdir + dir mtime + page count | 40 ms | **~14 min** | not viable as a sweep |
| **Deep** | stat every page, recompute fingerprint | 3.4 s | ~23 min | rolling, user-managed libraries |
| **Verify** | read bytes, sha256 | minutes | hours | manual |

**Only Targeted and Quick exist.** There is no scheduler.

**This section previously claimed ~0.3 s at 5,000 series and "new chapters surface
within a minute". Both were wrong**, and they were arithmetic, not measurement — a
file count multiplied by a readdir rate that had been measured on a different
operation. Measured on the real mount (register R-29), scan cost is linear at
~1.2 ms per chapter, so a full quick pass at the 710,000-chapter target is
**~865 s**, not 0.3 s.

A 30-second cadence is therefore impossible: the sweep does not fit inside its own
interval. New content still appears cheaply *per series* — adding a folder bumps its
parent's mtime — but a scheduler has to be a **rolling partial scan** with a priority
order rather than a full sweep, and nothing here has designed one.

The good case is unaffected: after a download we know exactly which series moved, so
the targeted tier stays instant and is what covers content Paperbox fetched itself.

### The asymmetry that makes a cheap gate safe

A gate may be wrong in exactly one direction.

- **False positive** — an rclone sweep bumps timestamps, the gate fires, the
  fingerprint recomputes identical, no client hears anything. Costs one wasted stat
  sweep.
- **False negative** — the gate stays quiet while something changed. Silent
  divergence, and the only real risk.

The gate decides whether to *look*; the fingerprint decides whether anything
*changed*. That is why mtime is safe as a cache key and unsafe as truth, and why
page mtime must never enter the fingerprint — doing so would bill every client a
full re-download every time a backup restores a file.

### What nothing cheap can catch

- **An in-place overwrite at identical byte size.** Invisible to the gate (a file's
  contents changing does not touch its parent directory's mtime) and invisible to
  the fingerprint (name and size unchanged). Only a byte-level verify sees it.
- **Bit rot.** Structurally the same. btrfs already checksums on read and beats
  anything we would build.

Every system surveyed accepts both. rsync's default accepts them; Komga and Kavita
accept them and ship explicit escape hatches instead.

**Our blind spot is wider than rsync's**, and this is worth stating plainly: rsync
stats *every file* and compares each file's own mtime. We gate on the chapter
*directory*, so a per-file change inside an unchanged directory is never examined.
The honest comparison is to Komga and Kavita, which have the same directory-level
gate and both ship a deep-scan escape hatch.

## The two progress domains

These are constantly confused and must be kept structurally distinct.

| | Far lane | Near lane |
|---|---|---|
| What | server acquiring from a source | device syncing from server |
| Speed | hours | fast with signal |
| Fails by | rate limiting, block pages, layout changes | tunnels, dead batteries, full disks |
| Control | outside the user's | entirely the user's |
| Should render as | dated sentences, never a ticking number | bytes and percentages |

A ticking percentage invites you to watch something you cannot influence. The near
errand gets numbers because it is yours.

**The API does not currently distinguish them** — `/api/sync` is the near lane,
`/api/downloads` is the far lane, and they share no vocabulary.

## What everything above cost to learn

Measured on the real box, and worth keeping because they contradict intuition.

```
readdir only, no stat            1.09 s   (53k files/s)
stat every file, serial         23.5  s   (2.5k/s)
stat every file, concurrency 32  3.35 s   (17.2k/s)  ← plateau
chapter directories only         0.089 s
```

`find -type f` is not a stat benchmark — it reads `d_type` from `getdents64` and
calls zero `stat()`s. The readdir rate and the stat rate are not comparable, and
conflating them produced a badly wrong scaling estimate.

Cold tree build went from **17.3 s to 13 ms** once fingerprints were persisted and
page expansion made lazy. The tree now builds to chapter level from metadata and
touches no image files; pages expand only for chapters that already failed their
hash comparison.
