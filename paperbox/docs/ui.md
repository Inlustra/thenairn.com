# Interface decisions

Drawn from five design studies. Status is marked per decision, because not
everything here has been signed off.

- **Settled** — agreed, build against it
- **Proposed** — a study's position, not yet accepted
- **Open** — genuinely undecided, and named as such

---

## The state language — *settled*

One vocabulary across both clients.

| | Means |
|---|---|
| **Pencil** | intent — queued, coming, exists but not here |
| **Ink** | fact — it is yours |
| **Amber** | weather — trouble that resolves itself |
| **Red** | a person is needed |

**There is deliberately no green.** Done is not an event, it is the resting state of
a library. A green tick implies a task completed; a library at rest is simply normal.

Skeleton loaders are drawn as the pencil layer — the same idea, applied to time
rather than possession.

**Ink is device-relative on the phone**: *ink is what survives unplugging*. The same
chapter is ink on the server's own interface and pencil on a phone that has not
fetched it. This is the single most important consequence of the language, because
it makes "whose fact is this?" answerable at a glance.

## Failure — *settled*

**Failure is pure degradation.** The interface quietly becomes less capable. It never
blocks a path the user was already on, never seizes attention, and anyone who wants
detail can dig for it.

The word "first-class" was explicitly rejected for error surfaces — it invites
prominence, and prominence is how this gets done badly.

**One fact must always be plainly reachable: whether anything the user already had
was harmed.** Usually nothing was, and a user cannot infer that. On the phone this is
backed by hash-verifiable local copies, so it is a checked fact rather than
reassurance copy.

**Errors are triaged by three questions**, and the answers imply different treatment:

1. Does it heal itself? → amber, and **no retry affordance** — offering retry on a
   rate-limited source invites the user to make it worse
2. Does it need a person? → red, with exactly one verb
3. Was anything lost? → say so, every time, even when the answer is no

## Two progress domains — *settled*

Server-acquires-from-source and device-syncs-from-server are constantly confused.
They are separated **structurally, not just with different words**:

| | Far lane (server ← source) | Near lane (device ← server) |
|---|---|---|
| Geometry | the glyph's circle, pencil only | an underline — the only mark that fills with solid ink |
| Surface | no ambient presence | the ambient seam animates only for this |
| Resolution | dated sentences | bytes and percentages |
| Verb | the server **inks** | the phone **keeps** / is **in step** |

A ticking percentage invites you to watch something you cannot influence. The near
errand earns numbers because it is yours.

## Acquisition — *settled*

**One verb.** "Get" means *make it readable where I am* — two hops from the phone,
one from the laptop, same word. Two verbs were rejected as casting the user as a
pipeline operator.

**Standing intent, not repeated errands.** "Keep on this phone" is one switch that
watches the source, fetches new chapters automatically overnight, and carries the
next N unread. Notify-and-ask was rejected: *a question with only one answer is a
doorbell.*

**Say the timescale once, at the ask. Never estimate.** Nothing else in a reading app
takes hours, so there is no convention to borrow — and a progress bar that cannot
predict is worse than a sentence that admits it.

**Design the return, not the progress.** Arrival surfaces on the Continue rail —
*discovered, not announced*. The user put the phone away; what they come back to is
the design.

## Attention and notification — *proposed*

From the metadata work, and the reasoning is worth keeping intact:

**Silence never notifies.** A series going quiet is indistinguishable from its release
logging dying, so silence alone cannot be trusted as a signal.

**The only loud state is a release while dormant** — a series long silent publishing
again. That cannot false-positive from logging decay, and it is one of the few
notifications a reader is genuinely glad to receive.

Estimated at roughly one per year on a twenty-series shelf, which is too rare to
become noise. Shipped shelf-first with an opt-in, off-by-default interruption.

**Nothing loud may exist below the confirmed tier** — a guessed series match must
never generate an interruption.

## The chapter list as a shelf — *approved in principle*

Chapters render as **book spines**, not rows or cover tiles.

