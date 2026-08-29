/**
 * Background work: one persistent queue, one budget, one runner, four job
 * kinds, and a scheduler that paces the rolling scan without executing it.
 *
 * See `queue.ts` for why jobs are on disk and why `silent` is a column,
 * `budget.ts` for the single concurrency and duty budget they all share,
 * `discover.ts` for how missing derived work is noticed, and `scheduler.ts` for
 * how the rotation stays unsurfaced while still being a job.
 */
export { JobQueue } from "./queue";
export type { Job, JobKind, JobState, EnqueueOptions } from "./queue";
export { Budget } from "./budget";
export type { BudgetOptions } from "./budget";
export { JobRunner } from "./runner";
export type { JobContext, JobHandler } from "./runner";
export { ScanScheduler } from "./scheduler";
export type { Lane, SchedulerStatus, SeriesFreshness, ScanTarget } from "./scheduler";
export { artWorker, coverWorker, heightWorker, makeScanWorker, enqueueSeriesArt } from "./workers";
export { discover } from "./discover";
export type { Discovered } from "./discover";
export {
  getJobs,
  getBudget,
  getScheduler,
  configureJobs,
  startJobs,
  startScheduler,
  stopJobs,
  enqueueNow,
  runToCompletion,
  jobsDbPath,
} from "./handle";
