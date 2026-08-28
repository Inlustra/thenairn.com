import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let ROOT: string;
let DERIVED: string;
let prevManga: string | undefined;
let prevDerived: string | undefined;
let scanner: typeof import("../scanner");
let jobs: typeof import("./handle");

const SERIES = ["Alpha", "Beta", "Gamma"];

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "paperbox-backfill-"));
  DERIVED = await mkdtemp(join(tmpdir(), "paperbox-backfill-derived-"));
  prevManga = process.env.MANGA_DIR;
  prevDerived = process.env.DERIVED_DIR;
  process.env.MANGA_DIR = ROOT;
  process.env.DERIVED_DIR = DERIVED;

  scanner = await import("../scanner");
  for (const s of SERIES) {
    const dir = join(ROOT, s, "Chapter 001");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "001.png"), PIXEL);
  }
  await scanner.scan();

  jobs = await import("./handle");
});

afterAll(async () => {
  jobs?.stopJobs?.();
  if (prevManga === undefined) delete process.env.MANGA_DIR;
  else process.env.MANGA_DIR = prevManga;
  if (prevDerived === undefined) delete process.env.DERIVED_DIR;
  else process.env.DERIVED_DIR = prevDerived;
  await rm(ROOT, { recursive: true, force: true });
  await rm(DERIVED, { recursive: true, force: true });
});

describe("artwork backfill", () => {
  test("a library that has never had artwork derives it without waiting for a change", async () => {
    // The bug this guards: artwork was only ever enqueued from the scheduler's
    // `onChange`, which fires when a series *moves*. A library that already
    // exists never moves, so it derived nothing -- 12 series and 1,706 real
    // chapters produced not one spine.
    //
    // Leaving it to the rotation is not a fix either: `intervalMs` is
    // `deadline / seriesCount`, so a small library takes the whole six-hour
    // deadline merely to notice. Discovery must be eager; only extraction is
    // paced.
    const queue = jobs.startJobs({ scheduler: false });
    expect(queue).not.toBeNull();

    const queued = await jobs.backfillArt();
    expect(queued).toBe(SERIES.length);

    const scopes = new Set(queue!.list().map((j) => j.scope));
    for (const s of SERIES) {
      const uid = scanner.getMangaList().find((m) => m.title === s)?.uid;
      expect(uid).toBeTruthy();
      expect(scopes.has(uid!)).toBe(true);
    }
  });

  test("it is idempotent: a second pass queues nothing new for the same work", async () => {
    // The pass runs on every boot, so it has to settle to no-ops rather than
    // pile up a duplicate job per restart.
    const queue = jobs.startJobs({ scheduler: false })!;
    await jobs.backfillArt();
    const afterFirst = queue.list().length;
    await jobs.backfillArt();
    await jobs.backfillArt();
    // The count backfillArt returns is enqueue *attempts*; what must not grow
    // is the queue itself. Asserting on the return value passes on 3 <= 3 while
    // three duplicate jobs pile up per boot.
    expect(queue.list().length).toBe(afterFirst);
  });
});
