/**
 * The discovery pass: what derived work is missing, and queueing it.
 *
 * -------------------------------------------------------------------------
 * Why this is one function and not three backfills
 * -------------------------------------------------------------------------
 * The same bug shipped twice. Spine art was derived from the scheduler's
 * `onChange`, which fires when a series *moves* -- so a library that already
 * existed derived nothing, and 12 series with 1,706 chapters produced not one
 * spine until an eager `backfillArt()` was bolted on beside it. Pixel height
 * had the identical hole and never got a backfill at all; it was smuggled onto
 * the fingerprint's trigger instead, which is why it sat on the scan's critical
 * path.
 *
 * Both are the same mistake: **something derived on a change trigger, with no
 * path for content that already exists.** The fix is not a third backfill. It
 * is that discovery belongs to the scan, which is the one thing that looks at
 * everything, and every scan runs it -- startup, user-invoked, and each step of
 * the rolling rotation. A new artefact kind gets correct behaviour by being
 * added to the list below, rather than by remembering to write its own
 * catch-up pass.
 *
 * -------------------------------------------------------------------------
 * Discovery is eager; extraction is paced. They are not the same cost
 * -------------------------------------------------------------------------
 * Leaving discovery to the rotation was the original mistake and it is worth
 * naming: `intervalMs` is `deadline / seriesCount`, so a twelve-series library
 * takes the full six-hour floor deadline merely to *notice* it has no spines.
 * That paces discovery at extraction's price, and the two are nothing alike --
 * one `stat` per chapter against ~740 ms to cut a spine (R-22). So this runs in
 * full, at once, and the queue and the duty budget pace the expensive half.
 *
 * The honest cost, stated rather than assumed: one `stat` per chapter for art
 * (~1,706 on the real library, 710,000 at the R-12 target -- 41 s at R-01's
 * measured plateau) and one `readdir`/`stat` pair per series for the cover.
 * Pixel height costs nothing: the scan is already holding the answer. Note that
 * a full-library discovery pass only happens on a full-library scan; the
 * rotation scans one series and so discovers one series, ~142 stats, ~8 ms.
 *
 * -------------------------------------------------------------------------
 * It has to settle, or it is not discovery, it is a loop
 * -------------------------------------------------------------------------
 * Every check below answers "is the artefact there?" against the derived store
 * or against the scan's own facts, never "did we try recently?", so a library
 * whose artwork is complete queues nothing on every scan for ever. The two ways
 * that could have failed are handled explicitly: a chapter with no pages has
 * nothing to derive and is skipped from the scan's own page count, and a
 * chapter whose pages cannot be decoded gets a recorded `miss` so its absence
 * is an answer rather than a permanent question (see `art/store.ts`).
 */
import { getMangaList, getMangaByUid, getMangaDir } from "../scanner";
import { has, spineKey, coverKey, resolveCoverSource } from "../art";
import { join } from "path";
import type { JobQueue } from "./queue";

export interface Discovered {
  art: number;
  cover: number;
  height: number;
}

/**
 * Queue whatever derived work is missing.
 *
 * `scope` is the series *directory* the scan covered, or null for the whole
 * library -- it is what the scanner knows at that point, and it is deliberately
 * matched on `dir` rather than re-slugified, for the reason `runScan` gives
 * where it carries series over.
 */
export async function discover(queue: JobQueue, scope: string | null): Promise<Discovered> {
  const found: Discovered = { art: 0, cover: 0, height: 0 };
  const series = getMangaList().filter((m) => scope === null || m.dir === scope);

  for (const m of series) {
    const detail = getMangaByUid(m.uid);
    if (!detail) continue;

    try {
      if (await needsCover(detail.uid, join(getMangaDir(), detail.dir), detail.series.cover, detail.chapters.map((c) => c.dir))) {
        queue.enqueue({ kind: "cover", scope: detail.uid, label: detail.title });
        found.cover++;
      }
    } catch {
      // An unreadable series is the scan's problem to report, not this pass's
      // to fail on: the other series still have work that wants queueing.
    }

    try {
      if (await needsArt(detail.uid)) {
        queue.enqueue({ kind: "art", scope: detail.uid, label: detail.title });
        found.art++;
      }
    } catch {}

    if (detail.chapters.some((c) => c.pixelHeight === undefined && c.pageCount > 0)) {
      queue.enqueue({ kind: "height", scope: detail.uid, label: detail.title });
      found.height++;
    }
  }
  return found;
}

/**
 * Has every chapter of this series had its spine settled?
 *
 * Every chapter, not the first and last. The two-stat version this replaces was
 * chosen when it ran on a rotation that visited a series every thirty minutes,
 * and it was wrong in a way that mattered: a chapter changing in the *middle*
 * of a series moves only its own key, so the ends still answer "derived" and
 * the new artwork was never cut. That hole was covered by the scheduler's
 * `onChange` firing separately, which is exactly the second mechanism this
 * refactor removes -- so the check has to be complete instead.
 *
 * It returns on the first gap, so the expensive answer is the happy one: a
 * series whose artwork is complete costs one stat per chapter, and a series
 * missing everything costs one.
 */
async function needsArt(uid: string): Promise<boolean> {
  const manga = getMangaByUid(uid);
  if (!manga) return false;
  for (const c of manga.chapters) {
    // No pages, no artwork, and nothing to keep asking about.
    if (c.pageCount === 0) continue;
    const key = spineKey(c.uid, c.fingerprint);
    if (await has("spine", key)) continue;
    // A recorded failure is an answer. Without it, one undecodable chapter
    // queues this series' art job again after every scan, for ever.
    if (await has("miss", key)) continue;
    return true;
  }
  return false;
}

/** Is the cover this series would adopt already in the store? */
async function needsCover(
  uid: string,
  seriesPath: string,
  sidecarCover: string | undefined,
  chapterDirs: string[],
): Promise<boolean> {
  const source = await resolveCoverSource(seriesPath, sidecarCover, chapterDirs);
  // Nothing on disk to adopt. Queueing a cover job would be asking for work
  // that has already been decided against, once per scan, for ever.
  if (!source) return false;
  return !(await has("cover", coverKey(uid, source.sig)));
}
