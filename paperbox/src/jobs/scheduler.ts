/**
 * The rolling partial scan.
 *
 * Built to `docs/scheduler.md`, which was written the day R-29 measured the
 * scan curve and R-30 disproved the 30-60 s cadence the rest of the design
 * rested on. The short version: a full quick sweep is 865 s of work at the
 * R-12 target, which is 1.0% of a day. The work was never large; the interval
 * was. So this is a rotation with a deadline, not a sweep with a period.
 *
 * -------------------------------------------------------------------------
 * Why this is not a job
 * -------------------------------------------------------------------------
 * `scheduler.md` section 3 is explicit: *"Scan running, nobody asked -> Nothing.
 * No spinner, no ambient seam, no count."* A background rotation that appeared
 * in `GET /api/jobs` would be permanently `running`, every client would show a
 * permanent scan, and `ui.md`'s rule that the animating seam belongs to the
 * near lane would be broken by a process that never stops. So the rotation is
 * **not a job**. It reports freshness -- when each series was last looked at,
 * and whether the rotation is keeping up -- and freshness is drawn as the
 * pencil layer applied to time, with dated sentences and no ticking number.
 *
 * A scan the *user* asked for is a job, because asking made it their errand.
 * That is `makeScanWorker` in `workers.ts`.
 *
 * -------------------------------------------------------------------------
 * Three lanes, weighted round-robin, one worker
 * -------------------------------------------------------------------------
 * Floor is a strict rotation over every series with a guaranteed share of the
 * budget: priority can pull a series forward, it can never push one past the
 * floor's rotation. That is what turns "worst case" from a hope into a number.
 * The credit scheduler below gives floor its share whether or not the hot and
 * warm lanes have anything in them, which is the property that matters.
 *
 * The hot and warm lanes are a bet (R-33) that hand-added files cluster in
 * series the user is reading. That bet is unmeasured. `changesByLane` and
 * `changeLog` below exist to settle it: `scheduler.md` says logging which lane
 * finds changes "costs nothing and can run from day one", so it does. If the
 * bet is wrong the lanes are deleted and the floor takes 100% of the budget,
 * which improves the worst case rather than degrading it.
 */
import { getManga, getMangaList, scan } from "../scanner";
import type { Budget } from "./budget";

export type Lane = "floor" | "hot" | "warm";

/** scheduler.md section 2's recommended split. Floor's share is the guarantee. */
const WEIGHTS: Record<Lane, number> = { floor: 0.5, hot: 0.3, warm: 0.2 };

/**
 * The worst-case staleness target for the floor lane.
 *
 * **Owner's call, and the whole table in `scheduler.md` section 1 is
 * defensible.** 6 h is the document's recommendation; it is a product decision
 * about how patient a hand-managed library is allowed to make you, and the copy
 * in `scheduler.md` section 4 names this number out loud, so changing it here
 * means changing that sentence in the same edit.
 */
const DEFAULT_FLOOR_DEADLINE_MS = 6 * 60 * 60 * 1000;

export interface SeriesFreshness {
  uid: string;
  dir: string;
  title: string;
  /** ms epoch, or null when it has not been looked at since boot. */
  lastLookedAt: number | null;
  lane: Lane;
  /** Whether either of the last two passes over it found a change. */
  recentlyChanged: boolean;
}

export interface SchedulerStatus {
  running: boolean;
  /** Measured floor rotation, ms. Null until the first one completes. */
  floorRotationMs: number | null;
  floorDeadlineMs: number;
  /**
   * scheduler.md section 3: rotation period > 2x target for two consecutive
   * rotations is the amber condition -- "Scanning is running behind. The
   * library is busy." No retry affordance; it is not something a user can fix.
   */
  behind: boolean;
  seriesTotal: number;
  lanes: Record<Lane, number>;
  /** R-33's evidence: which lane found the changes. */
  changesByLane: Record<Lane, number>;
  budget: ReturnType<Budget["status"]>;
}

export interface SchedulerOptions {
  floorDeadlineMs?: number;
  /** Called with the uid and title of a series whose content moved. */
  onChange?: (uid: string, title: string, lane: Lane) => void;
  /** Injected for tests. */
  now?: () => number;
  readRecency?: (uid: string) => number | null;
}

