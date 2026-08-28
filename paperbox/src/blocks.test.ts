import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = await mkdtemp(join(tmpdir(), "paperbox-blocks-"));
process.env.MANGA_DIR = ROOT;
const scanner = await import("./scanner");
const { buildTree, diff, TREE_VERSION } = await import("./hashes");
const { syncRoutes } = await import("./routes/sync");

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SERIES = "Solo Leveling";
const PAGES = 2;

/**
 * `Chapter 000` is numbered: the key parser reads 0 and marks it "0".
 * `Oneshot` is not: nothing numeric, so its mark is empty.
 * `Chapter 24-27` is one directory covering four chapters and it crosses the
 * 1-25 / 26-50 boundary.
 */
const CHAPTERS = ["Chapter 000", "Chapter 001", "Chapter 24-27", "Chapter 026", "Oneshot"];

async function makeChapter(chapter: string) {
  const dir = join(ROOT, SERIES, chapter);
  await mkdir(dir, { recursive: true });
  for (let i = 1; i <= PAGES; i++) {
    await writeFile(join(dir, `${String(i).padStart(3, "0")}.png`), PIXEL);
  }
}

function blocks() {
  const series = buildTree().children.find((s) => s.label === SERIES)!;
  return new Map(series.children.map((b) => [b.label, b.children.map((c) => c.label)]));
}

beforeAll(async () => {
  for (const c of CHAPTERS) await makeChapter(c);
  await scanner.scan();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("chapter 0 is numbered", () => {
  test("chapter 0 lands in block 1-25, not in 'unnumbered'", () => {
    const b = blocks();
    // Four of the twelve live series start at chapter 0, and every one of them
    // opened with its first chapter filed under a label asserting no number
    // could be read from it.
    expect(b.get("1-25")).toContain("Chapter 000");
    expect(b.get("unnumbered") ?? []).not.toContain("Chapter 000");
  });

  test("a genuinely unnumbered chapter stays in 'unnumbered'", () => {
    // `Oneshot` has an empty mark: nothing numeric was derived at all. It has
    // no position on the number line and must not be given one.
    expect(blocks().get("unnumbered")).toEqual(["Oneshot"]);
  });
});

describe("a ranged chapter spans blocks", () => {
  test("it is filed into every block it covers", () => {
    const b = blocks();
    // `keySpan()` counts `Chapter 24-27` as four chapters, 26 and 27 among
    // them, while the block labelled 26-50 did not contain it -- the doc
    // asserted a span the tree did not implement.
    expect(b.get("1-25")).toContain("Chapter 24-27");
    expect(b.get("26-50")).toContain("Chapter 24-27");
    expect(b.get("26-50")).toContain("Chapter 026");
  });

  test("but is still planned, and reported, exactly once", async () => {
    const r = await diff([], { resolve: "pages" });
    expect(r.images.length).toBe(CHAPTERS.length * PAGES);
    expect(new Set(r.images.map((i) => i.id)).size).toBe(r.images.length);
    const chapterIds = r.changed.filter((c) => c.kind === "chapter").map((c) => c.id);
    expect(new Set(chapterIds).size).toBe(chapterIds.length);
  });
});

describe("treeVersion", () => {
  test("diff reports the id-shape version", async () => {
    // Block ids went from `b:<uid>:<start>` to `b:<uid>:<seq>:<start>`. Without
    // a version a client that synced before sees every id it holds in `gone`
    // and every id we return as `added`, with nothing to tell it that this is a
    // renaming rather than a deletion.
    const r = await diff([]);
    expect(r.treeVersion).toBe(TREE_VERSION);
    expect(TREE_VERSION).toBe(2);
  });

  test("/api/sync/tree reports it too -- the cheapest call a client makes", async () => {
    const res = await syncRoutes.handle(
      new Request("http://localhost/api/sync/tree"),
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.treeVersion).toBe(TREE_VERSION);
    expect(body.treeVersion).toBe(2);
  });
});
