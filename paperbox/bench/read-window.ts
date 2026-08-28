/**
 * What one rolling-window rule costs to evaluate — the measurement register
 * entry R-11 asks for.
 *
 * R-11 says "a phone holds a useful subset", and it was unevaluable rather than
 * merely untested: read state was accepted and discarded, so "keep 10 unread"
 * could not be computed at all. It can now. This measures the half that is a
 * computer-science question.
 *
 * **It does not measure whether the answer is useful.** Whether ten unread is
 * the right shape for a real reader is a question about a person over a month,
 * not about a query over a catalogue, and nothing here touches it.
 *
 * Two scales:
 *
 *   real       the library on this box, enumerated from paperbox.json:
 *              12 series, 1,706 chapters. READ-ONLY — see readstate/import.ts.
 *   synthetic  the R-12 target: 5,000 series, 710,000 chapters, one read-state
 *              row per chapter, which is the pessimistic case for index
 *              selectivity.
 *
 * Chapter enumeration is timed and reported separately from rule evaluation,
 * because they answer different questions and the first is R-06's problem (the
 * index still lives in the sidecars, over FUSE) rather than the rule's.
 *
 *   bun run bench/read-window.ts
 *   bun run bench/read-window.ts --series 5000 --chapters 142 --db /tmp/rw.db
 *   bun run bench/read-window.ts --skip-real
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { ReadStateStore, type ProgressWrite } from "../src/readstate/store";
import { fromStore, resolveWindow, type ChapterRef } from "../src/readstate/resolver";
import { importLibrary } from "../src/readstate/import";

const argv = Bun.argv.slice(2);
const get = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};
const flag = (n: string) => argv.includes(`--${n}`);

const REAL_LIBRARY = get("library", "/mnt/user/Media/Manga-new")!;
const SERIES = Number(get("series", "5000"));
const CHAPTERS = Number(get("chapters", "142"));
const KEEP = Number(get("keep", "10"));
const DB = get("db", join(tmpdir(), "paperbox-read-window.db"))!;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

const ms = (n: number) => `${n.toFixed(3)} ms`;

function report(name: string, samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((a, b) => a + b, 0);
  console.log(
    `  ${name.padEnd(26)} n=${String(samples.length).padStart(6)}  ` +
      `p50 ${ms(percentile(sorted, 50)).padStart(10)}  p95 ${ms(percentile(sorted, 95)).padStart(10)}  ` +
      `max ${ms(percentile(sorted, 100)).padStart(10)}  total ${ms(total)}`,
  );
}

// -- The real library ------------------------------------------------------

async function realLibrary() {
  console.log(`\n=== real library: ${REAL_LIBRARY} (read-only) ===`);
  const t0 = Bun.nanoseconds();
  const { series, skipped } = await importLibrary(REAL_LIBRARY);
  const enumerateMs = (Bun.nanoseconds() - t0) / 1e6;
  const chapterCount = series.reduce((a, s) => a + s.chapters.length, 0);
  console.log(
    `  ${series.length} series, ${chapterCount} chapters` +
      (skipped.length ? `, ${skipped.length} skipped` : "") +
      ` — enumerated from paperbox.json in ${ms(enumerateMs)} (${ms(enumerateMs / Math.max(1, series.length))}/series)`,
  );

  // Seed a plausible reading position: two thirds read, one chapter open.
  const store = new ReadStateStore(":memory:");
  const writes: ProgressWrite[] = [];
  for (const s of series) {
    const ordered = [...s.chapters].sort((a, b) => a.sortKey - b.sortKey);
    const frontier = Math.floor(ordered.length * 0.66);
    ordered.forEach((c, i) => {
      writes.push({
        seriesUid: s.uid,
        chapterUid: c.uid,
        page: i < frontier ? c.pages : i === frontier ? 7 : 0,
        pages: c.pages,
        read: i < frontier,
        at: i + 1,
      });
    });
  }
  store.recordAll(writes);
  console.log(`  seeded ${writes.length} read-state rows`);

  const samples: number[] = [];
  for (let round = 0; round < 40; round++) {
    for (const s of series) {
      const t = Bun.nanoseconds();
      const r = resolveWindow(fromStore(store), { seriesUid: s.uid, chapters: s.chapters, keep: KEEP });
      samples.push((Bun.nanoseconds() - t) / 1e6);
      if (round === 0) {
        console.log(
          `    ${s.dir.slice(0, 34).padEnd(36)} ${String(s.chapters.length).padStart(4)} ch  ` +
            `window ${r.window.length}, open ${r.partRead.length}, target ${r.target.length}`,
        );
      }
    }
  }
  report("one rule", samples);
  const whole = Bun.nanoseconds();
  for (const s of series) resolveWindow(fromStore(store), { seriesUid: s.uid, chapters: s.chapters, keep: KEEP });
  console.log(`  every rule in the library (${series.length}): ${ms((Bun.nanoseconds() - whole) / 1e6)}`);
  store.close();
}

// -- The R-12 target scale -------------------------------------------------

/**
 * Chapters are generated rather than materialised for all 5,000 series: the
 * question is what one rule costs against a full catalogue, and holding
 * 710,000 chapter objects in memory would measure the generator's allocator.
 * The read-state table does hold every row.
 */