/**
 * A cheap signature over a series' chapter set.
 *
 * Enough to answer "did anything move" for the lane membership rules and for
 * R-33, and derived from data the scan has already computed -- so it costs no
 * filesystem work of its own. It is not a sync hash and nothing downstream
 * consumes it; `hashes.ts` owns that.
 */
function seriesSignature(slug: string): string {
  const m = getManga(slug);
  if (!m) return "";
  const hasher = new Bun.CryptoHasher("sha256");
  for (const c of m.chapters) hasher.update(`${c.dir}:${c.fingerprint ?? ""}:${c.pageCount} `);
  return hasher.digest("hex").slice(0, 16);
}

interface Tracked {
  uid: string;
  slug: string;
  dir: string;
  title: string;
  lastLookedAt: number | null;
  signature: string;
  /** Change flags for the last two passes, newest first. */
  changed: [boolean, boolean];
}

export class ScanScheduler {
  private tracked = new Map<string, Tracked>();
  private cursors: Record<Lane, number> = { floor: 0, hot: 0, warm: 0 };
  private credits: Record<Lane, number> = { floor: 0, hot: 0, warm: 0 };
  private floorRotationStartedAt: number | null = null;
  private floorRotationMs: number | null = null;
  private consecutiveLate = 0;
  private running = false;
  private loop: Promise<void> | null = null;
  readonly floorDeadlineMs: number;
  private onChange?: (uid: string, title: string, lane: Lane) => void;
  private now: () => number;
  private readRecency: (uid: string) => number | null;
  changesByLane: Record<Lane, number> = { floor: 0, hot: 0, warm: 0 };

  constructor(private budget: Budget, opts: SchedulerOptions = {}) {
    this.floorDeadlineMs =
      opts.floorDeadlineMs ?? (Number(process.env.SCAN_FLOOR_DEADLINE_MS) || DEFAULT_FLOOR_DEADLINE_MS);
    this.onChange = opts.onChange;
    this.now = opts.now ?? (() => Date.now());
    this.readRecency = opts.readRecency ?? (() => null);
  }

  /** Pick up series added or removed since the last pass. */
  sync(): void {
    const seen = new Set<string>();
    for (const m of getMangaList()) {
      seen.add(m.uid);
      const existing = this.tracked.get(m.uid);
      if (existing) {
        existing.slug = m.id;
        existing.dir = m.dir;
        existing.title = m.title;
      } else {
        this.tracked.set(m.uid, {
          uid: m.uid,
          slug: m.id,
          dir: m.dir,
          title: m.title,
          lastLookedAt: null,
          signature: seriesSignature(m.id),
          changed: [false, false],
        });
      }
    }
    for (const uid of [...this.tracked.keys()]) if (!seen.has(uid)) this.tracked.delete(uid);
  }

  laneOf(uid: string): Lane {
    const t = this.tracked.get(uid);
    if (!t) return "floor";
    const read = this.readRecency(uid);
    const now = this.now();
    // scheduler.md section 1's membership table. "Pinned" and "upstream
    // latest_chapter exceeds held count" are both real conditions in that table
    // and neither has a source of truth yet -- there is no pin flag anywhere in
    // the model, and R-27 says the registry supplies `latest_chapter` but
    // nothing stores it. Left out rather than faked.
    if (t.changed[0] || t.changed[1]) return "hot";
    if (read !== null && now - read < 24 * 60 * 60 * 1000) return "hot";
    if (read !== null && now - read < 30 * 24 * 60 * 60 * 1000) return "warm";
    return "floor";
  }

  private membership(): Record<Lane, Tracked[]> {
    const out: Record<Lane, Tracked[]> = { floor: [], hot: [], warm: [] };
    for (const t of this.tracked.values()) {
      // Floor is "always -- every series, permanently. It leaves: never."
      out.floor.push(t);
      const lane = this.laneOf(t.uid);
      if (lane !== "floor") out[lane].push(t);
    }
    const byUid = (a: Tracked, b: Tracked) => a.uid.localeCompare(b.uid);
    out.floor.sort(byUid);
    out.hot.sort(byUid);
    out.warm.sort(byUid);
    return out;
  }

