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
import { derivedDir } from "../art";
import { getScanProgress, getMangaList } from "../scanner";
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
export function enqueueNow(opts: Parameters<JobQueue["enqueue"]>[0]) {
  const q = queue;
  if (!q) return null;
  const job = q.enqueue(opts);
  runner?.wake();
  return job;
}
