# API gaps — what the web client needs that the server does not provide

Written 2026-08-28 alongside the web client rebuild. The client's full
contract lives in `frontend/api/contract.ts`; the real endpoints are bound
in `frontend/api/real.ts`; **everything below is served by
`frontend/api/pending.ts`**, the only place unimplemented behaviour lives.
When a route lands, the change is: implement it in `real.ts`, repoint one
line in `frontend/api/index.ts`, delete the adapter entry. Views never
know the difference.

The workbench's Diagnosis tab states this list to the user, so the client
never silently pretends adapter data is server fact.

| # | Gap | Contract | Views that need it | What it blocks |
|---|-----|----------|--------------------|----------------|
| 1 | Read state | `ReadStateApi` | Library (unread counts, Continue rail), Series (read dim, Unread filter, resume), Reader (positions) | Cross-device positions, rolling windows, Tachiyomi migration |
| 2 | Identity / registries | `IdentityApi` | Library (captions, gap tail), Series (hold line, pulse, seasons, identity line), Workbench › Registries | Honest behind-counts, stalled-source detection, the returned band |
| 3 | Source health | `SourceHealthApi` | Workbench › Sources, Series and Library amber captions | Stall detection, fetch history, diagnosis evidence |
| 4 | Look elsewhere (survey) | `SurveyApi` | Series (behind + stalled) | The re-sourcing journey; also the wrong-content replacement hunt |
| 5 | Sync rules | `RulesApi` | Workbench › Rules | Everything in docs/rules.md; needs device pairing first |
| 6 | Per-series freshness | `FreshnessApi` | Library stamps, Workbench copy | The scan scheduler (docs/scheduler.md, designed not built) |
| 7 | Content flags | `FlagsApi` | Reader end card, Series rows | Household visibility, source quarantine, the hunt |
| 8 | Delete / exclude | `ManageApi` | None shipped (deliberate) | Removing anything adoption brought in |
| 9 | Spine + cover art | `spineArtUrl` / `coverArtUrl` | Series › Shelf, Library covers | Routes in the contract, server build in flight — a 404 renders flat series ink; palette (band colours) still undesigned |
| 10 | Lane vocabulary | *(status envelope)* | App seam, Workbench › Activity | The API cannot express far-lane vs near-lane (decisions.md, Known gaps) |
| 11 | Background jobs | `JobsApi` | Workbench › Activity ("In the background"), user-invoked scan's Stop | Until `/api/jobs` answers, only the scan envelope is visible — art/cover work and the un-ask are dark |

---

## 1. Read state — `ReadStateApi`

**Server work is underway in `src/readstate/`** (store, schema, resolver,
Tachiyomi import). The routes are not mounted yet.

Adapter behaviour: localStorage, furthest-wins locally. Honest for one
browser, invisible to every other device — which is exactly the gap
(`decisions.md` lists it as having blocked three separate designs).

Proposed routes:

```
GET  /api/readstate/:seriesId            → SeriesReadState
PUT  /api/readstate/:seriesId/:chapterId { page, pageCount }   (furthest wins)
PUT  /api/readstate/:seriesId/:chapterId/read { read }
GET  /api/readstate/continue?limit=N     → ContinuePoint[]
GET  /api/readstate/unread-counts        → Record<seriesId, number>
```

Merge rule (from docs/sync.md): read positions merge furthest-wins, and
they stay **out of the hash tree** — device-authored state is the one
exception, not a second mechanism.

## 2. Identity / registries — `IdentityApi`

The registry binding of docs/upstream.md: one binding per series, stored
as provider IDs, established by corroborated evidence (never by name
score alone — two of twelve matched at "high" and were wrong), re-scored
as chapters arrive, demoting itself on contradiction.

Adapter behaviour: the REAL 2026-08-28 harvest results (real registry
counts: Nano Machine 327, Disaster-Class 186, the ORV/Estate-Developer
contradictions, the Warhammer unconfigured case), keyed by series title,
with confirm/reject/files-only decisions overlaid in localStorage. It
does not poll anything, so its `asOf` stamp never moves — visible in the
UI as "card as of 2026-08-28", which is the honest rendering.

Needs server-side: the provider abstraction (registry card: identity,
status vocabulary, latest unit + unit kind, contributors, seasons,
release records, freshness stamp — every field may be "unknown"),
per-field precedence when providers disagree, evidence scoring, the
stored mapping, and a nightly poll. ComicInfo.xml read/write is part of
this surface (a fourth provider, believed first).

```
GET  /api/identity                        → Record<seriesId, IdentityBinding>
GET  /api/identity/:seriesId              → IdentityBinding
POST /api/identity/:seriesId/confirm      { provider, registryId }
POST /api/identity/:seriesId/reject
POST /api/identity/:seriesId/files-only
GET  /api/identity/:seriesId/search?q=    → candidates with evidence rows
```

## 3. Source health — `SourceHealthApi`

Adapter behaviour: derived from the live download tasks in this session —
real rate-limit/block-page errors do produce real "cooling"/"down" rows —
but there is no history across sessions and **no stall detection**
(source quiet while the series publishes), which needs gap #2 first.

