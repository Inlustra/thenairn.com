/**
 * The worker.
 *
 * One job at a time, with the parallelism inside a job rather than across
 * jobs. `docs/scheduler.md` specifies "one scan worker" and a single shared
 * budget; running several jobs side by side would mean the concurrency cap
 * bounds each of them separately, and the cap exists to bound the *mount*.
 *
 * Cancellation is checked between units, never mid-unit. A unit is one chapter
 * or one series -- 0.2-0.7 s of work -- and the store's write-then-rename means
 * an interrupted unit leaves nothing half-written. Killing mid-unit would buy
 * sub-second responsiveness at the cost of that guarantee.
 */
import type { Job, JobKind, JobQueue } from "./queue";
import type { Budget } from "./budget";

export interface JobContext {
  job: Job;
  /** Report units completed, and the total once it is known. */
  progress(done: number, total?: number | null): void;
  /** True once someone has cancelled. Check between units. */
  cancelled(): boolean;
  budget: Budget;
  /** Foreground errands skip the duty cap. See Budget. */
  foreground: boolean;
  /** Nobody asked for this one; it is not listed anywhere. */
  silent: boolean;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export interface RunnerOptions {
  /** How long to wait before looking for work again when there was none. */
  pollMs?: number;
  /** Kinds that run as a foreground errand rather than under the duty cap. */
  foregroundKinds?: JobKind[];
}

export class JobRunner {
  private running = false;
  private loop: Promise<void> | null = null;
  private wakeup: (() => void) | null = null;
  private pollMs: number;
  private foregroundKinds: Set<JobKind>;
  /** Callers parked on `waitFor`, by job id. */
  private waitingFor = new Map<string, (() => void)[]>();

  constructor(
    private queue: JobQueue,
    private budget: Budget,
    private handlers: Partial<Record<JobKind, JobHandler>>,
    opts: RunnerOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 1000;
    // A scan the user asked for is theirs and they are watching it; art, cover
    // and height work is nobody's errand and stays under the cap.
    this.foregroundKinds = new Set(opts.foregroundKinds ?? ["scan"]);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.pump();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake();
    await this.loop?.catch(() => {});
    this.loop = null;
    // Nothing is going to run these now. Leaving a caller parked on a job that
    // can no longer be claimed is how a shutdown turns into a hang -- the
    // rolling scan would sit on `waitFor` forever and `stopJobs` never return.
    for (const id of [...this.waitingFor.keys()]) this.settle(id);
  }

  /** Called after an enqueue so a new job starts now rather than on the poll. */
  wake(): void {
    this.wakeup?.();
    this.wakeup = null;
  }

  /**
   * Resolve once this job is no longer queued or running.
   *
   * The rolling scan needs it: it submits a scan as a job and cannot compute
   * the series' new signature, or time its own rotation, until that job has
   * actually run. Never rejects -- a failed job is a finished job, and the
   * rotation's response to a series it could not read is to move on to the
   * next one, which is what `scheduler.ts` already did with a thrown error.
   *
   * The state read and the registration happen with no `await` between them,
   * which is what makes the obvious race impossible: a job cannot finish
   * "between" the check and the listener.
   */
  waitFor(id: string): Promise<void> {
    const job = this.queue.get(id);
    if (!job || (job.state !== "queued" && job.state !== "running")) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const list = this.waitingFor.get(id);
      if (list) list.push(resolve);
      else this.waitingFor.set(id, [resolve]);
    });
  }

  private settle(id: string): void {
    const list = this.waitingFor.get(id);
    if (!list) return;
    this.waitingFor.delete(id);
    for (const resolve of list) resolve();
  }

  private async pump(): Promise<void> {
    while (this.running) {
      const did = await this.runOne();
      if (!did && this.running) {
        await new Promise<void>((resolve) => {
          this.wakeup = resolve;
          setTimeout(resolve, this.pollMs);
        });
      }
    }
  }

  /**
   * Claim and run one job. Returns false when there was nothing to do.
   *
   * Exported behaviour, not just an internal step: the tests drive the runner
   * one job at a time rather than starting a loop and sleeping, which is how a
   * scheduling test stays deterministic.
   */
  async runOne(): Promise<boolean> {
    const job = this.queue.claim();
    if (!job) return false;

    const handler = this.handlers[job.kind];
    if (!handler) {
      this.queue.fail(job.id, `no handler for job kind "${job.kind}"`);
      this.settle(job.id);
      return true;
    }

    // A scan is a foreground errand *because someone asked for it*, not because
    // it is a scan. The rolling rotation submits the same kind of job with
    // `silent` set, and that one stays under the duty cap -- which is exactly
    // the behaviour it had when it was a separate loop calling `budget.run`.
    const silent = this.queue.isSilent(job.id);
    const ctx: JobContext = {
      job,
      progress: (done, total) => this.queue.progress(job.id, done, total),
      cancelled: () => this.queue.isCancelled(job.id),
      budget: this.budget,
      foreground: this.foregroundKinds.has(job.kind) && !silent,
      silent,
    };

    try {
      await handler(ctx);
      this.queue.finish(job.id);
    } catch (e: unknown) {
      // A failed job is a fact worth keeping, not a log line. `decisions.md`:
      // "an artefact you can count is a claim you can check".
      const message = e instanceof Error ? e.message : String(e);
      this.queue.fail(job.id, message);
      console.error(`[jobs] ${job.kind} "${job.label}" failed: ${message}`);
    }
    this.settle(job.id);
    this.queue.prune();
    return true;
  }
}
