/**
 * Background work: a persistent queue, one budget, three workers, and the
 * rolling scan.
 *
 * See `queue.ts` for why jobs are on disk, `budget.ts` for the single
 * concurrency and duty budget they all share, and `scheduler.ts` for why the
 * background scan is deliberately *not* a job.
 */
export { JobQueue } from "./queue";
export type { Job, JobKind, JobState, EnqueueOptions } from "./queue";
export { Budget } from "./budget";
export type { BudgetOptions } from "./budget";
export { JobRunner } from "./runner";
export type { JobContext, JobHandler } from "./runner";
export { ScanScheduler } from "./scheduler";
export type { Lane, SchedulerStatus, SeriesFreshness } from "./scheduler";
export { artWorker, coverWorker, makeScanWorker, enqueueSeriesArt } from "./workers";
export {
  getJobs,
  getBudget,
  getScheduler,
  configureJobs,
  startJobs,
  stopJobs,
  enqueueNow,
  jobsDbPath,
} from "./handle";
