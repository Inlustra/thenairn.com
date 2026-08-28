import { describe, expect, test } from "bun:test";
import { ReadStateStore } from "./store";
import { fromStore, resolveWindow, ruleSentence, type ChapterRef } from "./resolver";

const S = "p-nano-machine";

/** A plain 1..n main-sequence series, the shape most of the real library has. */
function series(n: number, sequence = "main", offset = 0): ChapterRef[] {
  return Array.from({ length: n }, (_, i) => ({
    uid: `${sequence}-${i + 1 + offset}`,
    dir: `Chapter ${String(i + 1 + offset).padStart(3, "0")}`,
    label: `Chapter ${String(i + 1 + offset).padStart(3, "0")}`,
    sortKey: i + 1 + offset,
    sequence,
    pages: 40,
  }));
}

const labels = (refs: ChapterRef[]) => refs.map((c) => c.sortKey);

function store(): ReadStateStore {
  return new ReadStateStore(":memory:");
}

function markRead(s: ReadStateStore, upTo: number, seq = "main") {
  for (let i = 1; i <= upTo; i++) s.record({ seriesUid: S, chapterUid: `${seq}-${i}`, read: true, at: i });
}

describe("next vs latest", () => {
  test("a reader 60 behind gets the ten they can open, not the ten most recent", () => {
    const s = store();
    const chapters = series(100);
    markRead(s, 60);

    const next = resolveWindow(fromStore(s), { seriesUid: S, chapters, keep: 10, mode: "next" });
    const latest = resolveWindow(fromStore(s), { seriesUid: S, chapters, keep: 10, mode: "latest" });

    expect(labels(next.window)).toEqual([61, 62, 63, 64, 65, 66, 67, 68, 69, 70]);
    expect(labels(latest.window)).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
    // The whole argument for the default: `latest` holds ten chapters whose
    // first readable predecessor is thirty chapters away.
    expect(latest.window[0]!.sortKey - 60).toBeGreaterThan(10);
    s.close();
  });

  test("next is the default", () => {
    const s = store();
    markRead(s, 60);
    const r = resolveWindow(fromStore(s), { seriesUid: S, chapters: series(100), keep: 10 });
    expect(r.mode).toBe("next");
    expect(labels(r.window)).toEqual([61, 62, 63, 64, 65, 66, 67, 68, 69, 70]);
    s.close();
  });

  test("for a caught-up reader the two modes agree exactly", () => {
    const s = store();
    const chapters = series(100);
    markRead(s, 96); // four unread, fewer than the window
    const next = resolveWindow(fromStore(s), { seriesUid: S, chapters, keep: 10, mode: "next" });
    const latest = resolveWindow(fromStore(s), { seriesUid: S, chapters, keep: 10, mode: "latest" });
    expect(labels(next.window)).toEqual([97, 98, 99, 100]);
    expect(labels(latest.window)).toEqual(labels(next.window));
    s.close();
  });

  test("a fresh series has no read rows and still resolves", () => {
    const s = store();
    const r = resolveWindow(fromStore(s), { seriesUid: S, chapters: series(100), keep: 10 });
    expect(labels(r.window)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.counts).toEqual({ chapters: 100, unread: 100, partRead: 0, read: 0 });
    s.close();
  });
});

