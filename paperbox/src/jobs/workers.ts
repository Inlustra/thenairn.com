/**
 * The workers -- one per job kind, and every kind of background work is one of
 * them.
 *
 * All of them are the same shape: enumerate units, run each unit through the
 * shared budget, report progress, and check for cancellation between units.
 * That was already true of art and cover; scanning joins them here rather than
 * remaining a second mechanism that happened to do the same thing. See
 * `docs/decisions.md`, "One queue, several job kinds".
 *
 * None of them writes anything into the user's library. `height` persists a
 * derived number into `paperbox.json`, which the scanner already owns and
 * already writes -- which is exactly why it hands it back to the scanner
 * instead of writing it itself.
 */
import {
  getManga,
  getMangaByUid,
  getMangaList,
  getChapterPagePaths,
  getMangaDir,
  recordPixelHeights,
  scan,
  type MeasuredHeight,
} from "../scanner";
import { ensureSpine, ensureCover } from "../art";
import { chapterPixelHeight } from "../pixelheight";
import type { JobContext } from "./runner";
import type { JobQueue } from "./queue";
import type { MangaDetail } from "../types";
import { basename, join } from "path";

/**
 * Run units through the budget with real concurrency.
 *
 * Calling `budget.run` in a serial loop would hold the concurrency at 1 no
 * matter what the cap says -- the cap is a ceiling, not a floor, and something
 * has to actually issue the parallel work. The pool is bounded by the budget's
 * own concurrency so there is exactly one number in play.
 */
async function pool<T>(
  items: T[],
  ctx: JobContext,
  fn: (item: T) => Promise<void>,
): Promise<number> {
  let next = 0;
  let done = 0;
  const width = Math.min(ctx.budget.concurrency, Math.max(1, items.length));
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      if (ctx.cancelled()) return;
      const i = next++;
      const item = items[i];
      if (item === undefined) return;
      await ctx.budget.run(() => fn(item), { foreground: ctx.foreground });
      ctx.progress(++done);
    }
  });
  await Promise.all(workers);
  return done;
}

function seriesFor(scope: string | null): MangaDetail[] {
  if (scope === null) {
    return getMangaList()
      .map((m) => getManga(m.id))
      .filter((m): m is MangaDetail => m !== undefined);
  }
  const one = getMangaByUid(scope);
  return one ? [one] : [];
}

/**
 * Spine art plus dominant colour, one chapter at a time.
 *
 * `ensureSpine` is a no-op when the store already holds the key, so re-running
 * a series after one chapter changed costs one extraction and N cheap `stat`s
 * rather than N extractions. That is the property the content-addressed key
 * buys, and it is why this worker has no "what changed" logic of its own.
 */
/**
 * A scope that does not resolve right now is not a scope that will never
 * resolve.
 *
 * The queue is persistent and jobs outlive the process, so one can be claimed
 * in a window where the library cache has not yet been rebuilt -- after a
 * restart, or across a rescan. Throwing marked the job permanently failed and
 * put a red line in front of the user for a series that was sitting on disk the
 * whole time, with its uid unchanged.
 *
 * Skipping is safe because discovery is idempotent and runs after every scan:
 * if the series is really there, the work comes back on the next pass. If it is
 * really gone, discovery never queues it again, so this cannot spin.
 */
function unresolved(ctx: JobContext): boolean {
  if (ctx.job.scope) console.log(`[jobs] ${ctx.job.kind} skipped: ${ctx.job.scope} not in the library cache yet`);
  return true;
}

export async function artWorker(ctx: JobContext): Promise<void> {
  const series = seriesFor(ctx.job.scope);
  if (series.length === 0 && unresolved(ctx)) return;

  const units: { uid: string; fingerprint?: string; manga: MangaDetail; chapterId: string }[] = [];
  for (const m of series) {
    for (const c of m.chapters) {
      units.push({ uid: c.uid, fingerprint: c.fingerprint, manga: m, chapterId: c.id });
    }
  }
  ctx.progress(0, units.length);

  await pool(units, ctx, async (u) => {
    const chapter = u.manga.chapters.find((c) => c.id === u.chapterId);
    if (!chapter) return;
    const pages = await getChapterPagePaths(u.manga, chapter);
    if (pages.length === 0) return;
    await ensureSpine(u.uid, u.fingerprint, pages);
  });
}

/**
 * Series covers, adopted from whatever is already on disk.
 *
 * Nothing is fetched from a source here and nothing is deleted. See
 * `src/art/cover.ts` for both reasons.
 */
export async function coverWorker(ctx: JobContext): Promise<void> {
  const series = seriesFor(ctx.job.scope);
  if (series.length === 0 && unresolved(ctx)) return;
  ctx.progress(0, series.length);

  await pool(series, ctx, async (m) => {
    await ensureCover(
      m.uid,
      join(getMangaDir(), m.dir),
      m.series.cover,
      m.chapters.map((c) => c.dir),
    );
  });
}

