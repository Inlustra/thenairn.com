/**
 * One budget for every kind of background work.
 *
 * `docs/scheduler.md` sets three controls, in order of authority. They are
 * implemented here rather than in each worker, because the reason they exist is
 * that the *same* FUSE queue serves pages to a reader: a per-worker budget is
 * three budgets, and three budgets is no budget.
 *
 * -------------------------------------------------------------------------
 * (a) Concurrency -- 8, never 32
 * -------------------------------------------------------------------------
 * R-01 puts the stat plateau at ~17.2k/s at concurrency 32, with the knee at
 * 8-16 and `architecture.md` recording that parallelism caps at about 7x. The
 * plateau is the point at which we have taken the *whole* FUSE daemon queue,
 * and the reader is behind us in it. 8 is the knee, which is where the
 * throughput is nearly all there and the queue is still shared.
 *
 * -------------------------------------------------------------------------
 * (b) Duty cycle -- 8% at rest, as wall time, not as an operation rate
 * -------------------------------------------------------------------------
 * Measured over a sliding window and enforced by sleeping between work units.
 * `scheduler.md` argues the choice: a duty cycle degrades gracefully when the
 * array is slow -- the sleeps stay the same, the rotation stretches, and the
 * stretch is reported -- whereas an op-rate limit would silently consume more
 * of a contended mount exactly when it should be backing off.
 *
 * -------------------------------------------------------------------------
 * (c) Idle -- an accelerator, never a gate
 * -------------------------------------------------------------------------
 * No request served for 120 s raises the duty to 50%. Any inbound request drops
 * it back immediately. It is an accelerator because a gate means a library that
 * is used all day is never scanned at all, and that failure is silent: the
 * worst case must never depend on the idle detector being right (R-37).
 *
 * -------------------------------------------------------------------------
 * What a foreground errand does instead
 * -------------------------------------------------------------------------
 * A user-invoked scan is not background work. `scheduler.md`: it "is a
 * foreground errand, run at full concurrency with no duty cap, because the user
 * asked for it and is watching". `Budget.foreground()` is that escape hatch,
 * and it is the only thing that may ignore (b).
 */

export interface BudgetOptions {
  concurrency?: number;
  /** Duty cycle at rest, 0..1. */
  restDuty?: number;
  /** Duty cycle once the box looks idle, 0..1. */
  idleDuty?: number;
  /** How long without a request before the box counts as idle. */
  idleAfterMs?: number;
  /** Sliding window the duty ratio is measured over. */
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  concurrency: 8,
  restDuty: 0.08,
  idleDuty: 0.5,
  idleAfterMs: 120_000,
  windowMs: 300_000,
};

export class Budget {
  readonly concurrency: number;
  private restDuty: number;
  private idleDuty: number;
  private idleAfterMs: number;
  private windowMs: number;
  private now: () => number;
  private sleepFn: (ms: number) => Promise<void>;

  /** Busy spans inside the window, as [start, end] pairs. */
  private spans: [number, number][] = [];
  private lastRequestAt: number;
  private inFlight = 0;
  private waiters: (() => void)[] = [];

  constructor(opts: BudgetOptions = {}) {
    this.concurrency = Math.max(
      1,
      opts.concurrency ?? (Number(process.env.ART_CONCURRENCY) || DEFAULTS.concurrency),
    );
    this.restDuty = opts.restDuty ?? DEFAULTS.restDuty;
    this.idleDuty = opts.idleDuty ?? DEFAULTS.idleDuty;
    this.idleAfterMs = opts.idleAfterMs ?? DEFAULTS.idleAfterMs;
    this.windowMs = opts.windowMs ?? DEFAULTS.windowMs;
    this.now = opts.now ?? (() => Date.now());
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.lastRequestAt = this.now();
  }

  /**
   * The at-rest duty target.
   *
   * Exposed so the scheduler can pace itself: `scheduler.md` section 1 says
   * "choosing the deadline is choosing the budget -- they are the same number",
   * and the ratio of the current target to this one is how much faster than the
   * deadline the rotation is currently allowed to run.
   */
  get baseDuty(): number {
    return this.restDuty;
  }

  /** Called from the HTTP layer. The idle detector's only input. */
  noteRequest(): void {
    this.lastRequestAt = this.now();
  }

  idle(): boolean {
    return this.now() - this.lastRequestAt >= this.idleAfterMs;
  }

  targetDuty(): number {
    return this.idle() ? this.idleDuty : this.restDuty;
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    this.spans = this.spans.filter((s) => s[1] > cutoff);
    if (this.spans.length > 0 && this.spans[0]![0] < cutoff) this.spans[0]![0] = cutoff;
  }

  /** Busy wall time over the window, as a fraction. */
  duty(now = this.now()): number {
    this.trim(now);
    const busy = this.spans.reduce((n, [a, b]) => n + (b - a), 0);
    return busy / this.windowMs;
  }

  /**
   * Run one unit of work under the budget.
   *
   * The sleep happens *before* the unit, not after, so a burst of enqueued work
   * cannot spend the whole window's allowance in one go and then apologise. It
   * is computed from the measured busy time rather than from a fixed interval,
   * which is what makes the control degrade correctly when the array is slow.
   */
  async run<T>(fn: () => Promise<T>, opts: { foreground?: boolean } = {}): Promise<T> {
    await this.acquire();
    try {
      if (!opts.foreground) await this.waitForAllowance();
      const start = this.now();
      try {
        return await fn();
      } finally {
        const end = this.now();
        if (!opts.foreground) {
          this.spans.push([start, end]);
          this.trim(end);
        }
      }
    } finally {
      this.release();
    }
  }

  /** How long we must idle before another unit fits inside the duty target. */
  private async waitForAllowance(): Promise<void> {
    const target = this.targetDuty();
    if (target >= 1) return;
    const now = this.now();
    const busy = (this.trim(now), this.spans.reduce((n, [a, b]) => n + (b - a), 0));
    const allowed = target * this.windowMs;
    if (busy <= allowed) return;
    // Sleep proportionally to the overspend, capped so a long stall still
    // reports progress rather than looking wedged.
    const wait = Math.min(30_000, Math.ceil((busy - allowed) / Math.max(target, 0.01)));
    if (wait > 0) await this.sleepFn(wait);
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.concurrency) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  private release(): void {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }

  status() {
    return {
      concurrency: this.concurrency,
      inFlight: this.inFlight,
      idle: this.idle(),
      targetDuty: this.targetDuty(),
      duty: Number(this.duty().toFixed(4)),
    };
  }
}
