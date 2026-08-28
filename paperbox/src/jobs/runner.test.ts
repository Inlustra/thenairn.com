import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { JobQueue } from "./queue";
import { Budget } from "./budget";
import { JobRunner, type JobContext } from "./runner";

let q: JobQueue;
const budget = () => new Budget({ concurrency: 2, restDuty: 1, sleep: async () => {} });

beforeEach(() => {
  q = new JobQueue(":memory:");
});
afterEach(() => q.close());

describe("running a job", () => {
  test("claims, runs and finishes", async () => {
    const job = q.enqueue({ kind: "art", scope: "s", label: "Nano Machine" });
    let ran = false;
    const runner = new JobRunner(q, budget(), { art: async () => { ran = true; } });
    expect(await runner.runOne()).toBe(true);
    expect(ran).toBe(true);
    expect(q.get(job.id)!.state).toBe("done");
    expect(q.get(job.id)!.finishedAt).not.toBeNull();
  });

  test("returns false when there is nothing to do", async () => {
    const runner = new JobRunner(q, budget(), {});
    expect(await runner.runOne()).toBe(false);
  });

  test("records progress the client can render", async () => {
    const job = q.enqueue({ kind: "art", scope: "s", label: "x" });
    const runner = new JobRunner(q, budget(), {
      art: async (ctx: JobContext) => {
        ctx.progress(0, 3);
        ctx.progress(2);
      },
    });
    await runner.runOne();
    expect(q.get(job.id)!.done).toBe(2);
    expect(q.get(job.id)!.total).toBe(3);
  });

  test("a throwing handler fails the job with its message, not a log line", async () => {
    // decisions.md: "an artefact you can count is a claim you can check; a log
    // line is only a claim."
    const job = q.enqueue({ kind: "art", scope: "s", label: "x" });
    const runner = new JobRunner(q, budget(), {
      art: async () => {
        throw new Error("library root unreadable");
      },
    });
    await runner.runOne();
    const after = q.get(job.id)!;
    expect(after.state).toBe("failed");
    expect(after.error).toBe("library root unreadable");
  });

  test("an unknown kind fails rather than silently succeeding", async () => {
    const job = q.enqueue({ kind: "cover", scope: "s", label: "x" });
    const runner = new JobRunner(q, budget(), {});
    await runner.runOne();
    expect(q.get(job.id)!.state).toBe("failed");
  });

  test("a cancelled job that stops early reports cancelled, never done", async () => {
    const job = q.enqueue({ kind: "art", scope: "s", label: "x" });
    const runner = new JobRunner(q, budget(), {
      art: async (ctx) => {
        q.cancel(ctx.job.id);
        if (ctx.cancelled()) return;
        throw new Error("should have stopped");
      },
    });
    await runner.runOne();
    expect(q.get(job.id)!.state).toBe("cancelled");
  });

  test("a scan is a foreground errand; art and cover are not", async () => {
    // scheduler.md: a scan the user asked for runs with no duty cap "because
    // the user asked for it and is watching". Background derivation does not.
    const seen: Record<string, boolean> = {};
    const runner = new JobRunner(q, budget(), {
      scan: async (ctx) => { seen.scan = ctx.foreground; },
      art: async (ctx) => { seen.art = ctx.foreground; },
    });
    q.enqueue({ kind: "scan", label: "Scan library" });
    await runner.runOne();
    q.enqueue({ kind: "art", scope: "s", label: "x" });
    await runner.runOne();
    expect(seen).toEqual({ scan: true, art: false });
  });

  test("the loop runs one job at a time -- parallelism lives inside a job", async () => {
    // scheduler.md specifies one worker and one shared budget. Running jobs
    // side by side would mean the concurrency cap bounds each of them
    // separately, and the cap exists to bound the mount.
    let live = 0;
    let peak = 0;
    const runner = new JobRunner(q, budget(), {
      art: async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 10));
        live--;
      },
    }, { pollMs: 5 });
    q.enqueue({ kind: "art", scope: "a", label: "a" });
    q.enqueue({ kind: "art", scope: "b", label: "b" });
    runner.start();
    await new Promise((r) => setTimeout(r, 120));
    await runner.stop();
    expect(peak).toBe(1);
    expect(q.list().every((j) => j.state === "done")).toBe(true);
  });

  test("wake starts a newly-enqueued job without waiting for the poll", async () => {
    let ran = 0;
    const runner = new JobRunner(q, budget(), { art: async () => { ran++; } }, { pollMs: 60_000 });
    runner.start();
    await new Promise((r) => setTimeout(r, 10));
    q.enqueue({ kind: "art", scope: "a", label: "a" });
    runner.wake();
    await new Promise((r) => setTimeout(r, 30));
    await runner.stop();
    expect(ran).toBe(1);
  });
});