- **A bookcase, not a shelf** — 313 spines wrap into boards with range plates
- **Upright numerals on a printed foot band** in the chapter's own dominant colour,
  text picked by luminance. 45° skew was tried first and **lost** against real
  artwork — it fights the art behind it, and real volumes are numbered upright
- **Thickness carries page count**, square-rooted so 4-page and 205-page chapters
  both read honestly
- **Legibility beats density**, explicitly. Spines are floored at the narrowest width
  that carries a three-digit numeral. The price — five phone screens instead of
  three — is stated rather than hidden
- **The shelf is the touch target, not the spine.** Drag along it with a loupe
  following your thumb; release pulls a spine out with its verbs. A tap is a
  zero-length drag. This sidesteps the thin-target problem instead of fighting it
- **A gap is a missing volume**, with neighbours leaning into it
- **Only a real book has a face.** Pencil states carry no artwork, because those
  pages are not on disk to cut from. A stalled fetch stands at its true fill — art
  below, pencil-dashed absence above

Spine art is a narrow vertical sliver taken from inside the chapter, chosen by
saliency scoring rather than a fixed position, with speech balloons actively
penalised.

**Open:** is this the default chapter list, or one view among several? It costs title
legibility and accessibility — the honest ledger in the study lists both.

## Information architecture — *open*

The two clients currently disagree and this needs resolving.

- The mobile study lands on **two tabs** — Shelf, and *On this phone* (storage as a
  place, activity as a lens)
- The web study is **library-first with a workbench** — the library is the front
  door, and the workbench is the one room where the server may speak at length,
  because you walked in and asked

What the shared architecture is, and where the clients legitimately diverge, is
undecided.

## Client boundaries — *settled*

**The web client holds nothing and does not pretend.** No offline library, no cached
shell, no skeleton standing in for absent data. Server-unreachable is **the one plain
page** — it says where the truth is, retries itself, names the likely causes, and is
the only blocking state in the product. Pretending was rejected: *theatre is worse
than absence.*

**The phone owns offline.** It holds copies, so layering, fallback and divergence
handling live there.

**Mobile-first is a layout discipline, not a behaviour.** Conflating the two is how
offline-first crept into a client that has no local storage.

**Administration lives on the web.** Scanning, source configuration and diagnosis,
browsing sources for new series. Including it on the phone would turn a reading app
into an admin console. The rule that generalises: *administration may enter the phone
only as a remedy, pre-scoped, reached from the trouble it resolves.*

## Ownership — *settled*

**The files belong to the user.** Never moved, never renamed, never rewritten, never
auto-deleted. Where a scan or import is invoked, that promise is restated at the
point of invocation rather than buried in documentation.

**Human flagging outranks checksums.** A source once served byte-perfect files of an
entirely different comic; only a person reading it noticed. So a user saying "this is
wrong" must beat any automated confidence.

**A plan is never permission.** A diff reports difference, not correctness. Nothing
auto-applies.

## Copy — *settled*

One line each, never paragraphs. Attached to the thing it explains, at the point of
use — no help page, no docs tab, no onboarding carousel.

Explain the *model*, not the widget: sources → queue → library → phone. Strongest
when there is nothing to look at (empty and first-run states) and when something has
gone wrong; receding once there is real data on screen.

Flat and factual. No exclamation marks, no encouragement.

**Sync is the process, not download.** You download a TV episode — large, discrete,
unchanged once you have it. A chapter is dozens of small files, any of which can
change, held as a shifting subset that must stay in agreement. The word "download"
should largely disappear, and completion changes meaning with it: a download finishes
forever, whereas being *in step* is a state you can silently fall out of.

## Still to resolve

| Question | Blocks |
|---|---|
| Is the spine shelf the default, or one view? | Series view |
| What is the shared information architecture? | Both clients |
| Adds-only eviction vs rolling unread windows | The rule system — see [rules.md](rules.md) |
| Does the hiatus return earn a push notification? | Notification design |
| How is a guessed match shown before it is confirmed? | Library and series views |