/**
 * A scan. Every scan -- first run, the one a user asked for, and each step of
 * the rolling rotation.
 *
 * The two behave differently in exactly one respect, and it is `ctx.foreground`
 * rather than a second code path. `docs/scheduler.md`: a user-invoked scan is a
 * **foreground errand** -- full concurrency, no duty cap, a percentage on
 * screen -- "because the user asked for it and is watching". A rotation step is
 * submitted `silent`, so the runner hands it `foreground: false` and the same
 * `budget.run` call that lets the first one past the duty cap holds the second
 * one to it. That is precisely what the rotation used to do for itself.
 *
 * Progress is republished from the scanner's own `ScanProgress` rather than
 * counted here, so the number on the job and the number on `/api/status`
 * cannot disagree. On a silent job nothing reads it, and writing it anyway
 * costs one UPDATE per 250 ms and keeps the worker one thing rather than two.
 */
export function makeScanWorker(getProgress: () => { seriesDone: number; seriesTotal: number }) {
  return async function scanWorker(ctx: JobContext): Promise<void> {
    const scoped = ctx.job.scope ? getMangaByUid(ctx.job.scope) : undefined;
    // A scoped job whose series has since disappeared must not silently widen
    // into a full-library scan, which is what an ignored scope would do.
    if (ctx.job.scope && !scoped && unresolved(ctx)) return;
    const running = ctx.budget.run(() => scan(scoped ? { series: scoped.dir } : {}), {
      foreground: ctx.foreground,
    });
    const tick = setInterval(() => {
      const p = getProgress();
      ctx.progress(p.seriesDone, p.seriesTotal || null);
    }, 250);
    try {
      await running;
    } finally {
      clearInterval(tick);
    }
    const p = getProgress();
    ctx.progress(p.seriesTotal, p.seriesTotal || null);
  };
}

/**
 * Reading length in pixels, one chapter at a time.
 *
 * This was inline in the scan until 2026-08-29, on the fingerprint's trigger.
 * It reads an image header per page: cheap per page, and 24M of them at the
 * R-12 target -- around 18 hours, on the critical path of a pass costed at
 * 865 s precisely because it never opens a file. It is a job for the same
 * reason spine art is one.
 *
 * Only chapters with no height are measured. `chapterPixelHeight` returns 0 for
 * a chapter it could not read, and 0 is stored, because "we looked and got
 * nothing" is an answer -- an absent value would be re-measured on every scan
 * forever, which is the shape of bug this refactor exists to stop repeating.
 */
export async function heightWorker(ctx: JobContext): Promise<void> {
  const series = seriesFor(ctx.job.scope);
  if (series.length === 0 && unresolved(ctx)) return;

  const units: { manga: MangaDetail; dir: string; fingerprint: string | undefined }[] = [];
  for (const m of series) {
    for (const c of m.chapters) {
      if (c.pixelHeight !== undefined) continue;
      units.push({ manga: m, dir: c.dir, fingerprint: c.fingerprint });
    }
  }
  ctx.progress(0, units.length);
  if (units.length === 0) return;

  const measured = new Map<string, MeasuredHeight[]>();
  try {
    // Deliberately *not* through `pool`. `chapterPixelHeight` already reads a
    // chapter's headers eight at a time, for the reason recorded in
    // `pixelheight.ts` -- the cost is the FUSE round trip, not the header. Wrap
    // that in a pool of eight and the mount sees 64 in flight, which is twice
    // R-01's plateau and takes the whole FUSE queue from whoever is reading. So
    // the unit is one chapter, run one at a time, with the concurrency inside
    // it. The budget's cap and the module's are the same number on purpose.
    let done = 0;
    for (const u of units) {
      if (ctx.cancelled()) break;
      const chapter = u.manga.chapters.find((c) => c.dir === u.dir);
      if (!chapter) continue;
      const paths = await getChapterPagePaths(u.manga, chapter);
      if (paths.length === 0) continue;
      const dir = join(getMangaDir(), u.manga.dir, chapter.dir);
      const pixelHeight = await ctx.budget.run(
        () => chapterPixelHeight(dir, paths.map((p) => basename(p))),
        { foreground: ctx.foreground },
      );
      const entry = { dir: u.dir, fingerprint: u.fingerprint, pixelHeight };
      const list = measured.get(u.manga.uid);
      if (list) list.push(entry);
      else measured.set(u.manga.uid, [entry]);
      ctx.progress(++done);
    }
  } finally {
    // In `finally`, so a cancelled job keeps what it already measured. Throwing
    // away completed work because the *rest* was stopped is how a cancel turns
    // into an hour of re-reading headers next time round.
    for (const [uid, heights] of measured) await recordPixelHeights(uid, heights);
  }
}

/** Queue art and cover work for one series. Used after a download commits. */
export function enqueueSeriesArt(queue: JobQueue, uid: string, title: string): void {
  queue.enqueue({ kind: "cover", scope: uid, label: title });
  queue.enqueue({ kind: "art", scope: uid, label: title });
}
