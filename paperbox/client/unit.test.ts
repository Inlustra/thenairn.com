import { describe, expect, test } from "bun:test";
import { applyDiff, blockStartOf, chaptersInOrder, emptyCatalog } from "./catalog";
import { approxNumber, evaluate } from "./rules";
import { buildPlan, estimatePageBytes } from "./plan";
import type { DiffReply, HeldChapter, NodeSummary, Rule } from "./types";

const node = (id: string, kind: NodeSummary["kind"], n: number, label: string, hash = id + "#"): NodeSummary =>
  ({ id, kind, hash, n, label, state: "added" });

const reply = (changed: NodeSummary[], gone: string[] = [], treeVersion = 2): DiffReply =>
  ({ root: "r1", treeVersion, changed, images: [], gone, truncated: false });

describe("catalog", () => {
  test("reconstructs parentage from a flat pre-order stream", () => {
    const cat = emptyCatalog(2);
    applyDiff(cat, reply([
      node("root", "root", 1, "library"),
      node("s:a", "series", 2, "A"),
      node("b:a:main:1", "block", 2, "1-25"),
      node("c:1", "chapter", 8, "Chapter 001"),
      node("c:2", "chapter", 8, "Chapter 002"),
      node("b:a:main:26", "block", 1, "26-50"),
      node("c:30", "chapter", 8, "Chapter 030"),
    ]));

    const series = cat.series.get("s:a")!;
    expect(series.chapters.size).toBe(3);
    expect(series.chapters.get("c:30")!.blockIds).toEqual(["b:a:main:26"]);
    expect(series.chapters.get("c:30")!.blockStart).toBe(26);
    expect(chaptersInOrder(series).map((c) => c.id)).toEqual(["c:1", "c:2", "c:30"]);
  });

  test("a block id's start is read from the right, past the sequence segment", () => {
    // treeVersion 2 inserted `:<seq>:`. Splitting from the left reads the uid.
    expect(blockStartOf("b:0mtaahh7:main:101", "")).toBe(101);
    expect(blockStartOf("b:0mtaahh7:main:0", "")).toBe(0);
    expect(blockStartOf("b:weird", "Spin-off 26-50")).toBe(26);
  });

  test("the unnumbered block sorts last, and chapter zero does not", () => {
    const cat = emptyCatalog(2);
    applyDiff(cat, reply([
      node("s:a", "series", 2, "A"),
      node("b:a:main:0", "block", 1, "unnumbered"),
      node("c:one", "chapter", 3, "Oneshot"),
      node("b:a:main:1", "block", 1, "1-25"),
      node("c:0", "chapter", 3, "Chapter 000"),
    ]));
    expect(chaptersInOrder(cat.series.get("s:a")!).map((c) => c.id)).toEqual(["c:0", "c:one"]);
  });

  test("a ranged chapter keeps its first position when it reappears under a second block", () => {
    const cat = emptyCatalog(2);
    applyDiff(cat, reply([
      node("s:a", "series", 2, "A"),
      node("b:a:main:1", "block", 1, "1-25"),
      node("c:24-27", "chapter", 14, "Chapter 24-27"),
      node("b:a:main:26", "block", 2, "26-50"),
      node("c:30", "chapter", 8, "Chapter 030"),
    ]));
    const ch = cat.series.get("s:a")!.chapters.get("c:24-27")!;
    expect(ch.blockStart).toBe(1);
    // The 26-50 block declares two children and the stream carried one: the
    // ranged chapter was de-duplicated by the server's `visited` set.
    const update = applyDiff(cat, reply([
      node("s:a", "series", 2, "A"),
      node("b:a:main:26", "block", 2, "26-50"),
      node("c:30", "chapter", 8, "Chapter 030"),
    ]));
    expect(update.partialBlocks).toContain("b:a:main:26");
  });

  test("`gone` is applied within a treeVersion and ignored across one", () => {
    const cat = emptyCatalog(2);
    applyDiff(cat, reply([node("s:a", "series", 1, "A"), node("b:a:main:1", "block", 1, "1-25"), node("c:1", "chapter", 8, "Chapter 001")]));
    expect(applyDiff(cat, reply([], ["c:1"], 3)).pruned).toBe(0);
    expect(cat.series.get("s:a")!.chapters.size).toBe(1);
    expect(applyDiff(cat, reply([], ["c:1"], 2)).pruned).toBe(1);
  });
});

