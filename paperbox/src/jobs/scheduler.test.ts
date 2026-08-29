import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Budget } from "./budget";
import { ScanScheduler, type Lane } from "./scheduler";
import { JobQueue } from "./queue";
import { JobRunner } from "./runner";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let ROOT: string;
let prev: string | undefined;
let scanner: typeof import("../scanner");

async function makeChapter(series: string, chapter: string, pages = 1) {
  const dir = join(ROOT, series, chapter);
  await mkdir(dir, { recursive: true });
  for (let i = 1; i <= pages; i++) {
    await writeFile(join(dir, `${String(i).padStart(3, "0")}.png`), PIXEL);
  }
}

const SERIES = ["Alpha", "Beta", "Gamma", "Delta"];

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "paperbox-sched-"));
  prev = process.env.MANGA_DIR;
  process.env.MANGA_DIR = ROOT;
  scanner = await import("../scanner");
  for (const s of SERIES) await makeChapter(s, "Chapter 001");
  await scanner.scan();
});

afterAll(async () => {
  if (prev === undefined) delete process.env.MANGA_DIR;
  else process.env.MANGA_DIR = prev;
  await rm(ROOT, { recursive: true, force: true });
});

/** A budget that never sleeps, so a rotation is a loop and not a wait. */
function freeBudget() {
  return new Budget({ concurrency: 1, restDuty: 1, sleep: async () => {} });
}

beforeEach(async () => {
  process.env.MANGA_DIR = ROOT;
  await scanner.scan();
});

describe("the unit of work is one series", () => {
  test("a step scans exactly one series and records when it looked", async () => {
    const s = new ScanScheduler(freeBudget());
    const step = await s.step();
    expect(step).not.toBeNull();
    const looked = s.freshness().filter((f) => f.lastLookedAt !== null);
    expect(looked.length).toBe(1);
  });

  test("an empty library is a no-op rather than an error", async () => {
    const empty = await mkdtemp(join(tmpdir(), "paperbox-sched-empty-"));
    process.env.MANGA_DIR = empty;
    await scanner.scan();
    const s = new ScanScheduler(freeBudget());
    expect(await s.step()).toBeNull();
    await rm(empty, { recursive: true, force: true });
    process.env.MANGA_DIR = ROOT;
    await scanner.scan();
  });
});

describe("the floor lane", () => {
  test("is a strict rotation: every series is visited before any is repeated", async () => {
    const s = new ScanScheduler(freeBudget());
    const seen: string[] = [];
    for (let i = 0; i < SERIES.length * 2; i++) {
      const step = await s.step();
      if (step?.lane === "floor") seen.push(step.uid);
    }
    const firstPass = seen.slice(0, SERIES.length);
    expect(new Set(firstPass).size).toBe(SERIES.length);
  });

  test("contains every series permanently, whatever lane it is also in", async () => {
    const s = new ScanScheduler(freeBudget(), { readRecency: () => Date.now() });
    await s.step();
    expect(s.status().lanes.floor).toBe(SERIES.length);
    expect(s.status().lanes.hot).toBe(SERIES.length);
  });

  test("keeps its share of the budget even when the hot lane is full", async () => {
    // The guarantee: priority can pull a series forward, it can never push one
    // past the floor's rotation. Without it a hot series read every day would
    // starve the cold tail indefinitely, and the worst case would be a hope.
    const s = new ScanScheduler(freeBudget(), { readRecency: () => Date.now() });
    const lanes: Lane[] = [];
    for (let i = 0; i < 40; i++) {
      const step = await s.step();
      if (step) lanes.push(step.lane);
    }
    const floor = lanes.filter((l) => l === "floor").length;
    expect(floor / lanes.length).toBeGreaterThanOrEqual(0.45);
  });

  test("an empty hot lane forfeits its turn to the floor rather than idling", async () => {
    const s = new ScanScheduler(freeBudget(), { readRecency: () => null });
    const lanes: Lane[] = [];
    for (let i = 0; i < 12; i++) {
      const step = await s.step();
      if (step) lanes.push(step.lane);
    }
    expect(lanes.every((l) => l === "floor")).toBe(true);
  });
});

describe("lane membership", () => {
  test("read within 24 h is hot; within 30 d is warm; neither is floor only", async () => {
    const now = Date.now();
    const uid = scanner.getMangaList()[0]!.uid;
    const hot = new ScanScheduler(freeBudget(), { readRecency: () => now - 60_000, now: () => now });
    const warm = new ScanScheduler(freeBudget(), {
      readRecency: () => now - 5 * 24 * 3600_000,
      now: () => now,
    });
    const cold = new ScanScheduler(freeBudget(), {
      readRecency: () => now - 90 * 24 * 3600_000,
      now: () => now,
    });
    for (const s of [hot, warm, cold]) s.sync();
    expect(hot.laneOf(uid)).toBe("hot");
    expect(warm.laneOf(uid)).toBe("warm");
    expect(cold.laneOf(uid)).toBe("floor");
  });

  test("a series that just changed is hot, because change begets change", async () => {
    const s = new ScanScheduler(freeBudget());
    // Walk the whole rotation once so every series has a baseline signature.
    for (let i = 0; i < SERIES.length; i++) await s.step();
    await makeChapter("Alpha", "Chapter 002");
    let changedUid: string | null = null;
    for (let i = 0; i < SERIES.length * 2 && !changedUid; i++) {
      const step = await s.step();
      if (step?.changed) changedUid = step.uid;
    }
    expect(changedUid).not.toBeNull();
    expect(s.laneOf(changedUid!)).toBe("hot");
    await rm(join(ROOT, "Alpha", "Chapter 002"), { recursive: true, force: true });
  });
});

