# Selective sync — rules

**Designed, not built.** Nothing in this document exists in code yet.

## The premise

A user does not sync everything. With hundreds or thousands of series and a phone
holding a small fraction, the interesting question is not "what changed" but:

> given what I have asked for, what should I be holding — and of that, what am I
> missing or is stale?

That is a set difference against a **computed target set**, which is exactly what
the hash tree answers. Rules produce the target; the tree answers whether you have
it.

## The unification

**An imperative action is a rule with a lifetime of one evaluation.**

"Get chapter 45" and "always keep 10 unread of this series" are the same machinery
at different lifespans. This collapses what would otherwise be two features into
one.

```
rules → evaluate → target set → diff against held → fetch plan + evict plan
```

Keeping rule evaluation and diffing separate is what stops this becoming a mess.
The tree does not need to know rules exist; it just gets asked about a different
set.

## Four dimensions

### Scope — what set

- one chapter
- a range
- the next N unread — a **rolling window**
- a whole series
- a **collection**
- a filter (all completed, everything by this artist)

Collections matter most. Nobody manages 500 series individually; people think in
"currently reading", "on hold", "finished".

### Trigger — when

once now · standing · scheduled (overnight) · conditional (on wifi, charging,
storage permitting)

### Retention — what happens after

keep forever (pinned) · delete once read · keep last N read so you can flip back ·
evict under pressure

### Priority — when resources run out

which series gets space first, which fetches first, what goes first

## The hard parts

**A rule must show what it currently resolves to.** "Always keep 10 unread" is
abstract and therefore unpredictable. *"This means 47 chapters, 1.2 GB"* is
something a person can reason about. That is the difference between a settings
screen and a control.

**Rolling windows need read state, and the server does not have it.** Built and
then removed on 2026-08-28 (see `decisions.md`): tracking a reading position
server-side needs a user model, which needs auth. So a rule phrased in terms of
*unread* cannot be evaluated here. Rules that speak of recency, count or size
still can.
`updateChapter` used to accept a read position and throw it away, which made "keep
10 unread" not merely untested but incomputable. It is now stored, keyed
`(reader, series, chapter)`, and one rule is implemented: keep the N most recent
unread chapters of a series. See `decisions.md` for what that settled, and R-11 in
`register.md` for what it costs — and, more importantly, for what measuring it did
*not* establish: that the subset it picks is one a reader wants.

A chapter is unread, part-read or read, and **a part-read chapter is held outside
the quota** — so "keep 10 unread" holds 10 or 11. The window defaults to the *next*
unread rather than the *latest*, because comics are read in order and a reader 60
behind cannot open the ten most recent.

**Rules conflict and need precedence.** "Keep everything of series X" against
"delete after reading" — one must win, explicitly.

**Rules over-commit storage.** Twenty series at "keep 50" will exceed any phone. So
there is a budget, and an eviction order, and eviction is the half nobody designs.

**A device rule implies a server rule.** "Keep 10 unread on my phone" requires the
server to *have* ten unread, which requires acquisition from a source. One authored
intent, two hops, and the server acting on a device's behalf.

This forces a distinction worth being precise about: **per-client configuration is
fine; per-client sync cursors are what we were avoiding.** A rule is small, stable
and deliberately authored — nothing like a sync cursor. The tree stays stateless for
the sync itself.

## An unresolved contradiction

Two designs disagree and this must be settled before either is built.

- "Keep on this phone" was designed with **adds-only eviction** — it never deletes.
- A rolling window like "always keep 10 unread here" **implies** dropping what has
  been read.

Both cannot be true. Adds-only is safer and matches the principle that files belong
to the user; rolling windows are what people actually want on a device with finite
storage.

**Still unsettled, and the resolver is built to keep it that way.**
`resolveWindow` returns `evictCandidates` as a **list, not an instruction** — the
chapters that fall outside the target set, named and handed back. Adds-only,
rolling-window, and "show the user the list and let them choose" are all
implementable from that. Nothing in the code has quietly picked one.

## Prior art worth copying rather than deriving

- **Mihon / Tachiyomi** — same domain. Per-category auto-download, delete-after-read
  with a keep-last-N, category exclusions.
- **Podcast apps** — solved rolling windows years ago: keep N recent, delete when
  played, per-show overrides, a global cap.
- **Netflix Smart Downloads** — precisely "keep N unwatched": deletes what you
  watched, fetches the next.
- **Files On-Demand** (Dropbox, OneDrive) — everything *appears* present and
  hydrates when touched. This is already what the spine shelf does with pencil and
  ink, which means **the presentation of selective sync is solved** and rules are
  only the automation on top of something that works.

## Why this kills the journal

Worth recording here because the rule model is what settles it.

A journal cannot be selective. With 5,000 series and a client holding five, every
log entry concerns something the client does not have. The tree scopes natively —
you never descend into what you did not ask about — and selective sync is the normal
case, not an edge case.

See [sync.md](sync.md) for the full reasoning.
