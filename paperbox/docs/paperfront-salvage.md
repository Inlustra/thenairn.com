# Paperfront salvage notes

Archaeology on `RainnWorks/paperfront`, for the rewrite landing in this repo.

**Weight this properly.** 48 commits across three days (2026-03-12 → 03-14), 35 by Claude,
and nothing shows it ever ran on a device. So "did not work" means *found wrong during the
build* or *wrong on reading the code*, never *failed in production*. Where I infer, I say so.

---

## The three things worth knowing

### 1. The reader never opened a downloaded file

`pagePath()` (`src/utils/filePaths.ts:45`) has one non-test caller,
`src/services/downloadManager.ts:192`. The reader
(`app/(tabs)/collection/reader/[mangaId]/[chapterId].tsx:204-215`) always calls
`source.getChapterPages()` and renders remote Suwayomi URLs — the whole download → WebP →
SQLite pipeline produced files nothing ever read. `readerStore.ts:30` even declares
`pages: string[]; // Local file paths…`, describing an intent the code never had.

The lesson is sequencing: build the **read path off local storage first**, and let the
network be the fallback that fills it. Here download and display never met.

### 2. Page height was unknown at layout time, so everything downstream was a guess

The reader's real unsolved problem, and the one that matters most at 46,564 px.
`ReaderPage` (reader:70-98) mounts each image at `useState(SCREEN_HEIGHT)` and corrects to the
true aspect ratio in `onLoad`; there is **no `getItemLayout`** on the `FlatList`
(reader:565-585). Consequences, all in the code:

- Content height shifts under the user as images resolve. Restoring a saved position needs
  `setTimeout(…, 100)` before `scrollToIndex` (reader:241-247) *and* an
  `onScrollToIndexFailed` retrying 200 ms later (reader:576-583) — two timing hacks on one
  missing measurement.
- Current page is `Math.floor((scrollY / totalHeight) * totalPages)` (reader:406) — a
  **proportional guess**, correct only if all pages are equal height. With one 46,564 px page
  beside a 1,500 px page it is wildly wrong, and it feeds the progress bar, page counter,
  chapter-boundary haptic *and* the persisted resume position (reader:345-374). A wrong
  resume position is the user-visible failure.
- `keyExtractor` and `recyclingKey` are both `page-${index}` (reader:87, 568), so prepending
  a previous chapter shifts every index and remounts every image.
- `contentFit="cover"` (reader:86) crops if the height is off by a pixel; `NOTES.md` claims
  `contentFit="contain"`.

**Carry the requirement, not the code:** get real page dimensions before layout. Paperbox is
the server — have it emit width/height per page, so the client lays out exactly with a real
`getItemLayout`. That deletes the guess, both timers and the crop risk at once. Then decide
what a 46,564 px page *is* to the list: one item no virtualiser can window (`windowSize={5}`
is five viewports; that page is ~57), or N pre-sliced tiles.

### 3. Download commit was not atomic, and `exists()` was the resume check

`downloadManager.ts:198` skips a page when `fs.exists(path)`; `:218` writes straight to the
final path. A kill mid-write leaves a truncated file the resume logic counts as done — a
permanently corrupt page that never self-heals.

