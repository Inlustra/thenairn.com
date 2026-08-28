/**
 * The three workers.
 *
 * All of them are the same shape: enumerate units, run each unit through the
 * shared budget, report progress, and check for cancellation between units.
 * None of them writes anything into the library.
 */
import { getManga, getMangaByUid, getMangaList, getChapterPagePaths, getMangaDir, scan } from "../scanner";
import { ensureSpine, ensureCover } from "../art";
import type { JobContext } from "./runner";
import type { JobQueue } from "./queue";
import type { MangaDetail } from "../types";
import { join } from "path";

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
export async function artWorker(ctx: JobContext): Promise<void> {
  const series = seriesFor(ctx.job.scope);
  if (series.length === 0) throw new Error(`no series for scope ${ctx.job.scope ?? "(library)"}`);

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
  if (series.length === 0) throw new Error(`no series for scope ${ctx.job.scope ?? "(library)"}`);
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
 * A scan the user asked for.
 *
 * `docs/scheduler.md`: first run, and any user-invoked "scan my library", is a
 * **foreground errand** -- full concurrency, no duty cap, a percentage on
 * screen -- "because the user asked for it and is watching". The background
 * rolling scan is a different thing entirely and is not a job at all; see
 * `scheduler.ts`.
 *
 * Progress is republished from the scanner's own `ScanProgress` rather than
 * counted here, so the number on the job and the number on `/api/status`
 * cannot disagree.
 */
export function makeScanWorker(getProgress: () => { seriesDone: number; seriesTotal: number }) {
  return async function scanWorker(ctx: JobContext): Promise<void> {
    const scoped = ctx.job.scope ? getMangaByUid(ctx.job.scope) : undefined;
    const running = scan(scoped ? { series: scoped.dir } : {});
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

/** Queue art and cover work for one series. Used after a download commits. */
export function enqueueSeriesArt(queue: JobQueue, uid: string, title: string): void {
  queue.enqueue({ kind: "cover", scope: uid, label: title });
  queue.enqueue({ kind: "art", scope: uid, label: title });
}
