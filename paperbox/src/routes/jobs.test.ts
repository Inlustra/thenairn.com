import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { jobRoutes } from "./jobs";
import { JobQueue } from "../jobs";
import { configureJobs } from "../jobs";

let q: JobQueue;
let prev: JobQueue | null;

const call = (path: string, init: RequestInit = {}) =>
  jobRoutes.handle(new Request(`http://localhost${path}`, init));

beforeEach(() => {
  q = new JobQueue(":memory:");
  prev = configureJobs(q);
});

afterEach(() => {
  configureJobs(prev);
  q.close();
});

describe("GET /api/jobs", () => {
  test("returns the documented envelope", async () => {
    q.enqueue({ kind: "art", scope: "series-uid", label: "Nano Machine", total: 313 });
    const res = await call("/api/jobs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: any[]; running: number; queued: number };
    expect(body.running).toBe(0);
    expect(body.queued).toBe(1);
    expect(body.jobs[0]).toMatchObject({
      kind: "art",
      scope: "series-uid",
      label: "Nano Machine",
      state: "queued",
      done: 0,
      total: 313,
      startedAt: null,
      finishedAt: null,
      error: null,
    });
  });

  test("is empty and well-formed before anything has been asked for", async () => {
    const body = (await (await call("/api/jobs")).json()) as { jobs: unknown[] };
    expect(body.jobs).toEqual([]);
  });

  test("the rolling scan is a job, and this route still shows nothing", async () => {
    // docs/scheduler.md section 3: "Scan running, nobody asked -> Nothing. No
    // spinner, no ambient seam, no count." The rotation is in the queue now, so
    // this is the assertion that the change was structural and not visible.
    const before = (await call("/api/jobs")).headers.get("etag");
    q.enqueue({ kind: "scan", scope: "series-uid", label: "Nano Machine", silent: true });
    q.claim();
    const res = await call("/api/jobs");
    const body = (await res.json()) as { jobs: unknown[]; running: number; queued: number };
    expect(body).toEqual({ jobs: [], running: 0, queued: 0 });
    // And a poll during the whole rotation still revalidates to 304.
    expect(res.headers.get("etag")).toBe(before);
  });

  test("carries a weak etag and revalidates to 304, like /api/status", async () => {
    q.enqueue({ kind: "art", scope: "s", label: "x" });
    const first = await call("/api/jobs");
    const etag = first.headers.get("etag")!;
    expect(etag.startsWith('W/"jobs-')).toBe(true);
    const second = await call("/api/jobs", { headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
  });

  test("the etag moves when progress moves, though no count changes", async () => {
    const job = q.enqueue({ kind: "art", scope: "s", label: "x", total: 10 });
    q.claim();
    const before = (await call("/api/jobs")).headers.get("etag");
    q.progress(job.id, 4);
    expect((await call("/api/jobs")).headers.get("etag")).not.toBe(before);
  });

  test("running work sorts ahead of finished work", async () => {
    const done = q.enqueue({ kind: "cover", scope: "a", label: "a" });
    q.claim();
    q.finish(done.id);
    q.enqueue({ kind: "art", scope: "b", label: "b" });
    q.claim();
    const body = (await (await call("/api/jobs")).json()) as { jobs: { state: string }[] };
    expect(body.jobs[0]!.state).toBe("running");
  });
});

describe("POST /api/jobs/:id/cancel", () => {
  test("cancels and answers { ok: true }", async () => {
    const job = q.enqueue({ kind: "art", scope: "s", label: "x" });
    const res = await call(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(q.get(job.id)!.state).toBe("cancelled");
  });

  test("is idempotent -- cancelling twice is not an error the user must resolve", async () => {
    const job = q.enqueue({ kind: "art", scope: "s", label: "x" });
    await call(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    const again = await call(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    expect(await again.json()).toEqual({ ok: true });
  });

  test("an unknown id is a 404, because that is a client bug and not weather", async () => {
    const res = await call("/api/jobs/job-nope/cancel", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/jobs/art", () => {
  test("queues artwork for one series and deduplicates repeated asks", async () => {
    const a = (await (
      await call("/api/jobs/art", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "series-uid", label: "Nano Machine" }),
      })
    ).json()) as { id: string };
    const b = (await (
      await call("/api/jobs/art", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "series-uid", label: "Nano Machine" }),
      })
    ).json()) as { id: string };
    expect(b.id).toBe(a.id);
    expect(q.list().length).toBe(1);
  });
});

describe("when background work is disabled", () => {
  test("the endpoint degrades rather than throwing", async () => {
    configureJobs(null);
    const res = await call("/api/jobs");
    expect(res.status).toBe(503);
    expect((await res.json()).jobs).toEqual([]);
  });
});
