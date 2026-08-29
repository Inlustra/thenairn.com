/**
 * The process-wide background pipeline.
 *
 * Separate from index.ts for the same reason `src/readstate/handle.ts` was:
 * modules that need the handle (the routes, the download path) can import it
 * without pulling in everything the barrel re-exports.
 *
 * One queue, one budget, one runner, and a scheduler that paces the rotation
 * but no longer executes it. Everything that reaches the disk in the background
 * arrives through `queue` -- see `docs/decisions.md`, "One queue, several job
 * kinds".
 */
import { join } from "path";
import { JobQueue } from "./queue";
import { Budget } from "./budget";
import { JobRunner } from "./runner";
import { ScanScheduler } from "./scheduler";
import { artWorker, coverWorker, heightWorker, makeScanWorker } from "./workers";
import { discover } from "./discover";
import { derivedDir } from "../art";
import { getScanProgress, getMangaList, onScanned } from "../scanner";

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
  const retired = queue.forgetRetiredFailures();
  if (retired > 0) console.log(`[jobs] cleared ${retired} failure(s) from a retired code path`);
  const recovered = queue.recover();
  if (recovered > 0) console.log(`[jobs] ${recovered} interrupted job(s) returned to the queue`);

  budget = new Budget();
  runner = new JobRunner(queue, budget, {
    art: artWorker,
    cover: coverWorker,
    height: heightWorker,
    scan: makeScanWorker(getScanProgress),
  });
  runner.start();

  // Every scan discovers, and this is the only place it is wired. There is no
  // second path, no boot-time backfill, and nothing to remember to call.
  //
  // Discovery covers exactly what the scan covered. A full-library scan --
  // startup, or a user asking -- discovers the whole library at once, which is
  // what makes a cold library derive in minutes rather than in a deadline. A
  // rotation step scans one series and discovers one series, and *that* is the
  // guarantee that nothing is missed for ever: the floor lane visits every
  // series within the floor deadline, permanently, by construction.
  onScanned(async (scope) => {
    const q = queue;
    if (!q) return;
    const found = await discover(q, scope);
    const total = found.art + found.cover + found.height;
    if (total > 0) {
      console.log(`[jobs] queued ${found.art} art, ${found.cover} cover, ${found.height} height`);
      runner?.wake();
    }
  });

  if (opts.scheduler !== false) startScheduler();

  console.log(`[jobs] queue at ${jobsDbPath()}, derived store at ${derivedDir()}`);
  return queue;
}

/**
 * Start the rolling rotation.
 *
 * Separate from `startJobs` because it cannot run until something has been
 * scanned: it addresses series by uid, and nothing has a uid until the first
 * scan has published the cache. `src/index.ts` therefore opens the queue,
 * submits the first scan *as a job*, and starts this afterwards.
 */
export function startScheduler(): ScanScheduler | null {
  if (!budget || scheduler) return scheduler;
  scheduler = new ScanScheduler(budget, {
    /**
     * The rotation's unit of work, expressed as a job.
     *
     * `docs/scheduler.md` section 3's conclusion is preserved exactly: a scan
     * nobody asked for gets no progress count, no spinner and no animating
     * seam. `silent` is how -- the job runs through the same queue, the same
     * runner and the same duty budget as everything else, and is filtered out
     * of `list()`, `counts()` and therefore the ETag, so no client can see it.
     * What changed is that this is a presentation flag rather than a second
     * scheduler; what did not change is anything the user sees.
     */
    submit: async (target) => {
      const q = queue;
      if (!q || !runner) return;
      const job = q.enqueue({
        kind: "scan",
        scope: target.uid,
        label: target.title,
        silent: true,
      });
      runner.wake();
      await runner.waitFor(job.id);
    },
  });
  scheduler.start();
  console.log(
    `[jobs] rolling scan started over ${getMangaList().length} series, floor deadline ${(scheduler.floorDeadlineMs / 3600000).toFixed(1)} h`,
  );
  return scheduler;
}

export async function stopJobs(): Promise<void> {
  await scheduler?.stop();
  await runner?.stop();
  // Before anything else lets go: a scan firing the observer afterwards would
  // reach a handle to a closed database, and a test that stops the pipeline and
  // keeps scanning would fail inside the observer rather than where it looked.
  onScanned(null);
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

/**
 * Enqueue one job and wait for it to finish.
 *
 * For the caller that genuinely has to wait -- the first scan at startup, which
 * the rotation and every derived artefact are sequenced behind. Returns false
 * when there is no queue to run it, so the caller can fall back.
 */
export async function runToCompletion(opts: Parameters<JobQueue["enqueue"]>[0]): Promise<boolean> {
  const job = enqueueNow(opts);
  if (!job || !runner) return false;
  await runner.waitFor(job.id);
  return true;
}