This lands on the seam `client/ports.ts:96` hands you (*"Written whole; the caller decides
how to make that atomic"*) and `client-sync.md:183` on `ContentStore.commit` being *"a real
rename"*. Stage to a temp name, fsync, rename; treat presence as evidence only after that.

Two more faults in that file:

- **Cancel does not cancel.** An `AbortController` is created (`:166`) but its signal never
  reaches `http.fetchBytes(url)` (`:206`); polled only between pages, so an in-flight page
  always completes.
- **Re-entrancy.** `downloadChapter`'s `finally` sets `processing = false` and calls
  `processQueue()` (`:260-261`) while the outer loop still awaits `Promise.allSettled`, so
  every finishing chapter re-enters and clears the guard: the concurrency limit is escapable.
  Concurrency is explicitly the app's job (`client-sync.md:178`).

---

## Ground `client/` has taken — do not re-solve

- **Read progress** — `engine.ts:179 markRead()`, furthest-wins. Supersedes
  `progressTracker.ts` and the `reading_progress` / `chapter_read_history` tables; the server
  tracks no read state at all (`docs/decisions.md:327`).
- **Retention** — `rules.ts:159 evaluate()`, over `autoDownloadManager.ts`'s sliding window.
- **Planning and ordering** — `plan.ts:35 buildPlan()`, over `downloadManager.processQueue`.

One lesson survives as a **test case**, not code: `b3b2df1` fixed the auto-download anchor
from *earliest read chapter* to *end of the contiguous read run* — a user who had read 1–50
was served downloads of 1–5. Check that a long read history and one stray out-of-order read
both produce the right window.

---

## Worth carrying

**Throttle, never debounce, on a webtoon scroll.** Commit `8297bdf`, and
`usePageColorScanner.ts:11-16`: *"During continuous scrolling through long battle spreads,
debounce never fires because the user never 'settles.'"* The fix: throttle at 800 ms plus a
trailing call 300 ms after motion stops. This generalises to every scroll-triggered job —
prefetch, progress save, telemetry. On a page tens of thousands of pixels tall, "the user
stopped scrolling" is not an event you get.

**Scroll-hot state in refs, flushed on events.** Instructive because it was wrong twice.
`658e0eb` moved `currentPage`/`scrollPosition` out of Zustand into refs (two `set()` calls
and a full re-render per frame) but batched them back with a **250 ms `setInterval`**.
`777f764`, the same day, deleted it — *"4 re-renders/sec during smooth scrolling"* — and
flushed only on meaningful events: chapter boundary, overlay toggle, `AppState` background.
Take the destination, skip the interval. Also keep: `AppState` background/inactive as the
durable-save trigger (reader:380-388), binary search for the chapter owning a page
(reader:113-136), and `InteractionManager.runAfterInteractions` to defer list rebuilds off
the scroll thread (`readerStore.ts:170`).

**Two platform details.** `expo-glass-effect` breaks when any ancestor has `opacity: 0`, so
overlay show/hide must animate `scale` and toggle `display`, never opacity (reader:466-474).
And `e0536fe` swapped `react-native-webp-converter` for `expo-image-manipulator` and
`expo-background-fetch`/`expo-task-manager` for `expo-background-task` — the third-party
choices aged out inside one SDK cycle.

**WebP** was chosen for storage size at quality 80 (`global_settings.webp_quality`), exposed
via a `QualitySlider`; the magic-byte sniffing in `imageConverter.ts:11-44` is reusable.

---

## Do not carry

**The WebP pipeline as built.** `nativeImageConverter.ts:12-47`: bytes into the JS heap →
temp file → `renderAsync()` (full uncompressed bitmap) → `saveAsync()` → result read *back*
into the JS heap → `fs.writeFile`. Two heap copies plus a decoded bitmap per page; for a
46,564 px page that bitmap is hundreds of MB, and CoreGraphics has ceilings far below it.
*Inference — nothing shows this being hit; the download path was seemingly never run against
pages that tall.* Convert server-side in paperbox, or stream file→file without touching the
JS heap. Never round-trip images through `Uint8Array`.

**SQLite as written.** No `PRAGMA journal_mode=WAL` despite `NOTES.md` claiming WAL. No
`user_version`, no migrations — just `CREATE TABLE IF NOT EXISTS` (`sqliteDatabase.ts:27-98`),
so the first schema change to a shipped build has no path. `source_instances` stores
`password` in plaintext (`:83`) while `expo-secure-store` is used only for onboarding and
colour state. And it is written to per *page*: `upsertDownloadTask` fires on every page
(`:200`, `:222`) while `processQueue` re-reads the whole task table in a `while (true)` loop
(`:138`). Download progress is UI state — persist it on chapter transitions.

**The stitching feature.** `stitchedPages`, `chapterBoundaries`, `stitchedOffset`
(`readerStore.ts:39-42`) are dead — nothing calls `setNextChapterPages` or
`setPrevChapterPages`, so `displayPages` always falls back to the single-chapter array,
`stitchedOffset` is always 0, and the "seamless continuous scroll with haptic chapter
transitions" of `327d714` never engaged. There is also **no prefetch anywhere**.
Continuous scroll is a good idea; this is a wired-up store with no producer.

**Background downloads.** `expo-background-task` is a dependency, `NOTES.md` documents it at
length and `app.json` carries the iOS `BGTaskScheduler` entitlements — but nothing calls
`registerTaskAsync` or `defineTask`. Never wired. Scheduling is yours
(`client-sync.md:181`); budget it as unbuilt work, not a port.

**`NOTES.md` as truth.** A well-written rationale document describing things the code does
not do: WAL, `contentFit="contain"`, background downloads, reading local files. Read the code.
