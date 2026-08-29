import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { JobQueue } from "./queue";

let dir: string;
let path: string;
let q: JobQueue;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paperbox-jobs-"));
  path = join(dir, "jobs.db");
  q = new JobQueue(path);
});

afterEach(async () => {
  q.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the wire shape", () => {
  test("is exactly the contract clients code against", () => {
    const job = q.enqueue({ kind: "art", scope: "series-uid", label: "Nano Machine" });
    expect(Object.keys(job).sort()).toEqual(
      ["done", "error", "finishedAt", "id", "kind", "label", "scope", "startedAt", "state", "total"].sort(),
    );
    expect(job.state).toBe("queued");
    expect(job.done).toBe(0);
    expect(job.startedAt).toBeNull();
    expect(job.finishedAt).toBeNull();
    expect(job.error).toBeNull();
  });

  test("total is null while unknown, never 0 -- 0/0 renders as NaN", () => {
    expect(q.enqueue({ kind: "art", scope: "s", label: "x" }).total).toBeNull();
    const withTotal = q.enqueue({ kind: "cover", scope: "s", label: "x", total: 12 });
    expect(withTotal.total).toBe(12);
  });

  test("scope is null for library-wide work", () => {
    expect(q.enqueue({ kind: "scan", label: "Scan library" }).scope).toBeNull();
  });

  test("error is populated only on failure", () => {
    const job = q.enqueue({ kind: "art", scope: "s", label: "x" });
    q.claim();
    q.cancel(job.id);
    q.finish(job.id);
    expect(q.get(job.id)!.state).toBe("cancelled");
    expect(q.get(job.id)!.error).toBeNull();
  });
});

describe("jobs survive a restart", () => {
  test("a queued job is still there after reopening the database", () => {
    q.enqueue({ kind: "art", scope: "s1", label: "Nano Machine" });
    q.close();
    q = new JobQueue(path);
    expect(q.list().map((j) => j.label)).toEqual(["Nano Machine"]);
  });

  test("a job that was running comes back queued, not failed, keeping its progress", () => {
    // Nothing went wrong with the work; it simply did not happen. This is the
    // failure mode the in-memory download `Map` has, where a restart loses the
    // task outright with no record it was ever asked for.
    const job = q.enqueue({ kind: "art", scope: "s1", label: "Nano Machine", total: 300 });
    q.claim();
    q.progress(job.id, 120);
    expect(q.get(job.id)!.state).toBe("running");

    q.close();
    q = new JobQueue(path);

    const back = q.get(job.id)!;
    expect(back.state).toBe("queued");
    expect(back.done).toBe(120);
    expect(back.startedAt).toBeNull();
  });
});

describe("deduplication", () => {
  test("asking twice for one series' artwork queues it once", () => {
    const a = q.enqueue({ kind: "art", scope: "s1", label: "Nano Machine" });
    const b = q.enqueue({ kind: "art", scope: "s1", label: "Nano Machine" });
    expect(b.id).toBe(a.id);
    expect(q.list().length).toBe(1);
  });

  test("...including while it is already running", () => {
    const a = q.enqueue({ kind: "art", scope: "s1", label: "x" });
    q.claim();
    expect(q.enqueue({ kind: "art", scope: "s1", label: "x" }).id).toBe(a.id);
  });

  test("but a finished job does not block the next one", () => {
    const a = q.enqueue({ kind: "art", scope: "s1", label: "x" });
    q.claim();
    q.finish(a.id);
    const b = q.enqueue({ kind: "art", scope: "s1", label: "x" });
    expect(b.id).not.toBe(a.id);
  });

  test("two library-wide jobs of one kind are the same job, despite SQL NULL semantics", () => {
    const a = q.enqueue({ kind: "scan", label: "Scan library" });
    const b = q.enqueue({ kind: "scan", scope: null, label: "Scan library" });
    expect(b.id).toBe(a.id);
  });

  test("different kinds on one series are different jobs", () => {
    const a = q.enqueue({ kind: "art", scope: "s1", label: "x" });
    const b = q.enqueue({ kind: "cover", scope: "s1", label: "x" });
    expect(b.id).not.toBe(a.id);
  });
});