  /**
   * Choose the next lane by credits.
   *
   * Each pick adds every lane's weight to its credit and spends from the
   * largest. A lane with nothing in it forfeits the turn to the floor rather
   * than banking credit, so an empty hot lane makes the floor rotate *faster*
   * instead of leaving the worker idle.
   */
  private nextLane(members: Record<Lane, Tracked[]>): Lane {
    let best: Lane = "floor";
    let bestCredit = -Infinity;
    for (const lane of ["floor", "hot", "warm"] as Lane[]) {
      this.credits[lane] += WEIGHTS[lane];
      if (members[lane].length > 0 && this.credits[lane] > bestCredit) {
        bestCredit = this.credits[lane];
        best = lane;
      }
    }
    this.credits[best] -= 1;
    return best;
  }

  /**
   * One unit of work: look at exactly one series.
   *
   * `scheduler.md`: "The unit of work is one series. Not a block, not a
   * chapter, not a directory." A new chapter is discovered only by listing the
   * series directory, so anything smaller cannot find chapter 314, which is the
   * entire point of scanning.
   */
  async step(): Promise<{ lane: Lane; uid: string; changed: boolean } | null> {
    this.sync();
    const members = this.membership();
    if (members.floor.length === 0) return null;

    const lane = this.nextLane(members);
    const list = members[lane];
    const cursor = this.cursors[lane] % list.length;
    const target = list[cursor]!;
    this.cursors[lane] = cursor + 1;

    if (lane === "floor") {
      if (cursor === 0) {
        const start = this.floorRotationStartedAt;
        if (start !== null) {
          this.floorRotationMs = this.now() - start;
          // Amber only after two consecutive late rotations: one slow rotation
          // is weather, two is a condition.
          this.consecutiveLate = this.floorRotationMs > 2 * this.floorDeadlineMs ? this.consecutiveLate + 1 : 0;
        }
        this.floorRotationStartedAt = this.now();
      }
    }

    await this.budget.run(() => scan({ series: target.dir }));

    const signature = seriesSignature(target.slug);
    const changed = signature !== target.signature;
    target.signature = signature;
    target.changed = [changed, target.changed[0]];
    target.lastLookedAt = this.now();
    if (changed) {
      this.changesByLane[lane]++;
      this.onChange?.(target.uid, target.title, lane);
    }
    return { lane, uid: target.uid, changed };
  }

  /**
   * How long to wait before looking at the next series.
   *
   * The duty cycle is a *ceiling*, not a pace. On a twelve-series library each
   * step costs about a millisecond, so a rotation would complete thousands of
   * times over before the duty cap noticed -- thousands of pointless readdirs
   * on a mount shared with a reader, to meet a deadline six hours away.
   *
   * `scheduler.md` section 1: "choosing the deadline is choosing the budget --
   * they are the same number." So pace to the deadline: one series every
   * `deadline / series`, divided by whatever extra duty the idle detector has
   * granted. The duty cap still applies underneath and still wins on a large
   * library, where the deadline asks for more than the budget allows.
   */
  private intervalMs(seriesCount: number): number {
    if (seriesCount <= 0) return 5000;
    const accel = this.budget.targetDuty() / Math.max(this.budget.baseDuty, 0.001);
    return this.floorDeadlineMs / seriesCount / Math.max(accel, 1);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          const startedAt = Date.now();
          const did = await this.step();
          if (!did) {
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          const wait = this.intervalMs(this.tracked.size) - (Date.now() - startedAt);
          // Capped, so `stop()` is not held up for hours on a small library.
          if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
        } catch (e) {
          // A scan that fails is not a reason to stop rotating: the next series
          // is unaffected, and stopping would make one unreadable directory
          // silently freeze freshness for the whole library.
          console.error("[scheduler] step failed", e);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => {});
    this.loop = null;
  }

  freshness(): SeriesFreshness[] {
    return [...this.tracked.values()].map((t) => ({
      uid: t.uid,
      dir: t.dir,
      title: t.title,
      lastLookedAt: t.lastLookedAt,
      lane: this.laneOf(t.uid),
      recentlyChanged: t.changed[0] || t.changed[1],
    }));
  }

  status(): SchedulerStatus {
    const members = this.membership();
    return {
      running: this.running,
      floorRotationMs: this.floorRotationMs,
      floorDeadlineMs: this.floorDeadlineMs,
      behind: this.consecutiveLate >= 2,
      seriesTotal: this.tracked.size,
      lanes: { floor: members.floor.length, hot: members.hot.length, warm: members.warm.length },
      changesByLane: { ...this.changesByLane },
      budget: this.budget.status(),
    };
  }
}