function syntheticChapters(seriesIdx: number, n: number): ChapterRef[] {
  const out: ChapterRef[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      uid: `s${seriesIdx}-c${i + 1}`,
      dir: `Chapter ${i + 1}`,
      label: `Chapter ${String(i + 1).padStart(4, "0")}`,
      sortKey: i + 1,
      sequence: "main",
      pages: 20,
    };
  }
  return out;
}

function syntheticCatalogue() {
  const total = SERIES * CHAPTERS;
  console.log(`\n=== synthetic catalogue: ${SERIES} series, ${total.toLocaleString()} chapters ===`);
  console.log(`  db: ${DB}`);
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });

  const store = new ReadStateStore(DB);
  const t0 = Bun.nanoseconds();
  // One transaction per series: 710k writes in a single transaction is one
  // enormous journal, and the point is to fill the table, not to benchmark it.
  for (let s = 0; s < SERIES; s++) {
    const frontier = Math.floor(CHAPTERS * 0.66);
    const writes: ProgressWrite[] = new Array(CHAPTERS);
    for (let i = 0; i < CHAPTERS; i++) {
      writes[i] = {
        seriesUid: `series-${s}`,
        chapterUid: `s${s}-c${i + 1}`,
        page: i < frontier ? 20 : i === frontier ? 7 : 0,
        pages: 20,
        read: i < frontier,
        at: i + 1,
      };
    }
    store.recordAll(writes);
    if (s % 500 === 0) process.stdout.write(`\r  seeding… ${s}/${SERIES}`);
  }
  const seedMs = (Bun.nanoseconds() - t0) / 1e6;
  const rows = (store.raw().query("SELECT COUNT(*) AS n FROM read_state").get() as { n: number }).n;
  console.log(`\r  seeded ${rows.toLocaleString()} rows in ${(seedMs / 1000).toFixed(1)} s`);

  // Sample series spread across the catalogue, so no single hot page can carry
  // the whole measurement.
  const picks: number[] = [];
  for (let i = 0; i < 400; i++) picks.push(Math.floor((i / 400) * SERIES));

  const prepared = new Map<number, ChapterRef[]>();
  const enumSamples: number[] = [];
  for (const s of picks) {
    const t = Bun.nanoseconds();
    prepared.set(s, syntheticChapters(s, CHAPTERS));
    enumSamples.push((Bun.nanoseconds() - t) / 1e6);
  }

  const warm = prepared.get(picks[0]!)!;
  for (let i = 0; i < 50; i++) resolveWindow(fromStore(store), { seriesUid: `series-${picks[0]}`, chapters: warm, keep: KEEP });

  const samples: number[] = [];
  for (let round = 0; round < 5; round++) {
    for (const s of picks) {
      const chapters = prepared.get(s)!;
      const t = Bun.nanoseconds();
      const r = resolveWindow(fromStore(store), { seriesUid: `series-${s}`, chapters, keep: KEEP });
      samples.push((Bun.nanoseconds() - t) / 1e6);
      if (r.window.length !== KEEP) throw new Error(`series-${s}: window was ${r.window.length}`);
    }
  }
  report("one rule", samples);
  report("chapter enumeration", enumSamples);

  // What a rules screen actually does: resolve every rule the user has.
  for (const n of [1, 10, 40, 100]) {
    const chosen = picks.slice(0, n);
    for (const s of chosen) if (!prepared.has(s)) prepared.set(s, syntheticChapters(s, CHAPTERS));
    const t = Bun.nanoseconds();
    for (const s of chosen) {
      resolveWindow(fromStore(store), { seriesUid: `series-${s}`, chapters: prepared.get(s)!, keep: KEEP });
    }
    console.log(`  ${String(n).padStart(3)} rules in one pass: ${ms((Bun.nanoseconds() - t) / 1e6)}`);
  }

  store.close();
  if (!flag("keep-db")) {
    rmSync(DB, { force: true });
    rmSync(`${DB}-wal`, { force: true });
    rmSync(`${DB}-shm`, { force: true });
  }
}

if (!flag("skip-real")) await realLibrary();
if (!flag("skip-synthetic")) syntheticCatalogue();
