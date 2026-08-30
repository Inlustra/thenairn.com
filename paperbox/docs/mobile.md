# The mobile app

Written 2026-08-30, before any app code exists. This is the brief the Mac starts
from.

## What is decided

**A complete rewrite.** `RainnWorks/paperfront` — a React Native/Expo reader
written in three days in March 2026 — is not a starting point. It is mined for
specific lessons and otherwise ignored. See [paperfront-salvage.md](paperfront-salvage.md);
the short version is that its download pipeline produced files the reader never
opened, so most of it was never true in the first place.

**It lives here.** The app is a package in this repo, not a separate one. The
server, the web client, the sync engine and the app share a design language, a
wire contract and a decision record, and splitting them was how the last attempt
drifted.

**It is built on the Mac.** Xcode, device builds and signing are Mac-only, and
this is a phone app — it needs to be on a real iPhone early and often. Signing
material is `RainnWorks/ios-certificates` (fastlane match).

## The stack, and the one non-obvious call

**A dev build, not Expo Go.** Both features that make this app worth having —
background downloading and a Live Activity — need native code that Expo Go
cannot load. Reaching for Expo Go first and migrating later is the standard
mistake here; the migration always costs more than starting bare. Use Expo with
prebuild and a custom dev client from the first commit.

Otherwise: TypeScript throughout, sharing the sync engine directly.

## The architecture

The hard part is already written and tested. `client/` is a **platform-agnostic
sync engine** — pure TypeScript, no DOM, no React Native, no Node. Everything
platform-specific is injected:

| Port | The app must supply |
|---|---|
| `SyncTransport` | `tree()`, `diff()`, `image(url)` |
| `ContentStore` | staging, commit, held chapters, capacity |
| `StateStore` | one durable string |
| `Clock` | `now()`, `sleep()` |
| `DeviceConditions` | `unmetered()`, `charging()` |

`client/memory.ts` implements all five in memory, `client/sim/` fakes a server,
a network and a full disk deterministically, and `client/demo.ts` prints a phone
losing signal mid-sync and recovering. **Run the demo before writing any app
code** — it is the fastest way to understand what the app is responsible for.

What the engine deliberately leaves to the app: fetch concurrency, scheduling,
real atomicity behind `commit`, the adds-only-versus-rolling policy choice, and
all presentation.

## The problem to solve first

**`SyncTransport.image(url)` returns a promise, and iOS background downloads do
not work that way.**

The engine's transport assumes the app drives a fetch and awaits bytes. A
background `URLSession` inverts it: the system performs the transfer while the
app is suspended or terminated, and reports afterwards. An app built against the
promise seam and then retrofitted for background transfer is a rewrite, so this
is settled before anything else is built.

The seam is closer to right than it first looks. `ContentStore` already exposes
`putStaged`, `listStaged` and `stagedChapters`, and staging is durable and
**discoverable** — so a native background transfer can write into staging while
no JavaScript is running, and the engine reconciles from what it finds at next
launch. Staged pages are never presented as held (`commit` is the only thing
that makes a chapter held), so a half-arrived chapter is already modelled.

What must be proven, on a device, before the app has any screens:

1. A background transfer completes while the app is force-quit.
2. Its bytes land somewhere `ContentStore` can find.
3. On relaunch the engine reconciles and does **not** re-fetch what arrived.
4. A transfer interrupted mid-page leaves no page that `commit` would accept.

Point 4 is where paperfront failed: it used file existence as the resume check,
so a truncated page counted as complete forever. Atomicity behind `commit` is
the app's job and the engine cannot check it.

Likely tool: `react-native-background-downloader`, which wraps background
`URLSession`. Verify it is still maintained and works with the current Expo
version before committing to it — it is the load-bearing dependency of the whole
design.

## Live Activity

Worth building, and worth building **second**. ActivityKit, iOS 16.1+, a Swift
Widget Extension plus an Expo config plugin.

The detail that catches people: updating a Live Activity while the app is
suspended needs an ActivityKit push token and a push through APNs, which means
the server has to reach the phone. Updating from the foreground is trivial;
updating from the background is infrastructure. Decide which you want before
designing the surface, and note that a download running in the background is
exactly the case where the app is not in the foreground.

Whatever it shows must obey the state language in [ui.md](ui.md) — a download is
the **near lane**, so it earns real numbers, unlike anything the server does on
its own behalf.

## Build order

Riskiest first. Each step is chosen because failing it invalidates the next.

1. **Bare Expo app on a real device.** No features. Proves the toolchain,
   signing and the dev-client loop.
2. **The background-download spike** above. One hardcoded chapter, no UI worth
   the name. This is the decision point for the whole architecture.
3. **The engine wired to real adapters** — real filesystem, real network, real
   SQLite or MMKV behind `StateStore`. The simulator's scenario tests are the
   specification; the same behaviours must hold against real ports.
4. **The reader.** Rewritten. Per-page dimensions come from the server (see
   below) so nothing is ever guessed.
5. **The library and shelf**, sharing the web client's design.
6. **Live Activity.**
7. **Pairing and identity.** Deliberately last: there is no auth anywhere yet,
   and `decisions.md` records why read state and rules are client-side. Do not
   invent an accounts system to get an app running.

## From paperfront, and only these

Full reasoning in [paperfront-salvage.md](paperfront-salvage.md).

- **Throttle, never debounce, on webtoon scroll.** A debounce never fires,
  because the reader never settles.
- **Scroll-hot state lives in refs, flushed on events rather than on a timer.**
  That was got wrong twice in one day there.
- **`AppState` background is the durable-save trigger.**

Everything else — the download pipeline, the storage model, the progress
tracking, the reader's architecture — is superseded by `client/` or was never
sound.

## What the server owes the app

- **Per-page dimensions.** The reader must never guess a page's height:
  paperfront derived the current page from a scroll proportion, and that number
  fed the progress bar, the boundary haptic and the persisted resume position.
  With pages up to 46,564 px tall that is wildly wrong. The scan already reads
  every page header to compute per-chapter pixel height, so per-page is nearly
  free. **Not built yet.**
- Everything else the app needs exists: `/api/sync/tree`, `/api/sync/diff`,
  `/api/images/*`, `/api/art/spine/*`, `/api/jobs`, identity search and binding.
  Wire gaps are recorded in [api-gaps.md](api-gaps.md).
