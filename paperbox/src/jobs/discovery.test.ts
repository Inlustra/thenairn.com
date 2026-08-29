/**
 * The scan's discovery pass, and the height job it feeds.
 *
 * The bug under test has now shipped twice: something derived on a change
 * trigger, with no path for content that already exists. Spine art produced not
 * one picture for a 1,706-chapter library until an eager backfill was bolted
 * on; pixel height had the identical hole and was hidden inside the scan
 * instead. So the assertions here are about the *shape*, not about artwork --
 * a scan over content that has never moved must still queue every derived thing
 * that is missing, and a scan over content already derived must queue nothing.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, utimes, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { JobQueue, type Job } from "./queue";
import { Budget } from "./budget";
import { discover } from "./discover";
import { artWorker, coverWorker, heightWorker } from "./workers";
import type { JobContext } from "./runner";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let ROOT: string;
let DERIVED: string;
let prevManga: string | undefined;
let prevDerived: string | undefined;
let scanner: typeof import("../scanner");

const SERIES = ["Alpha", "Beta", "Gamma"];

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "paperbox-discover-"));
  DERIVED = await mkdtemp(join(tmpdir(), "paperbox-discover-derived-"));
  prevManga = process.env.MANGA_DIR;
  prevDerived = process.env.DERIVED_DIR;
  process.env.MANGA_DIR = ROOT;
  process.env.DERIVED_DIR = DERIVED;
  scanner = await import("../scanner");
  for (const s of SERIES) {
    const dir = join(ROOT, s, "Chapter 001");
    await mkdir(dir, { recursive: true });
    for (let i = 1; i <= 2; i++) await writeFile(join(dir, `00${i}.png`), PIXEL);
  }
});

afterAll(async () => {
  scanner.onScanned(null);
  if (prevManga === undefined) delete process.env.MANGA_DIR;
  else process.env.MANGA_DIR = prevManga;
  if (prevDerived === undefined) delete process.env.DERIVED_DIR;
  else process.env.DERIVED_DIR = prevDerived;
  await rm(ROOT, { recursive: true, force: true });
  await rm(DERIVED, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.MANGA_DIR = ROOT;
  process.env.DERIVED_DIR = DERIVED;
});

/** Wire discovery to the scan exactly as `startJobs` does, minus the runner. */
async function scanWithDiscovery(queue: JobQueue) {
  scanner.onScanned(async (scope) => {
    await discover(queue, scope);
  });
  try {
    await scanner.scan();
  } finally {
    scanner.onScanned(null);
  }
}

const uidOf = (title: string) => scanner.getMangaList().find((m) => m.title === title)!.uid;
const kinds = (jobs: Job[]) => jobs.map((j) => j.kind).sort();

describe("a scan is what notices derived work is missing", () => {
  test("a library that has never changed still queues every artefact it lacks", async () => {
    // The failure this guards, twice over: artwork was only ever enqueued from
    // the scheduler's `onChange`, which fires when a series *moves*. A library
    // that already exists never moves, so it derived nothing. Pixel height had
    // the same hole and never got a backfill at all.
    const q = new JobQueue(":memory:");
    await scanWithDiscovery(q);
    for (const s of SERIES) {
      const mine = q.listAll().filter((j) => j.scope === uidOf(s));
      expect(kinds(mine)).toEqual(["art", "cover", "height"]);
    }
    q.close();
  });

  test("the scan itself computes no pixel height -- it opens no file", async () => {
    // `docs/scheduler.md` prices the quick tier at 1.218 ms per chapter
    // *because* it never opens a page. Measuring height inline made that
    // costing false and put 24M header reads at target on the scan's critical
    // path. The scan records what is free; a job records the rest.
    const q = new JobQueue(":memory:");
    await scanWithDiscovery(q);
    expect(scanner.getManga("alpha")!.chapters.every((c) => c.pixelHeight === undefined)).toBe(true);
    q.close();
  });
});