describe("pacing", () => {
  test("paces to the deadline, because the duty cap is a ceiling and not a pace", async () => {
    // Without this a twelve-series library rotates thousands of times before
    // the duty cap notices -- thousands of readdirs on a shared mount, to meet
    // a deadline hours away. scheduler.md: "choosing the deadline is choosing
    // the budget -- they are the same number."
    const s = new ScanScheduler(freeBudget(), { floorDeadlineMs: 6 * 3600_000 });
    s.sync();
    const interval = (s as unknown as { intervalMs(n: number): number }).intervalMs(SERIES.length);
    expect(interval).toBe((6 * 3600_000) / SERIES.length);
  });

  test("an idle box is paced faster, in proportion to the duty it was granted", async () => {
    const budget = new Budget({
      concurrency: 1,
      restDuty: 0.08,
      idleDuty: 0.5,
      idleAfterMs: 0,
      sleep: async () => {},
    });
    const s = new ScanScheduler(budget, { floorDeadlineMs: 6 * 3600_000 });
    s.sync();
    const interval = (s as unknown as { intervalMs(n: number): number }).intervalMs(SERIES.length);
    // 0.5 / 0.08 = 6.25x faster than the at-rest pace.
    expect(interval).toBeCloseTo((6 * 3600_000) / SERIES.length / 6.25, 0);
  });

  test("an empty library waits rather than dividing by zero", () => {
    const s = new ScanScheduler(freeBudget());
    expect((s as unknown as { intervalMs(n: number): number }).intervalMs(0)).toBe(5000);
  });
});

describe("the rotation goes through the one queue, and is not surfaced", () => {
  test("a step submits its scan and waits for it, rather than running it itself", async () => {
    const submitted: string[] = [];
    let finished = false;
    const s = new ScanScheduler(freeBudget(), {
      submit: async (t) => {
        submitted.push(t.dir);
        await new Promise((r) => setTimeout(r, 10));
        finished = true;
      },
    });
    const step = await s.step();
    expect(submitted.length).toBe(1);
    // The signature comparison that decides `changed` is read after the scan,
    // so a step that did not wait would report on a scan that had not landed.
    expect(finished).toBe(true);
    expect(step).not.toBeNull();
  });

  test("through a real queue: the scan runs, and no client can see it", async () => {
    // docs/scheduler.md section 3 -- "Scan running, nobody asked -> Nothing" --
    // preserved exactly, as a presentation flag rather than as a second
    // scheduler. The job itself is entirely real: claimed, run, finished.
    const q = new JobQueue(":memory:");
    let scanned = 0;
    const runner = new JobRunner(
      q,
      freeBudget(),
      {
        scan: async () => {
          scanned++;
        },
      },
      { pollMs: 5 },
    );
    runner.start();
    const s = new ScanScheduler(freeBudget(), {
      submit: async (t) => {
        const job = q.enqueue({ kind: "scan", scope: t.uid, label: t.title, silent: true });
        runner.wake();
        await runner.waitFor(job.id);
      },
    });
    await s.step();
    expect(scanned).toBe(1);
    expect(q.listAll().length).toBe(1);
    expect(q.listAll()[0]!.state).toBe("done");
    // What a client is handed: nothing at all.
    expect(q.list()).toEqual([]);
    expect(q.counts()).toEqual({ running: 0, queued: 0 });
    await runner.stop();
    q.close();
  });
});

describe("what it reports", () => {
  test("calls back with the series whose content moved, and counts it by lane", async () => {
    const s = new ScanScheduler(freeBudget());
    const changes: string[] = [];
    const s2 = new ScanScheduler(freeBudget(), { onChange: (uid) => changes.push(uid) });
    for (let i = 0; i < SERIES.length; i++) await s2.step();
    await makeChapter("Beta", "Chapter 002");
    for (let i = 0; i < SERIES.length * 2 && changes.length === 0; i++) await s2.step();
    expect(changes.length).toBe(1);
    expect(s2.status().changesByLane.floor + s2.status().changesByLane.hot).toBeGreaterThan(0);
    await rm(join(ROOT, "Beta", "Chapter 002"), { recursive: true, force: true });
    void s;
  });

  test("a series that has not been looked at yet says so, rather than claiming a date", async () => {
    const s = new ScanScheduler(freeBudget());
    s.sync();
    expect(s.freshness().every((f) => f.lastLookedAt === null)).toBe(true);
  });

  test("goes amber only after two consecutive late rotations, not one", async () => {
    // One slow rotation is weather; two is a condition. scheduler.md gives this
    // no retry affordance because it is not something a user can act on.
    let t = 0;
    const s = new ScanScheduler(freeBudget(), { floorDeadlineMs: 100, now: () => t });
    const rotate = async (ms: number) => {
      for (let i = 0; i < SERIES.length; i++) {
        t += ms / SERIES.length;
        await s.step();
      }
    };
    await rotate(0);
    await rotate(1000); // late
    expect(s.status().behind).toBe(false);
    await rotate(1000); // late again
    expect(s.status().behind).toBe(true);
  });

  test("reports the deadline it is working to, so the copy cannot outlive the number", () => {
    const s = new ScanScheduler(freeBudget(), { floorDeadlineMs: 6 * 3600_000 });
    expect(s.status().floorDeadlineMs).toBe(6 * 3600_000);
  });
});
