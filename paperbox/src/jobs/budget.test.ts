import { describe, expect, test } from "bun:test";
import { Budget } from "./budget";

/** A controllable clock, so duty-cycle behaviour is asserted, not slept through. */
function fake() {
  let t = 0;
  const slept: number[] = [];
  const budget = new Budget({
    concurrency: 2,
    restDuty: 0.1,
    idleDuty: 0.5,
    idleAfterMs: 1000,
    windowMs: 10_000,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  });
  return {
    budget,
    slept,
    advance: (ms: number) => (t += ms),
    at: () => t,
    work: (ms: number) => async () => {
      t += ms;
    },
  };
}

describe("concurrency", () => {
  test("caps in-flight work at the configured width", async () => {
    const budget = new Budget({ concurrency: 2, restDuty: 1 });
    let peak = 0;
    let live = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        budget.run(async () => {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 5));
          live--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  test("defaults to 8 -- the knee, not the plateau", () => {
    // R-01 puts the stat plateau at concurrency 32; taking the plateau means
    // taking the whole FUSE queue, which is shared with serving pages.
    expect(new Budget().concurrency).toBe(8);
  });

  test("releases its slot even when a unit throws", async () => {
    const budget = new Budget({ concurrency: 1, restDuty: 1 });
    await budget.run(async () => {
      throw new Error("boom");
    }).catch(() => {});
    // A leaked semaphore slot would hang here forever.
    await budget.run(async () => {});
    expect(budget.status().inFlight).toBe(0);
  });
});

describe("duty cycle", () => {
  test("does not sleep while inside the allowance", async () => {
    const f = fake();
    // 10% of a 10 s window is 1000 ms of work.
    await f.budget.run(f.work(500));
    await f.budget.run(f.work(400));
    expect(f.slept).toEqual([]);
  });

  test("sleeps once the window's allowance is spent", async () => {
    const f = fake();
    await f.budget.run(f.work(2000));
    // Keep the box looking busy: otherwise the idle detector raises the target
    // to 50% and 2 s of work is comfortably inside it. That is the accelerator
    // working, not the cap failing, and it is worth the extra line to say so.
    f.budget.noteRequest();
    await f.budget.run(f.work(10));
    expect(f.slept.length).toBe(1);
    expect(f.slept[0]!).toBeGreaterThan(0);
  });

  test("an idle box is allowed to spend more before it sleeps", async () => {
    const f = fake();
    await f.budget.run(f.work(2000)); // 20% of the window; over the 10% target
    await f.budget.run(f.work(10)); // ...but the box went idle, so 50% applies
    expect(f.slept).toEqual([]);
  });

  test("measures wall time over a sliding window, so old work stops counting", async () => {
    const f = fake();
    await f.budget.run(f.work(2000));
    expect(f.budget.duty()).toBeGreaterThan(0.1);
    f.advance(20_000); // the whole window has rolled past
    expect(f.budget.duty()).toBe(0);
  });

  test("a foreground errand ignores the cap and is not charged for it", async () => {
    // scheduler.md: a user-invoked scan runs "at full concurrency with no duty
    // cap, because the user asked for it and is watching".
    const f = fake();
    await f.budget.run(f.work(9000), { foreground: true });
    expect(f.slept).toEqual([]);
    expect(f.budget.duty()).toBe(0);
  });
});

describe("the idle detector", () => {
  test("raises the duty target once nothing has been served for a while", () => {
    const f = fake();
    expect(f.budget.targetDuty()).toBe(0.1);
    f.advance(1500);
    expect(f.budget.idle()).toBe(true);
    expect(f.budget.targetDuty()).toBe(0.5);
  });

  test("any request drops it straight back", () => {
    const f = fake();
    f.advance(1500);
    expect(f.budget.targetDuty()).toBe(0.5);
    f.budget.noteRequest();
    expect(f.budget.targetDuty()).toBe(0.1);
  });

  test("is an accelerator, never a gate: work still runs while the box is busy", async () => {
    // The worst case must never depend on the detector being right (R-37). A
    // gate would mean a library used all day is never scanned at all, silently.
    const f = fake();
    f.budget.noteRequest();
    let ran = false;
    await f.budget.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