describe("the part-read chapter sits outside the quota", () => {
  test('"keep 10" holds 10, or 11 while one is open', () => {
    const s = store();
    const chapters = series(100);
    markRead(s, 60);

    const before = resolveWindow(fromStore(s), { seriesUid: S, chapters, keep: 10 });
    expect(before.target).toHaveLength(10);

    // The reader opens chapter 61.
    s.record({ seriesUid: S, chapterUid: "main-61", page: 7, pages: 40, at: 5_000 });
    const after = resolveWindow(fromStore(s), { seriesUid: S, chapters, keep: 10 });

    expect(after.counts.partRead).toBe(1);
    expect(labels(after.partRead)).toEqual([61]);
    // Ten *unread* chapters, plus the open one. Not eleven unread, not nine.
    expect(after.window).toHaveLength(10);
    expect(labels(after.window)).toEqual([62, 63, 64, 65, 66, 67, 68, 69, 70, 71]);
    expect(after.target).toHaveLength(11);
    expect(labels(after.target)).toEqual([61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]);
    s.close();
  });

  test("opening a chapter never makes it an eviction candidate", () => {
    // The bug in the other two-state collapse: count part-read as read and the
    // file you are halfway through is deletable under storage pressure.
    const s = store();
    const chapters = series(100);
    markRead(s, 60);
    s.record({ seriesUid: S, chapterUid: "main-61", page: 7, pages: 40, at: 5_000 });

    const held = chapters.slice(60, 70).map((c) => c.uid); // 61..70
    const r = resolveWindow(fromStore(s), { seriesUid: S, chapters, keep: 10, held });
    expect(labels(r.evictCandidates)).toEqual([]);
    expect(r.target.map((c) => c.uid)).toContain("main-61");
    s.close();
  });

  test("opening a chapter evicts nothing that was already held", () => {
    // The bug in the first two-state collapse: count part-read as unread and it
    // occupies a slot in its own window, so the far edge retreats every time
    // the reader opens something and advances when they close it.
    const s = store();
    const chapters = series(100);
    markRead(s, 60);
    const first = resolveWindow(fromStore(s), { seriesUid: S, chapters, keep: 10 });
    const held = first.target.map((c) => c.uid);

    s.record({ seriesUid: S, chapterUid: "main-61", page: 7, pages: 40, at: 5_000 });
    const second = resolveWindow(fromStore(s), { seriesUid: S, chapters, keep: 10, held });

    expect(second.evictCandidates).toEqual([]);
    expect(labels(second.missing)).toEqual([71]); // one fetch forward, no churn
    s.close();
  });

  test("finishing a chapter releases it and pulls the next one in", () => {
    const s = store();
    const chapters = series(100);
    markRead(s, 60);
    s.record({ seriesUid: S, chapterUid: "main-61", page: 7, pages: 40, at: 5_000 });
    const held = ["main-61", ...chapters.slice(61, 71).map((c) => c.uid)]; // 61..71

    s.record({ seriesUid: S, chapterUid: "main-61", read: true, at: 6_000 });
    const r = resolveWindow(fromStore(s), { seriesUid: S, chapters, keep: 10, held });

    expect(labels(r.evictCandidates)).toEqual([61]);
    expect(r.target).toHaveLength(10);
    s.close();
  });
});

describe("evictCandidates is a list, not an instruction", () => {
  test("it names what falls outside the target and nothing else", () => {
    const s = store();
    const chapters = series(100);
    markRead(s, 60);
    const held = [...chapters.slice(0, 5).map((c) => c.uid), ...chapters.slice(60, 65).map((c) => c.uid)];
    const r = resolveWindow(fromStore(s), { seriesUid: S, chapters, keep: 10, held });
    // 1..5 are read and outside the window; 61..65 are in it.
    expect(labels(r.evictCandidates)).toEqual([1, 2, 3, 4, 5]);
    // And the result carries no verb: adds-only and rolling-window are both
    // still implementable from this, which is the point while the
    // contradiction in rules.md is open.
    expect(Object.keys(r)).not.toContain("evict");
    expect(Object.keys(r)).not.toContain("delete");
    s.close();
  });

  test("a held id this series does not contain is never proposed for eviction", () => {
    // A held id the chapter list does not mention is much more likely a scan
    // that has not run than a chapter that should be deleted.
    const s = store();
    const r = resolveWindow(fromStore(s), {
      seriesUid: S,
      chapters: series(20),
      keep: 5,
      held: ["main-1", "a-chapter-we-cannot-see"],
    });
    expect(r.evictCandidates).toEqual([]);
    s.close();
  });
});

describe("reading order", () => {
  test("a spin-off is a separate run, not interleaved by number", () => {
    // R-28: `Episode 001` and `Spin-off #001` are both legitimately chapter 1.
    const s = store();
    const chapters = [...series(5), ...series(3, "spin-off")];
    const r = resolveWindow(fromStore(s), { seriesUid: S, chapters, keep: 6 });
    expect(r.window.map((c) => `${c.sequence}-${c.sortKey}`)).toEqual([
      "main-1", "main-2", "main-3", "main-4", "main-5", "spin-off-1",
    ]);
    s.close();
  });

  test("keep 0 holds nothing unread but still holds what is open", () => {
    const s = store();
    const chapters = series(10);
    s.record({ seriesUid: S, chapterUid: "main-3", page: 2, at: 1 });
    const r = resolveWindow(fromStore(s), { seriesUid: S, chapters, keep: 0 });
    expect(r.window).toEqual([]);
    expect(labels(r.target)).toEqual([3]);
    s.close();
  });
});

describe("ruleSentence", () => {
  test("says what the rule currently resolves to", () => {
    const s = store();
    markRead(s, 60);
    const r = resolveWindow(fromStore(s), { seriesUid: S, chapters: series(100), keep: 10 });
    expect(ruleSentence(r)).toBe("keep 10 unread (next) — 10 chapters: Chapter 061 … Chapter 070");
    s.close();
  });
});