```
GET /api/sources/health → SourceHealth[]   (state, lastFetchAt, evidence)
```

The stalled state is the one that matters: it is the only "behind" with
an obvious action, and today it is invisible (docs/upstream.md).

## 4. Look elsewhere — `SurveyApi`

Adapter behaviour: returns the real current-source row plus a
representative unverified claim row; `adopt()` refuses with a pointer at
the manual source-change path (which is real: `PATCH /api/manga/:id/source`).

Server-side this is orchestration over the existing Lua modules: ask each
configured source what it holds for a series (politely, cached), order by
the registry's release records (who is publishing it now), report claims
as claims. One action, two entry points: the stalled source and the
flagged fake.

```
POST /api/series/:id/survey        → SurveyRow[]
POST /api/series/:id/adopt-source  { sourceId, url }
```

## 5. Sync rules — `RulesApi`

Adapter behaviour: one sample rule, labelled as such in its device name,
so the workbench sentence-rendering is exercised.

Blocked behind: device pairing (no phone client exists), the rule store,
and the unresolved adds-only vs rolling-window contradiction
(docs/rules.md — the design resolution is retention-as-authored-clause,
per the bound spec, but nothing is built). The web renders rules
read-only; authoring happens on devices.

## 6. Per-series freshness — `FreshnessApi`

Adapter behaviour: applies the library-wide `lastScan` stamp to every
series. Truthful today because every scan is a full pass; wrong the day
the rolling scheduler (docs/scheduler.md) lands — which is exactly when
the real route must exist, reporting per-series `lastLookedAt` and the
measured rotation period.

## 7. Content flags — `FlagsApi`

Adapter behaviour: localStorage. This browser sees its own flags; the
household does not. Server-side, a flag must outrank checksums
(docs/ui.md, Ownership), mark the chapter household-wide while keeping it
readable, quarantine the (series, source) pairing, and queue the survey.

```
GET    /api/flags
POST   /api/flags        { seriesId, chapterId, note? }
DELETE /api/flags/:seriesId/:chapterId
```

## 8. Delete / exclude — `ManageApi`

No UI ships for this on purpose. The contract records the shape so the
promise is designed before the verb exists: deletion may only ever apply
to content Paperbox itself fetched, which means the server must first
distinguish fetched from adopted (provenance already records this for
fetched chapters — 11 of 12 live series carry none, and those must be
untouchable). `decisions.md` lists "No delete endpoints" as a known gap.

## 9. Spine + cover art — `spineArtUrl` / `coverArtUrl` *(routes in flight)*

Now in the contract, being built server-side alongside this client:

```
GET /api/art/spine/:chapterUid → the sliver, 404 when not generated yet
GET /api/art/cover/:seriesUid  → the image, 404 when not generated yet
```

The client is wired (2026-08-28): a spine wears its art when the route
answers, and a 404 renders the flat series ink the shelf already draws —
no placeholder, no shimmer, per the design's own words ("a series
without extracted art stands in flat series ink; nothing announces
this"). Covers walk fetched-cover → generated cover → plain binding.
Spine 404s are remembered for 60 s client-side so a shelf of 300 spines
does not re-ask on every render; art that lands is picked up on the
next visit.

Still missing: the palette route (per-chapter dominant colour for the
foot band) — undesigned, bands render in the theme's own ink.

## 10. Lane vocabulary in the status envelope

`decisions.md`, Known gaps: "Far and near lanes share no vocabulary —
the API cannot express the distinction the UI needs." `/api/downloads`
is the far lane and `/api/sync` the near lane, but nothing in the status
envelope says so. Cosmetic until a phone client exists; structural after.

## 11. Background jobs — `JobsApi`

The background-work envelope: scanning, cover generation, spine-art
extraction.

```
GET  /api/jobs            → { jobs, running, queued }   weak ETag, 304 when unchanged
POST /api/jobs/:id/cancel → { ok: true }
```

Contract and client landed 2026-08-28; the server routes are being built
concurrently. `real.ts` polls on the ETag; the composed client
(`index.ts`) falls through to `pending.jobsFallback` **only on a 404**,
and the Activity section says so when that happens.

Fallback behaviour: derived from the real `GET /api/sync/scan` — an
active scan is the one job the server can already report. Art and cover
work is invisible from a browser until the route answers, so no rows are
invented for it. `cancel` refuses with a plain sentence: there is no
route to stop anything yet, which also means **the user-invoked scan has
no un-ask until `/api/jobs` lands** (the Stop button only appears once a
real job row exists to cancel).

Presentation follows `docs/scheduler.md` §3: background jobs are dated
sentences with no spinner and no ticking number; "stuck" is detected
client-side by tracking when each job's shape last changed across polls
(4 min without movement → amber weather, no retry lever). Percentages
and Stop belong only to the scan the user invoked.

Known hole, recorded on purpose: **there is no retry route for a failed
job.** The red treatment's one verb is "Look again" (`POST /api/scan`),
on the reading that a fresh look re-queues whatever work was missed. If
the server grows a dedicated re-run route, repoint that one verb.
