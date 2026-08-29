# The client sync engine

`client/` — the device half of sync. Written 2026-08-29, before the mobile app
exists, because the client half is where a sync product succeeds or fails and it
is the half nobody had designed.

**Pure TypeScript.** No DOM, no Node, no React, no import from `src/`. Five
adapters carry everything platform-specific: `SyncTransport`, `ContentStore`,
`StateStore`, `Clock`, and optionally `DeviceConditions`. `client/memory.ts`
implements all five, which is what the tests and the demo run against; a React
Native app supplies fetch, a filesystem and AsyncStorage instead and the engine
does not notice.

```
bun run client/demo.ts     # a device syncing, losing signal, filling up, evicting
bun test client/           # 39 tests: 7 scenarios plus the units under them
```

## The pipeline

`docs/rules.md`, one line, and the code is arranged around it:

```
rules → evaluate → target set → diff against held → fetch plan + evict plan
```

| Module | Job | Pure? |
|---|---|---|
| `catalog.ts` | fold `/api/sync/diff` replies into a mirror of what exists | yes |
| `rules.ts` | rules + read marks + catalog → target set | yes |
| `plan.ts` | target set + held → fetch plan + evict candidates | yes |
| `engine.ts` | the state machine, and the only thing that does I/O | no |

The first three are pure functions of their inputs. That is what makes the
scenario tests worth writing: a failure is a failure, never weather.

## The state machine

```
        ┌──────────────────────────────── unblock() ──────────────┐
        v                                                         │
  idle ──> checking ──> planning ──> working ──> checking ──> idle │
             │             │            │                          │
             │             │            ├── NetworkError ──> offline ──(clock)──┐
             │             │            └── no room ─────────> blocked ─────────┘
             └── 304 and nothing pending ──> idle
```

- **checking** — `GET /api/sync/tree` with the ETag. The node hash *is* the
  ETag, so "has anything moved" costs a 304 and no body.
- **planning** — one `POST /api/sync/diff` at `depth: 3, resolve: "nodes"`. That
  stops at chapter level, so the server opens no image file. Fold into the
  catalog, evaluate the rules, build the plan.
- **working** — per chapter: one scoped `resolve: "pages"` diff, then the pages.
- **offline** — backs off on an injected clock. Nothing is lost; staged pages
  stay staged.
