import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// MANGA_DIR is read at call time, but the library must exist before the scan.
const ROOT = await mkdtemp(join(tmpdir(), "paperbox-slug-"));
process.env.MANGA_DIR = ROOT;
const scanner = await import("./index");

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function makeChapter(series: string, chapter: string, pages: number) {
  const dir = join(ROOT, series, chapter);
  await mkdir(dir, { recursive: true });
  for (let i = 1; i <= pages; i++) {
    await writeFile(join(dir, `${String(i).padStart(3, "0")}.png`), PIXEL);
  }
}

/**
 * Every pair below normalises to a single slug under
 * `.replace(/[^a-z0-9]+/g, "-")`. None of them collide in the live library
 * today, which is exactly the point: nothing should be able to introduce one.
 */
const COLLIDING_CHAPTERS = "Chainsaw Man";
const CHAPTER_PAGES: Record<string, number> = {
  "Chapter 1": 1,
  "Chapter-1": 2,
  "Chapter_1": 3,
};

beforeAll(async () => {
  // Two series directories that slugify to `re-zero`.
  await makeChapter("Re Zero", "Chapter 001", 1);
  await makeChapter("Re:Zero", "Chapter 001", 2);
  // Two more that slugify to `warhammer-40-000-exterminatus`.
  await makeChapter("Warhammer 40,000_ Exterminatus", "Issue #1", 1);
  await makeChapter("Warhammer 40,000: Exterminatus", "Issue #1", 2);
  // Three chapter directories, in one series, that slugify to `chapter-1`.
  for (const [dir, pages] of Object.entries(CHAPTER_PAGES)) {
    await makeChapter(COLLIDING_CHAPTERS, dir, pages);
  }
  await scanner.scan();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("slug collisions", () => {
  test("two series whose names slugify the same both survive the scan", () => {
    const list = scanner.getMangaList();
    // `newCache.set(p.slug, ...)` used to overwrite, so one of each pair simply
    // vanished from the library with no error raised anywhere.
    expect(list.length).toBe(5);
    expect(new Set(list.map((m) => m.dir)).size).toBe(5);
  });

  test("colliding series get distinct slugs and distinct api ids", () => {
    const list = scanner.getMangaList();
    const slugs = list.map((m) => m.id);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(list.map((m) => m.apiId)).size).toBe(list.length);
    // The first claimant keeps the bare slug; the rest are suffixed.
    expect(slugs).toContain("re-zero");
    expect(slugs.filter((s) => s.startsWith("re-zero")).length).toBe(2);
    expect(slugs.filter((s) => s.startsWith("warhammer-40-000")).length).toBe(2);
  });

  test("chapter ids are unique within a series", () => {
    const manga = scanner
      .getMangaList()
      .find((m) => m.dir === COLLIDING_CHAPTERS)!;
    const detail = scanner.getManga(manga.id)!;
    expect(detail.chapters.length).toBe(3);
    const ids = detail.chapters.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
  });

  test("a cached api id resolves to the chapter it was issued for", () => {
    for (const listed of scanner.getMangaList()) {
      const detail = scanner.getManga(listed.id)!;
      for (const chapter of detail.chapters) {
        const hit = scanner.getChapterByApiId(chapter.apiId);
        // getChapterByApiId resolves with `find(c => c.id === chapterId)`, so a
        // duplicated chapter id served the *first* match: `Chapter_1` handed
        // back `Chapter 1`'s directory, and with it `Chapter 1`'s pages.
        expect(hit?.chapter.dir).toBe(chapter.dir);
        expect(hit?.manga.dir).toBe(detail.dir);
      }
    }
  });

  test("each colliding chapter serves its own pages", async () => {
    const manga = scanner
      .getMangaList()
      .find((m) => m.dir === COLLIDING_CHAPTERS)!;
    const detail = scanner.getManga(manga.id)!;
    for (const chapter of detail.chapters) {
      const pages = await scanner.getPages(detail.id, chapter.id);
      expect(pages.length).toBe(CHAPTER_PAGES[chapter.dir]!);
    }
  });

  test("a scoped rescan does not duplicate or drop a colliding series", async () => {
    const before = scanner.getMangaList().length;
    await scanner.scan({ series: "Re:Zero" });
    const after = scanner.getMangaList();
    expect(after.length).toBe(before);
    expect(new Set(after.map((m) => m.dir)).size).toBe(before);
    expect(after.some((m) => m.dir === "Re:Zero")).toBe(true);
    expect(after.some((m) => m.dir === "Re Zero")).toBe(true);
  });
});
