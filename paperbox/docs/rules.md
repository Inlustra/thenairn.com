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

**Rolling windows need read state, which we discard.** "Keep 10 unread" cannot be
evaluated without knowing what has been read. `updateChapter` currently accepts a
read position and throws it away. This is now a dependency of the sync model, not a
nice-to-have — the third separate place it has surfaced as a blocker.

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