describe("the height job", () => {
  test("measures, normalizes and persists -- and the next scan asks for nothing", async () => {
    const q = new JobQueue(":memory:");
    await scanWithDiscovery(q);
    await heightWorker(ctx(q.enqueue({ kind: "height", scope: uidOf("Alpha"), label: "Alpha" })));

    // Fixture pages are 1x1 px; normalized to a 1000px-wide page each counts
    // 1000, so the chapter totals pageCount x 1000.
    const chapter = scanner.getManga("alpha")!.chapters[0]!;
    expect(chapter.pixelHeight).toBe(chapter.pageCount * 1000);
    // Persisted, not merely held: the sidecar carries it, so a restart does not
    // re-read every header in the library.
    const meta = JSON.parse(await readFile(join(ROOT, "Alpha", "paperbox.json"), "utf-8"));
    expect(meta.chapters["Chapter 001"].pixelHeight).toBe(chapter.pageCount * 1000);

    const fresh = new JobQueue(":memory:");
    await scanWithDiscovery(fresh);
    expect(fresh.listAll().some((j) => j.kind === "height" && j.scope === uidOf("Alpha"))).toBe(false);
    fresh.close();
    q.close();
  });

  test("a restore that moves mtime but not one byte does not ask for it again", async () => {
    // `docs/decisions.md`: mtime is a cache key, never truth. A backup restore
    // moves every chapter's mtime and changes no content, so the fingerprint
    // recomputes to the value it already had -- and invalidating the height on
    // the *trigger* rather than on an actual change would bill 24M header reads
    // for a change that did not happen.
    const when = new Date(Date.now() + 60_000);
    await utimes(join(ROOT, "Alpha", "Chapter 001"), when, when);

    const q = new JobQueue(":memory:");
    await scanWithDiscovery(q);
    expect(scanner.getManga("alpha")!.chapters[0]!.pixelHeight).toBeGreaterThan(0);
    expect(q.listAll().some((j) => j.kind === "height" && j.scope === uidOf("Alpha"))).toBe(false);
    q.close();
  });

  test("content that actually moved loses its height, and is measured again", async () => {
    await writeFile(join(ROOT, "Alpha", "Chapter 001", "003.png"), PIXEL);
    const q = new JobQueue(":memory:");
    await scanWithDiscovery(q);
    expect(scanner.getManga("alpha")!.chapters[0]!.pixelHeight).toBeUndefined();

    const job = q.listAll().find((j) => j.kind === "height" && j.scope === uidOf("Alpha"));
    expect(job).toBeTruthy();
    await heightWorker(ctx(job!));
    expect(scanner.getManga("alpha")!.chapters[0]!.pixelHeight).toBe(3000);

    await rm(join(ROOT, "Alpha", "Chapter 001", "003.png"), { force: true });
    q.close();
  });
});

describe("discovery settles", () => {
  test("once the work is actually done, further scans queue nothing at all", async () => {
    // Asserting on an unchanged queue length while the first ask is still
    // pending proves nothing: the partial unique index would hide a pass that
    // re-asked for everything, every time. So run the work, finish the jobs to
    // clear the index, and only then scan again.
    const q = new JobQueue(":memory:");
    await scanWithDiscovery(q);
    const first = q.listAll();
    expect(first.length).toBeGreaterThan(0);

    const handlers = { art: artWorker, cover: coverWorker, height: heightWorker };
    for (const job of first) {
      const handler = handlers[job.kind as keyof typeof handlers];
      if (handler) await handler(ctx(job));
    }
    for (let claimed = q.claim(); claimed; claimed = q.claim()) q.finish(claimed.id);
    expect(q.listAll().every((j) => j.state === "done")).toBe(true);

    // Twice, because a pass that settles on the second scan and not the third
    // is not settled; it is oscillating.
    await scanWithDiscovery(q);
    await scanWithDiscovery(q);
    expect(q.listAll().filter((j) => j.state === "queued")).toEqual([]);
    q.close();
  });
});

/** A context for driving one worker directly, without a runner or a loop. */
function ctx(job: Job): JobContext {
  return {
    job,
    progress: () => {},
    cancelled: () => false,
    budget: new Budget({ concurrency: 2, restDuty: 1, sleep: async () => {} }),
    foreground: false,
    silent: false,
  };
}
