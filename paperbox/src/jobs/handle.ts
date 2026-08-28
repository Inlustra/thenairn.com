/**
 * The process-wide background pipeline.
 *
 * Separate from index.ts for the same reason `src/readstate/handle.ts` is:
 * modules that need the handle (the routes, the download path) can import it
 * without pulling in everything the barrel re-exports.
 */
import { join } from "path";
import { JobQueue } from "./queue";
import { Budget } from "./budget";
import { JobRunner } from "./runner";
import { ScanScheduler } from "./scheduler";
import { artWorker, coverWorker, makeScanWorker } from "./workers";
import { derivedDir, spineKey, has as hasArt } from "../art";
import { getScanProgress, getMangaList, getMangaByUid } from "../scanner";
import { getReadState } from "../readstate";

let queue: JobQueue | null = null;
let budget: Budget | null = null;
let runner: JobRunner | null = null;
let scheduler: ScanScheduler | null = null;

export function getJobs(): JobQueue | null {
  return queue;
}

export function getBudget(): Budget | null {
  return budget;
}

export function getScheduler(): ScanScheduler | null {
  return scheduler;
}

/** Tests supply their own. Returns the previous handle. */
export function configureJobs(next: JobQueue | null): JobQueue | null {
  const prev = queue;
  queue = next;
  return prev;
}

/**
 * Where the queue lives.
 *
 * Defaulted, unlike `READSTATE_DB`, and the contrast is the point: every row
 * here describes regenerable work over regenerable artefacts, so losing the
 * file costs a re-derivation and never a fact. It lives *inside* the derived
 * store so that `rm -rf $DERIVED_DIR` takes the bookkeeping with the artefacts
 * and the two cannot end up disagreeing about what exists.
 */
export function jobsDbPath(): string {
  return process.env.JOBS_DB || join(derivedDir(), "jobs.db");
}

export interface StartOptions {
  /** Skip the rolling background scan. Set in tests and one-shot runs. */
  scheduler?: boolean;
}


/**
 * Audit every series for missing artwork, once, and queue what is absent.
 *
 * The rotation was doing this discovery, and that was wrong: `intervalMs` is
 * `deadline / seriesCount`, so on a twelve-series library the rotation visits
 * one series every thirty minutes and takes the full six-hour deadline just to
 * NOTICE that twelve series have no spines. That paces discovery at
 * extraction's cost, and the two are nothing alike -- `needsArt` is two stats
 * per series (24 for this library, ~10k and under a second at the R-12 target),
 * while cutting a spine is ~740 ms per chapter.
 *
 * So discovery runs eagerly and in full; the queue and the duty budget still
 * pace the extraction, which is the part that is actually expensive. Once a
 * series has its artwork this settles to two stats and no enqueue.
 */
export async function backfillArt(): Promise<number> {
  const q = queue;
  if (!q) return 0;
  let queued = 0;
  for (const m of getMangaList()) {
    const uid = m.uid;
    if (!uid) continue;
    try {
      if (!(await needsArt(uid))) continue;
    } catch {
      continue; // an unreadable series is the scan's problem, not the art pass's
    }
    q.enqueue({ kind: "cover", scope: uid, label: m.title });
    q.enqueue({ kind: "art", scope: uid, label: m.title });
    queued++;
  }
  if (queued > 0) {
    console.log(`[jobs] artwork missing for ${queued} series; queued`);
    runner?.wake();
  }
  return queued;
}

export function startJobs(opts: StartOptions = {}): JobQueue | null {
  try {
    queue = new JobQueue(jobsDbPath());
  } catch (e) {
    console.error(`[jobs] could not open ${jobsDbPath()}; background work is disabled for this run`, e);
    queue = null;
    return null;
  }
  const recovered = queue.recover();
  if (recovered > 0) console.log(`[jobs] ${recovered} interrupted job(s) returned to the queue`);

  budget = new Budget();
  runner = new JobRunner(queue, budget, {
    art: artWorker,
    cover: coverWorker,
    scan: makeScanWorker(getScanProgress),
  });
  runner.start();

  if (opts.scheduler !== false) {
    scheduler = new ScanScheduler(budget, {
      // A series whose content moved gets its artwork refreshed. The store is
      // content-addressed, so this costs one extraction per changed chapter and
      // a stat per unchanged one -- there is no "what changed" bookkeeping to
      // get wrong.
      onChange: (uid, title) => {
        queue?.enqueue({ kind: "cover", scope: uid, label: title });
        queue?.enqueue({ kind: "art", scope: uid, label: title });
        runner?.wake();
      },
      // A visit still backstops the eager pass -- a series whose artwork was
      // deleted, or whose extraction failed, is picked up next time round
      // without waiting for its content to change. The eager `backfillArt()` is
      // what makes a cold library derive in minutes rather than in a deadline.
      onVisit: async (uid, title, _lane, changed) => {
        if (changed) return; // onChange already queued it
        if (!(await needsArt(uid))) return;
        queue?.enqueue({ kind: "cover", scope: uid, label: title });
        queue?.enqueue({ kind: "art", scope: uid, label: title });
        runner?.wake();
      },
      readRecency: (uid) => {
        const store = getReadState();
        if (!store) return null;
        try {
          return store.lastReadAt?.(uid) ?? null;
        } catch {
          return null;
        }
      },
    });
    scheduler.start();
    console.log(
      `[jobs] rolling scan started over ${getMangaList().length} series, floor deadline ${(scheduler.floorDeadlineMs / 3600000).toFixed(1)} h`,
    );
  }

  console.log(`[jobs] queue at ${jobsDbPath()}, derived store at ${derivedDir()}`);
  return queue;
}

export async function stopJobs(): Promise<void> {
  await scheduler?.stop();
  await runner?.stop();
  scheduler = null;
  runner = null;
}

/** Enqueue and wake in one call, so an API request does not wait for a poll. */

/**
 * Has this series had its artwork derived yet?
 *
 * Checks the first and last chapter rather than all of them: one `stat` per
 * series on a rotation that already costs a scan, against 313 for a full audit.
 * First catches "never derived at all"; last catches a run that died part way
 * through. Chapters appended since are covered by the change signature instead,
 * which is what `onChange` is for.
 */
async function needsArt(uid: string): Promise<boolean> {
  const manga = getMangaByUid(uid);
  if (!manga || manga.chapters.length === 0) return false;
  const ends = [manga.chapters[0]!, manga.chapters[manga.chapters.length - 1]!];
  for (const c of ends) {
    if (!(await hasArt("spine", spineKey(c.uid, c.fingerprint)))) return true;
  }
  return false;
}

export function enqueueNow(opts: Parameters<JobQueue["enqueue"]>[0]) {
  const q = queue;
  if (!q) return null;
  const job = q.enqueue(opts);
  runner?.wake();
  return job;
}