- **blocked** — a person is needed. One reason sentence, in bytes. Cleared by
  `unblock()` (the red state's one verb, per `ui.md`) or by any input changing.

`tick()` does one bounded unit and returns; `run()` ticks until settled. The
caller owns the schedule, because a phone's scheduler is the phone's business.

## Durable versus derived

**Durable** — the catalog, the rules, the read marks, the plan in flight
(`StateStore`); staged pages and held chapters (`ContentStore`).

**Derived, and never stored** — the target set, the `have` set, the evict
candidates, every progress number. All of it recomputes from the two durable
halves in microseconds, which is what makes a crash uninteresting: reload,
re-derive, carry on.

The one hard invariant: **`commit()` is the only thing that makes a chapter
held.** Staged pages are visible to the engine and invisible to the library.
A process killed mid-chapter comes back with pages on disk and no chapter in the
shelf — never a partial page set presented as ink. It mirrors the server's own
"downloads stage then swap".

## The `have` set

Claiming a node means *everything under this id is mine at this hash*, and the
server prunes the whole subtree on the strength of it. So the engine claims a
block only when its arity is known, every chapter of it is in the catalog, and
every one of those is held at the catalog's hash — otherwise it claims the
chapters individually. Under-claiming costs bytes; over-claiming loses content
silently, and that asymmetry decides it.

On the live library the difference is ~1,700 entries per diff versus ~90.

## Four decisions worth defending

**The chapter hash is a change *signal*; the page hashes are the change *set*.**
`sync.md` admits that provenance sits under the chapter, so re-sourcing moves the
chapter hash while every page hash stays put — *"the chapter changed" no longer
means "the bytes changed"*. A client reconciling at chapter granularity would
re-download a whole chapter over a string change. So every repair is resolved
with page-level `have` entries, and the server returns only the pages that
genuinely moved. Scenario 4 asserts the transfer is exactly zero bytes.

**Verification is a length check, not a hash.** The server's page hash is
`hash(name + byte size)` and nothing else, so comparing the delivered length
against `ImageRef.size` is exactly as strong as recomputing it — and it keeps
crypto out of a file that has to bundle for React Native. A short body is
treated as the network, not the server: a connection that died mid-response
looks precisely like this, and the half page is never staged.

**A `treeVersion` change drops the `have` set and deletes nothing.** The catalog
*is* the `have` set's only home, so emptying it is exactly the documented
contract; `held` is untouched. Every held chapter is then re-offered by the next
diff and resolved page by page, which transfers nothing, because the page hashes
did not move. Cost: round trips. Not bytes, and not content.

**Eviction defaults to `housekeeping`.** `rules.md` leaves adds-only versus
rolling windows explicitly unsettled and asks the resolver to "return a list, not
an instruction". So the default policy removes only what *no rule wants* — the
one thing both camps agree is rubbish — and the app chooses `adds-only` or
`rolling` deliberately. A pin is never a candidate under any policy, at any
pressure; the device blocks and says how many bytes short it is instead.

## Rule conflicts

Every rule bids on every chapter it touches, wanting it or releasing it, and one
resolution runs over the pool:

1. higher `priority` wins outright;
2. then the more specific scope (chapter > range > window > series > collection);
3. then **retain beats release** — the files belong to the user, and an unwanted
   megabyte is cheaper than a deletion nobody authorised.

A chapter two rules disagreed about is marked `contested` with every contributing
rule id, so a screen can say *why* it is there. An imperative "get chapter 45" is
`{ scope: chapter, lifetime: "once" }` and retires itself once held — there is no
separate download path.

Resolving as you go (first rule wins, later rules only add) was tried first and
is wrong: it made a high-priority `deleteWhenRead` lose to a low-priority `keep`
purely because of array order, which is a rule engine that ignores the priority
field it asks the user to set.

## Failure modes handled

| What happens | What the engine does |
|---|---|
| Offline mid-sync | staged pages kept; backs off on the injected clock; resumes page-by-page and re-fetches nothing |
| Server dies mid-body | short read → treated as network; nothing stored; retried whole |
| Flaky connection | every failure is a backoff, never a lost page |
| Server changes under an in-flight plan | plan marked stale, finished, then re-planned; a chapter re-paged mid-plan commits at the hash the server now serves |
| A chapter vanishes mid-plan | forgotten locally (the server cannot report it — see api-gaps #14), plan marked stale |
| A chapter loses a page | the merged page set disagrees with the chapter's page count → re-resolved in full |
| Storage fills | evict by policy, lowest rank first, never above the fetching item's priority; otherwise block with a byte count |
| Killed mid-chapter | partial page sets are never held; restart re-plans and skips what is staged |
| `treeVersion` bumps | have set dropped, nothing deleted, nothing transferred |
| Two rules disagree | resolved by priority, then specificity, then retain-beats-release; marked contested |

## The simulator

`client/sim/` fakes the world deterministically.

- **`library.ts`** — a mutable in-memory library and a re-implementation of the
  server's hash tree. Not an import: the point is to have no filesystem and to be
  mutable mid-run. It copies the semantics that matter — leaf is name+size,
  parents hash child *identity*, blocks key on number ÷ 25, chapter 0 with a mark
  is in `1-25`, a ranged chapter spans several blocks and is visited once, and
  `gone` is computed against the *scoped* subtree, bug and all.
  Mutators: `addChapter`, `removeChapter`, `removeSeries`, `resource`, `repage`,
  `dropPage`, `bumpTreeVersion`.
- **`server.ts`** — the wire, plus weather: `offline`, `failureRate` (seeded
  PRNG, never `Math.random`), `latencyMs` (advances the injected clock),
  `dieAfterImages`, `truncateImages`. It counts every fetch per url, so
  `refetched()` returning `[]` is a real assertion about repeated work.
- **`harness.ts`** — `makeWorld()` and `settle()`, plus `restart()`, which
  rebuilds the engine over the same durable stores. That is a process death.
- Storage is `MemoryContentStore` with a finite `capacityBytes`, so eviction
  actually has to happen.

## Left to the app

- **Concurrency.** The engine fetches one page at a time, deliberately: parallel
  page fetches are a transport concern and belong in the `SyncTransport` the app
  supplies.
- **Scheduling.** `tick()`/`run()` expose the loop; when to run it — on wifi, on
  charge, in a background task — is platform policy.
- **Atomic writes.** `StateStore.save` is handed a string; making that atomic is
  the platform's job, as is making `ContentStore.commit` a real rename.
- **The eviction policy choice.** `adds-only` versus `rolling` stays unsettled by
  design (`rules.md`), and the app picks.
- **Presentation.** The engine emits `SyncEvent`s and a derived `progress()`; the
  near-lane underline, the seam and the ledger are `ui.md`'s business.
