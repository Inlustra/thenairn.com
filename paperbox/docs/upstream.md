# Upstream — registries, sources, and what "exists" means

We used one word for three different things. This is the correction.

## Upstream is three distinct things

### 1. The registry — what exists

MangaUpdates, AniList, Comic Vine, Metron. Says a series stands at chapter 327, is
ongoing, publishes weekly, has this cover, these authors, these season boundaries.

**One binding per series**, established by matching.

### 2. The sources — where we can actually get it

Weeb Central, AsuraScans, and so on. Each has its own chapter availability,
translation quality, reliability, and history with us.

**Zero to many bindings per series.** A single series can hold chapters acquired
from several sources over time — ours already does.

### 3. The publication — the real world

The publisher releasing chapter 327. Never directly visible; only ever inferred from
the other two.

## Why the distinction matters

### "14 behind" is three different numbers

- Behind the **registry** — we hold 313, it says 327 exist
- Behind a **source** — that source may only have translated to 320
- **Gettable now** — what a healthy bound source has, minus what we hold

Only the third is actionable. The first is context. Conflating them produces an
interface that promises chapters nobody can deliver.

### A stalled source is currently invisible

A series sitting at 313 with nothing arriving is indistinguishable from a series
that *ended* at 313. The user quietly stops seeing it and assumes it is over.

With a registry binding the interface can say: *14 published, none here, and the
source we use has not moved in three months* — and then offer the action that helps.

**"Behind" is therefore not one state.** Behind-and-fetching,
behind-because-our-source-stopped, and behind-because-nobody-has-it are three
situations with three remedies. Only the middle has an obvious action attached, and
it is the one that is currently invisible.

### Find it elsewhere

The journey this unlocks:

1. The gap is visible — registry says more exists than we hold
2. The reason is visible — our bound source is behind, stalled, or dead
3. The user asks Paperbox to look elsewhere
4. Paperbox reports what each known source actually has
5. Missing chapters come from the new source

**This is the same action as re-sourcing bad content, with a different trigger.** A
source that stalled and a source that served the wrong comic both resolve to "find
me another". One action, two entry points.

Sources die and series get adopted by other groups — that is normal, not
exceptional. One series in our library shows a real succession: the translating group
collapsed in 2022, there was a chaotic period, another picked it up. A source binding
is routine maintenance, not error recovery.

Release records name the group that published each chapter, so *who is translating
this now* is answerable from metadata. Paperbox can order its search by the
currently-active group rather than blindly trying everything.

### Neither upstream is authoritative

A registry's release logging can die while the series continues — so an absence of
records does not mean an absence of chapters. A source can serve byte-perfect files
of an entirely different comic; that has happened here, across seven chapters,
caught only by a human reading them.

Nothing in the interface may present either as truth, and "the server is confident"
must never read as "the server is right".

## Registries are plural and pluggable

There is no single database of comics.

```
MangaUpdates   works, no credentials       manga / manhwa
AniList        works, no credentials       manga / manhwa
Metron         401 — free account + token  western comics
Comic Vine     401 — free API key          western comics
GCD            403 — no open API           western comics, data dumps
```

Our library holds nine Korean manhwa and three Warhammer titles. The Warhammer
titles matched nothing because we only asked manga databases. They are legitimate
comics; we asked the wrong place.

### Consequences

**Unconfigured is a different state from unmatched.** MangaUpdates and AniList
spoiled us by needing no credentials. A series can be unidentifiable simply because
nobody connected the provider that knows it — *"we could identify this if you
connected Comic Vine"* is far better than silence.

**"No match" splits into three:** not found in the providers we asked; found in no
provider we have *configured*; genuinely in none that exists. Only the last is
permanent.

**Which provider to ask is not obvious.** Possibly inferable from the folder or the
source, possibly by trying each. Ambiguity resolves through the same confirm flow,
with the provider as part of what is confirmed.

### ComicInfo.xml is a fourth kind of upstream

The de facto metadata format for comics, read by Komga, Kavita and Mylar. It is
**metadata the files carry with them** — genuinely different from a provider you
query, because it arrives with the library, has already been curated by whoever
assembled it, and should probably be believed over a guess.

It matters in both directions: writing it back is what stops people being trapped in
Paperbox.

A series identified this way has no ID to re-query, no cover to refresh, and no
upstream chapter count — so it is *matched* but cannot tell you that you are behind.

### The abstraction needs defining

What must a provider supply to be treated uniformly? What happens when two providers
disagree — and they will? What does the interface show when identity came from an
embedded file rather than any provider? A design assuming one provider will not
survive a mixed library.

## Matching

### Title similarity is confidently useless

Measured across all twelve of our series:

```
folder                              ours   upstream   confidence
Nano Machine                         313        327   high    correct
Solo Leveling                        201        201   high    correct
SSS-Class Suicide Hunter             151        151   review  correct
Return of the Disaster-Class Hero    167        186   high    correct
Omniscient Reader's Viewpoint        201         42   high    WRONG
Reincarnation of the Suicidal…       102         27   review  WRONG
Trash of the Count's Family          176        185   review  unverified
The S-Classes That I Raised          165          —   none
Warhammer 40,000 ×3                 1–5          —   none
```

**Two matched at "high" confidence and are plainly wrong** — 42 upstream chapters
against our 201. Chapter-count agreement is a far better signal than string distance.

An early harvest was worse still: a title search returned records from *fourteen
different series*, some dated `1111-11-11`. The releases API supports series-ID
scoping and it was not used. Our own data-gathering is the exhibit for why this
needs to be a confirmed mapping.

### The model

**Automatic lookup by default.** The common case needs no interaction — identify,
fetch, done. Confirmation is for the uncertain and the wrong, not a toll on every
series.

**Confidence cannot gate silence.** Two of twelve would have been silently
mislabelled. Something stronger than a similarity score has to decide.

**Show the guess, the user confirms.** Failing that, they search within Paperbox.
Evidence beats similarity: chapter count comparison, year, type, alternative titles,
cover.

**Store the confirmed mapping.** Once, per series, then never guess again.

**Four states, all real:** matched and sourced; matched but unsourced (we know what
it is and cannot get more — a genuinely useful thing to say); sourced but unmatched
(we can fetch, know nothing); neither. Plus the identity-from-file case, which is a
third axis rather than a fifth state.

## What this enables that we could not say before

Concrete, from real data: our library holds 313 chapters of one series and the
registry says 327 exist, with our newest dating from 20 May 2026 while the series has
published weekly since. So *"14 behind, acquisition stopped, the series didn't"* is
now sayable, and is today indistinguishable from *"finished"*.

Release history also gives cadence — median interval, publication rhythm, and
genuine silences. Two independent fields agreeing (a 63-day gap landing exactly on a
recorded season boundary) is stronger corroboration than either alone, and would let
season dividers come from data rather than from parsing folder names.