describe("work nobody asked for", () => {
  test("a silent job runs, and is invisible to every client", () => {
    // docs/scheduler.md section 3: a scan nobody asked for gets no spinner, no
    // ambient seam and no count. That is a *presentation* rule, so it is a flag
    // on the row rather than a second scheduler: the job is queued, claimable
    // and paced like any other, and is simply absent from what a client sees.
    const silent = q.enqueue({ kind: "scan", scope: "s1", label: "Alpha", silent: true });
    expect(q.list()).toEqual([]);
    expect(q.listAll().map((j) => j.id)).toEqual([silent.id]);
    expect(q.counts()).toEqual({ running: 0, queued: 0 });
    expect(q.claim()!.id).toBe(silent.id);
  });

  test("it cannot move the etag, so a whole rotation still costs a 304", () => {
    const before = q.signature();
    const job = q.enqueue({ kind: "scan", scope: "s1", label: "Alpha", silent: true });
    q.claim();
    q.progress(job.id, 3, 12);
    expect(q.signature()).toBe(before);
  });

  test("asking for the same work by hand promotes it, rather than being swallowed", () => {
    // Otherwise a rotation that queued a scan of this series one second earlier
    // eats the user's "look at it now": the work happens, and nothing ever
    // appears. Deduplication may only ever promote, never demote.
    const silent = q.enqueue({ kind: "scan", scope: "s1", label: "Alpha", silent: true });
    const asked = q.enqueue({ kind: "scan", scope: "s1", label: "Alpha" });
    expect(asked.id).toBe(silent.id);
    expect(q.list().map((j) => j.id)).toEqual([silent.id]);
    expect(q.isSilent(silent.id)).toBe(false);
  });

  test("the rotation cannot un-ask for something the user asked for", () => {
    const asked = q.enqueue({ kind: "scan", scope: "s1", label: "Alpha" });
    q.enqueue({ kind: "scan", scope: "s1", label: "Alpha", silent: true });
    expect(q.isSilent(asked.id)).toBe(false);
    expect(q.list().length).toBe(1);
  });

  test("survives a restart still silent, and still queued", () => {
    const job = q.enqueue({ kind: "scan", scope: "s1", label: "Alpha", silent: true });
    q.claim();
    expect(q.recover()).toBe(1);
    expect(q.get(job.id)!.state).toBe("queued");
    expect(q.isSilent(job.id)).toBe(true);
    expect(q.list()).toEqual([]);
  });
});

describe("claiming", () => {
  test("takes the oldest queued job and marks it running", () => {
    const first = q.enqueue({ kind: "art", scope: "a", label: "a" });
    q.enqueue({ kind: "art", scope: "b", label: "b" });
    const claimed = q.claim()!;
    expect(claimed.id).toBe(first.id);
    expect(claimed.state).toBe("running");
    expect(claimed.startedAt).not.toBeNull();
  });

  test("never hands the same job to two callers", () => {
    q.enqueue({ kind: "art", scope: "a", label: "a" });
    const a = q.claim();
    const b = q.claim();
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  test("returns null on an empty queue", () => {
    expect(q.claim()).toBeNull();
  });
});

describe("cancellation", () => {
  test("a queued job is cancelled outright", () => {
    const job = q.enqueue({ kind: "art", scope: "a", label: "a" });
    expect(q.cancel(job.id)).toBe(true);
    expect(q.get(job.id)!.state).toBe("cancelled");
    expect(q.claim()).toBeNull();
  });

  test("a running job is flagged, and the worker sees it between units", () => {
    const job = q.enqueue({ kind: "art", scope: "a", label: "a" });
    q.claim();
    expect(q.cancel(job.id)).toBe(true);
    // Still running: the flag is observed at unit granularity, which is what
    // keeps a half-written artefact impossible.
    expect(q.get(job.id)!.state).toBe("running");
    expect(q.isCancelled(job.id)).toBe(true);
  });

  test("a cancelled job that stops finishes as cancelled, never as done", () => {
    const job = q.enqueue({ kind: "art", scope: "a", label: "a" });
    q.claim();
    q.cancel(job.id);
    q.finish(job.id);
    expect(q.get(job.id)!.state).toBe("cancelled");
  });

  test("cancelling an unknown or finished job reports false rather than throwing", () => {
    expect(q.cancel("job-nope")).toBe(false);
  });
});

describe("the signature", () => {
  test("is derived from content, so an unchanged queue revalidates as 304", () => {
    const job = q.enqueue({ kind: "art", scope: "a", label: "a" });
    const before = q.signature();
    expect(q.signature()).toBe(before);
    q.claim();
    q.progress(job.id, 5);
    expect(q.signature()).not.toBe(before);
  });

  test("moves when progress moves, even though no count changes", () => {
    const job = q.enqueue({ kind: "art", scope: "a", label: "a", total: 100 });
    q.claim();
    q.progress(job.id, 10);
    const a = q.signature();
    q.progress(job.id, 11);
    expect(q.signature()).not.toBe(a);
  });
});

describe("counts and pruning", () => {
  test("counts running and queued", () => {
    q.enqueue({ kind: "art", scope: "a", label: "a" });
    q.enqueue({ kind: "art", scope: "b", label: "b" });
    q.claim();
    expect(q.counts()).toEqual({ running: 1, queued: 1 });
  });

  test("keeps recent finished work so 'did that run?' is answerable", () => {
    const job = q.enqueue({ kind: "art", scope: "a", label: "a" });
    q.claim();
    q.finish(job.id);
    q.prune();
    expect(q.get(job.id)).not.toBeNull();
  });

  test("drops old finished work beyond the retained window", () => {
    const job = q.enqueue({ kind: "art", scope: "a", label: "a" });
    q.claim();
    q.finish(job.id);
    // Far enough in the future that the retention window has passed. The
    // most-recent floor still applies, so fill past it first.
    for (let i = 0; i < 60; i++) {
      const j = q.enqueue({ kind: "art", scope: `s${i}`, label: `s${i}` });
      q.claim();
      q.finish(j.id);
    }
    q.prune(Date.now() + 7 * 60 * 60 * 1000);
    expect(q.get(job.id)).toBeNull();
  });
});
