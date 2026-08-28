import { describe, expect, test } from "bun:test";
import { ReadStateStore } from "./store";
import { fromStore, resolveWindow, type ChapterRef } from "./resolver";
import type { ProgressWrite } from "./store";

/**
 * The property that decides whether rules are viable at the R-12 target of
 * ~5,000 series / ~710,000 chapters: **a rule costs what its series costs, not
 * what the catalogue costs.**
 *
 * If it were catalogue-bounded, every rule row in the UI would get slower as
 * the library grew, and `rules.md`'s "a rule must show what it currently
 * resolves to" would stop being renderable. This asserts it two ways -- the
 * query plan, which is exact, and a timing ratio, which is the thing a reader
 * would actually notice.
 */

const CHAPTERS_PER_SERIES = 200;

function chapters(seriesIdx: number): ChapterRef[] {
  return Array.from({ length: CHAPTERS_PER_SERIES }, (_, i) => ({
    uid: `s${seriesIdx}-c${i + 1}`,
    dir: `Chapter ${i + 1}`,
    label: `Chapter ${String(i + 1).padStart(4, "0")}`,
    sortKey: i + 1,
    sequence: "main",
    pages: 40,
  }));
}

/** A catalogue where every chapter of every series carries a row. */
function catalogue(seriesCount: number): ReadStateStore {
  const store = new ReadStateStore(":memory:");
  const writes: ProgressWrite[] = [];
  for (let s = 0; s < seriesCount; s++) {
    for (let i = 1; i <= CHAPTERS_PER_SERIES; i++) {
      // Two thirds read, so the window has somewhere to sit. The remaining
      // third still gets a row -- a row at page 0 classifies unread -- so the
      // table holds one row per chapter of the whole catalogue, which is the
      // pessimistic case for index selectivity.
      const read = i <= Math.floor(CHAPTERS_PER_SERIES * 0.66);
      writes.push({
        seriesUid: `series-${s}`,
        chapterUid: `s${s}-c${i}`,
        page: read ? 40 : 0,
        pages: 40,
        read,
        at: i,
      });
    }
  }
  store.recordAll(writes);
  return store;
}

function timeRule(store: ReadStateStore, seriesIdx: number, runs: number): number {
  const refs = chapters(seriesIdx);
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = Bun.nanoseconds();
    const r = resolveWindow(fromStore(store), { seriesUid: `series-${seriesIdx}`, chapters: refs, keep: 10 });
    samples.push(Bun.nanoseconds() - t);
    if (r.window.length !== 10) throw new Error("window did not resolve");
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]! / 1e6;
}

describe("a rule costs what its series costs", () => {
  test("the series query is an index SEARCH, never a table SCAN", () => {
    const store = catalogue(4);
    const plan = store
      .raw()
      .query("EXPLAIN QUERY PLAN SELECT * FROM read_state WHERE reader = ? AND series_uid = ?")
      .all("default", "series-0") as Array<{ detail: string }>;
    const detail = plan.map((p) => p.detail).join(" | ");
    // A SCAN here would mean every rule reads the whole catalogue, and the cost
    // of "keep 10 unread of Nano Machine" would grow with the other 4,999
    // series the reader did not ask about.
    expect(detail).toContain("SEARCH");
    expect(detail).toContain("read_state");
    expect(detail).not.toContain("SCAN read_state");
    store.close();
  });

  test("a 50x larger catalogue does not make one rule meaningfully slower", () => {
    const small = catalogue(20); //     4,000 rows
    const large = catalogue(1_000); // 200,000 rows

    // Warm both, then take medians: the claim is about the steady state a
    // reader sees, not about a cold first query.
    timeRule(small, 0, 20);
    timeRule(large, 0, 20);
    const smallMs = timeRule(small, 0, 51);
    const largeMs = timeRule(large, 0, 51);

    // Deliberately loose. The assertion is "bounded by series, not catalogue",
    // and a 50x catalogue costing under 4x would already be nothing like
    // linear -- a tighter bound would only buy flakiness on a shared box.
    expect(largeMs / smallMs).toBeLessThan(4);
    console.log(
      `[scale] one rule over ${CHAPTERS_PER_SERIES} chapters: ` +
        `${smallMs.toFixed(3)} ms at 20 series, ${largeMs.toFixed(3)} ms at 1,000 series ` +
        `(${(largeMs / smallMs).toFixed(2)}x for a 50x catalogue)`,
    );
    small.close();
    large.close();
  }, 60_000);
});
