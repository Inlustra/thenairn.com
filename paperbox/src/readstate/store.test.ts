import { describe, expect, test } from "bun:test";
import { ReadStateStore, DEFAULT_READER, classify, assertOutsideLibrary } from "./store";
import type { ProgressWrite } from "./store";

const S = "p-series";
const C = "p-chapter";

function fresh(): ReadStateStore {
  return new ReadStateStore(":memory:", { libraryRoot: undefined });
}

/** Every ordering of `items`. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i]!, ...p]);
  }
  return out;
}

describe("merge", () => {
  // The property the whole design rests on: max-merge is commutative,
  // associative and idempotent, so the order replicas reconnect in cannot
  // change the answer. Asserted by brute force rather than by argument.
  const writes: ProgressWrite[] = [
    { seriesUid: S, chapterUid: C, page: 12, pages: 40, at: 100 },
    { seriesUid: S, chapterUid: C, page: 190, pages: 200, at: 50 },
    { seriesUid: S, chapterUid: C, read: true, at: 200 },
    { seriesUid: S, chapterUid: C, read: false, at: 300 },
  ];

  test("order of arrival cannot change the result", () => {
    const results = permutations(writes).map((order) => {
      const s = fresh();
      s.recordAll(order);
      const p = s.get(S, C)!;
      s.close();
      return { page: p.page, read: p.read, readAt: p.readAt, unreadAt: p.unreadAt, epoch: p.epoch };
    });
    expect(results).toHaveLength(24);
    for (const r of results) expect(r).toEqual(results[0]!);
    expect(results[0]!.page).toBe(190);
    expect(results[0]!.read).toBe(false);
  });

  test("replaying a write changes nothing", () => {
    const s = fresh();
    s.recordAll(writes);
    const once = s.get(S, C)!;
    s.recordAll([...writes, ...writes]);
    expect(s.get(S, C)).toEqual(once);
    s.close();
  });

  test("position never rewinds — LWW's failure mode does not exist here", () => {
    const s = fresh();
    // The tablet gets to page 190; the phone reconnects with a stale page 4
    // recorded *later*. Last-write-wins loses the reader's place silently.
    s.record({ seriesUid: S, chapterUid: C, page: 190, at: 1_000 });
    s.record({ seriesUid: S, chapterUid: C, page: 4, at: 9_999 });
    expect(s.get(S, C)!.page).toBe(190);
    s.close();
  });

  test("a higher epoch resets the position downwards", () => {
    const s = fresh();
    s.record({ seriesUid: S, chapterUid: C, page: 190, at: 1_000 });
    s.record({ seriesUid: S, chapterUid: C, page: 1, epoch: 1, at: 1_100 });
    expect(s.get(S, C)!.page).toBe(1);
    expect(s.get(S, C)!.epoch).toBe(1);

    // ...and a straggler from before the reset cannot undo it, whatever order
    // it arrives in. That is the whole reason the epoch is part of the key
    // rather than a separate "reset at" timestamp.
    s.record({ seriesUid: S, chapterUid: C, page: 190, at: 1_200 });
    expect(s.get(S, C)!.page).toBe(1);
    s.close();
  });

  test("the read flag is two timestamps, and a tie is unread", () => {
    const s = fresh();
    s.record({ seriesUid: S, chapterUid: C, read: true, at: 500 });
    expect(s.get(S, C)!.read).toBe(true);
    s.record({ seriesUid: S, chapterUid: C, read: false, at: 500 });
    expect(s.get(S, C)!.read).toBe(false);
    // An older mark-read replayed after the unmark does not resurrect it.
    s.record({ seriesUid: S, chapterUid: C, read: true, at: 499 });
    expect(s.get(S, C)!.read).toBe(false);
    s.close();
  });

  test("a position write does not clear the read flag", () => {
    const s = fresh();
    s.record({ seriesUid: S, chapterUid: C, read: true, at: 500 });
    s.record({ seriesUid: S, chapterUid: C, page: 3, at: 600 });
    expect(s.get(S, C)!.read).toBe(true);
    s.close();
  });
});

describe("readers", () => {
  test("rows are keyed per reader from the first write", () => {
    const s = fresh();
    s.record({ reader: "thomas", seriesUid: S, chapterUid: C, page: 30, at: 1 });
    s.record({ reader: "sam", seriesUid: S, chapterUid: C, page: 5, at: 2 });
    expect(s.get(S, C, "thomas")!.page).toBe(30);
    expect(s.get(S, C, "sam")!.page).toBe(5);
    expect(s.get(S, C, DEFAULT_READER)).toBeUndefined();
    s.close();
  });

  test("the household position is max(everyone) — and only derivable this way round", () => {
    const s = fresh();
    s.record({ reader: "thomas", seriesUid: S, chapterUid: C, page: 30, at: 1 });
    s.record({ reader: "sam", seriesUid: S, chapterUid: C, page: 5, read: true, at: 2 });
    const household = s.householdProgress(S, C)!;
    expect(household.page).toBe(30);
    expect(household.read).toBe(true);
    // The point of decision 1: this collapse is computable from per-reader rows,
    // and per-reader rows are not computable from the collapse. Sam is at 5.
    expect(s.get(S, C, "sam")!.page).toBe(5);
    s.close();
  });
});

describe("classification", () => {
  test("unopened, opened and finished are three states", () => {
    const s = fresh();
    expect(classify(s.get(S, "never-touched"))).toBe("unread");
    s.record({ seriesUid: S, chapterUid: "opened", page: 4, pages: 40, at: 1 });
    expect(classify(s.get(S, "opened"))).toBe("part-read");
    s.record({ seriesUid: S, chapterUid: "finished", page: 40, pages: 40, read: true, at: 1 });
    expect(classify(s.get(S, "finished"))).toBe("read");
    s.close();
  });

  test("reaching the last page is part-read until a client says otherwise", () => {
    const s = fresh();
    // The safe direction: a chapter that looks finished but was never marked
    // read stays held, because part-read sits outside the eviction set.
    s.record({ seriesUid: S, chapterUid: C, page: 40, pages: 40, at: 1 });
    expect(classify(s.get(S, C))).toBe("part-read");
    s.close();
  });
});

describe("readCount", () => {
  test("counts only chapters marked read, for one reader", () => {
    const s = fresh();
    s.record({ seriesUid: S, chapterUid: "a", read: true, at: 1 });
    s.record({ seriesUid: S, chapterUid: "b", read: true, at: 1 });
    s.record({ seriesUid: S, chapterUid: "b", read: false, at: 2 });
    s.record({ seriesUid: S, chapterUid: "c", page: 3, at: 1 });
    s.record({ reader: "sam", seriesUid: S, chapterUid: "d", read: true, at: 1 });
    expect(s.readCount(S)).toBe(1);
    expect(s.readCount(S, "sam")).toBe(1);
    expect(s.readCount("other-series")).toBe(0);
    s.close();
  });
});

describe("the library is never written to", () => {
  // /mnt/user/Media/Manga-new is real user data. The store is the one component
  // here that opens a file for writing, so it is the one that has to refuse.
  test("refuses a database path inside the library root", () => {
    expect(() => new ReadStateStore("/manga/readstate.db", { libraryRoot: "/manga" })).toThrow(/inside the library/);
    expect(() => assertOutsideLibrary("/manga/sub/dir/readstate.db", "/manga")).toThrow(/inside the library/);
    expect(() => assertOutsideLibrary("/manga", "/manga")).toThrow(/inside the library/);
  });

  test("a sibling directory with the same prefix is not inside it", () => {
    expect(() => assertOutsideLibrary("/manga-state/readstate.db", "/manga")).not.toThrow();
  });

  test(":memory: is always allowed", () => {
    expect(() => assertOutsideLibrary(":memory:", "/manga")).not.toThrow();
  });
});