describe("rules", () => {
  const cat = emptyCatalog(2);
  applyDiff(cat, reply([
    node("root", "root", 1, "library"),
    node("s:a", "series", 2, "A"),
    node("b:a:main:1", "block", 3, "1-25"),
    node("c:1", "chapter", 8, "Chapter 001"),
    node("c:2", "chapter", 8, "Chapter 002"),
    node("c:3", "chapter", 8, "Chapter 003"),
    node("b:a:main:26", "block", 1, "26-50"),
    node("c:30", "chapter", 8, "Chapter 030"),
  ]));

  const rule = (over: Partial<Rule> & Pick<Rule, "id" | "scope">): Rule => ({
    label: over.id, priority: 10, lifetime: "standing", retention: { kind: "keep" }, ...over,
  });

  test("a chapter number is approximated from the label, past the series name", () => {
    const ch = cat.series.get("s:a")!.chapters.get("c:30")!;
    expect(approxNumber(ch)).toBe(30);
  });

  test("a range rule resolves against the approximated number", () => {
    const t = evaluate({
      catalog: cat, readMark: () => "unread",
      rules: [rule({ id: "r", scope: { kind: "range", seriesId: "s:a", from: 2, to: 3 } })],
    });
    expect([...t.want.keys()].sort()).toEqual(["c:2", "c:3"]);
  });

  test("`latest` takes from the end of reading order", () => {
    const t = evaluate({
      catalog: cat, readMark: () => "unread",
      rules: [rule({ id: "r", scope: { kind: "latest", seriesId: "s:a", count: 2 } })],
    });
    expect([...t.want.keys()].sort()).toEqual(["c:3", "c:30"]);
  });

  test("keepLastRead keeps the last N read and releases the rest", () => {
    const t = evaluate({
      catalog: cat,
      readMark: (id) => (id === "c:1" || id === "c:2" ? "read" : "unread"),
      rules: [rule({ id: "r", scope: { kind: "series", seriesId: "s:a" }, retention: { kind: "keepLastRead", count: 1 } })],
    });
    expect(t.want.has("c:2")).toBe(true);   // the most recent read
    expect(t.want.has("c:1")).toBe(false);  // one further back
    expect(t.released.get("c:1")!.reason).toMatch(/further back/);
  });

  test("array order does not decide a disagreement; priority does", () => {
    const keep = rule({ id: "keep", scope: { kind: "series", seriesId: "s:a" }, priority: 1 });
    const drop = rule({ id: "drop", scope: { kind: "series", seriesId: "s:a" }, priority: 9, retention: { kind: "deleteWhenRead" } });
    const read = () => "read" as const;
    const a = evaluate({ catalog: cat, readMark: read, rules: [keep, drop] });
    const b = evaluate({ catalog: cat, readMark: read, rules: [drop, keep] });
    expect(a.want.size).toBe(0);
    expect(b.want.size).toBe(0);
  });

  test("a rule that resolves to nothing is reported, never silently dropped", () => {
    const t = evaluate({ catalog: cat, readMark: () => "unread", rules: [rule({ id: "r", scope: { kind: "series", seriesId: "s:missing" } })] });
    expect(t.skipped[0]).toEqual({ ruleId: "r", reason: "resolves to nothing the server holds" });
  });
});

describe("plan", () => {
  const cat = emptyCatalog(2);
  applyDiff(cat, reply([
    node("s:a", "series", 1, "A"),
    node("b:a:main:1", "block", 2, "1-25"),
    node("c:1", "chapter", 8, "Chapter 001"),
    node("c:2", "chapter", 8, "Chapter 002"),
  ]));

  const held = (id: string, hash: string, bytes = 800_000): HeldChapter => ({
    chapterId: id, seriesId: "s:a", hash, bytes, completedAt: 1,
    pages: [{ id: `p:${id}:001.jpg`, file: "001.jpg", size: bytes, hash: "h" }],
  });

  test("a chapter held at the wrong hash is a repair, and estimates zero bytes", () => {
    const target = evaluate({
      catalog: cat, readMark: () => "unread",
      rules: [{ id: "r", label: "r", priority: 1, lifetime: "standing", scope: { kind: "series", seriesId: "s:a" }, retention: { kind: "keep" } }],
    });
    const plan = buildPlan({
      catalog: cat, target, root: "r1", treeVersion: 2,
      held: new Map([["c:1", held("c:1", "stale")]]),
    });
    expect(plan.fetch.find((f) => f.chapterId === "c:1")!.reason).toBe("repair");
    // A repair may transfer nothing. Estimating it at full size would evict
    // content to make room for bytes that never arrive.
    expect(plan.fetch.find((f) => f.chapterId === "c:1")!.estimatedBytes).toBe(0);
    expect(plan.fetch.find((f) => f.chapterId === "c:2")!.reason).toBe("missing");
  });

  test("orphans rank ahead of released chapters, and pins are absent entirely", () => {
    const target = evaluate({
      catalog: cat, readMark: () => "unread",
      rules: [{ id: "pin", label: "pin", priority: 1, lifetime: "standing", scope: { kind: "chapter", seriesId: "s:a", chapterId: "c:1" }, retention: { kind: "pin" } }],
    });
    const plan = buildPlan({
      catalog: cat, target, root: "r1", treeVersion: 2,
      held: new Map([["c:1", held("c:1", "c:1#")], ["c:2", held("c:2", "c:2#")]]),
    });
    expect(plan.evictCandidates.map((c) => c.chapterId)).toEqual(["c:2"]);
    expect(plan.evictCandidates[0]!.reason).toBe("no rule mentions it");
  });

  test("byte estimates come from what the device has actually seen", () => {
    expect(estimatePageBytes([])).toBe(330_000);
    expect(estimatePageBytes([held("c:1", "h", 1_000_000)])).toBe(1_000_000);
  });
});
