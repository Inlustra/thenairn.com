import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// MANGA_DIR is read once at module load, so it must be set before the import.
const ROOT = await mkdtemp(join(tmpdir(), "paperbox-scan-"));
process.env.MANGA_DIR = ROOT;
const scanner = await import("./index");

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function makeChapter(series: string, chapter: string, pages = 2) {
  const dir = join(ROOT, series, chapter);
  await mkdir(dir, { recursive: true });
  for (let i = 1; i <= pages; i++) {
    await writeFile(join(dir, `${String(i).padStart(3, "0")}.png`), PIXEL);
  }
}

beforeAll(async () => {
  await makeChapter("Nano Machine", "Chapter 001");
  await makeChapter("Nano Machine", "Chapter 002");
  await makeChapter("SSS-Class Suicide Hunter", "Chapter 070");
  await makeChapter("SSS-Class Suicide Hunter", "Chapter 071");
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("reading length", () => {
  test("chapter pixel height is measured, normalized and persisted", async () => {
    await scanner.scan();
    const m = scanner.getManga("nano-machine")!;
    const c = m.chapters.find((x) => x.dir === "Chapter 001")!;
    // Fixture pages are 1x1 px; normalized to a 1000px-wide page each one
    // counts 1000, so the chapter totals pageCount x 1000.
    expect(c.pixelHeight).toBe(c.pageCount * 1000);
    // Persisted, not derived at read time: the sidecar carries it too.
    const meta = JSON.parse(
      await Bun.file(join(ROOT, "Nano Machine", "paperbox.json")).text(),
    );
    expect(meta.chapters["Chapter 001"].pixelHeight).toBe(c.pageCount * 1000);
  });
});

describe("scanner identity", () => {
  test("ids survive a new series being inserted ahead of the others", async () => {
    await scanner.scan();
    const sss = scanner.getManga("sss-class-suicide-hunter")!;
    const before = {
      manga: sss.apiId,
      chapters: Object.fromEntries(sss.chapters.map((c) => [c.dir, c.apiId])),
    };
    expect(before.manga).toBeGreaterThan(0);

    // "AAA" sorts first, so under positional ids every later series shifted.
    await makeChapter("AAA New Series", "Chapter 001");
    await scanner.scan();

    const after = scanner.getManga("sss-class-suicide-hunter")!;
    expect(after.apiId).toBe(before.manga);
    for (const c of after.chapters) {
      expect(c.apiId).toBe(before.chapters[c.dir]!);
    }
    // ...and the Int a client cached still resolves to the same series.
    expect(scanner.getMangaByApiId(before.manga)!.id).toBe("sss-class-suicide-hunter");
  });

  test("ids survive a series being removed", async () => {
    await scanner.scan();
    const before = scanner.getManga("sss-class-suicide-hunter")!.apiId;
    await rm(join(ROOT, "AAA New Series"), { recursive: true, force: true });
    await scanner.scan();
    expect(scanner.getManga("sss-class-suicide-hunter")!.apiId).toBe(before);
  });

  test("manga and chapter ids are globally unique", async () => {
    await scanner.scan();
    const mangaIds = scanner.getMangaList().map((m) => m.apiId);
    expect(new Set(mangaIds).size).toBe(mangaIds.length);

    const chapterIds = scanner.getMangaList()
      .flatMap((m) => scanner.getManga(m.id)!.chapters.map((c) => c.apiId));
    expect(new Set(chapterIds).size).toBe(chapterIds.length);
    expect(chapterIds.every((id) => id > 0 && id <= 0x7fffffff)).toBe(true);
  });

  test("hidden directories are not content", async () => {
    await mkdir(join(ROOT, ".paperbox-backups", "Chapter 071"), { recursive: true });
    await writeFile(join(ROOT, ".paperbox-backups", "Chapter 071", "001.png"), PIXEL);
    await makeChapter("SSS-Class Suicide Hunter", ".bak-Chapter071");
    await scanner.scan();

    expect(scanner.getMangaList().some((m) => m.title.startsWith("."))).toBe(false);
    const dirs = scanner.getManga("sss-class-suicide-hunter")!.chapters.map((c) => c.dir);
    expect(dirs).toEqual(["Chapter 070", "Chapter 071"]);
  });

  test("a chapter keeps its id when its pages are replaced", async () => {
    await scanner.scan();
    const before = scanner.getManga("sss-class-suicide-hunter")!
      .chapters.find((c) => c.dir === "Chapter 071")!.apiId;

    await rm(join(ROOT, "SSS-Class Suicide Hunter", "Chapter 071"), { recursive: true });
    await makeChapter("SSS-Class Suicide Hunter", "Chapter 071", 70); // re-pulled elsewhere
    await scanner.scan();

    const after = scanner.getManga("sss-class-suicide-hunter")!
      .chapters.find((c) => c.dir === "Chapter 071")!;
    expect(after.apiId).toBe(before);
    expect(after.pageCount).toBe(70);
  });

  test("the library works with no sidecar files at all", async () => {
    // Structure is truth. A folder dropped in must appear immediately with a
    // stable id, before anything has been written next to it.
    await scanner.scan();
    const before = scanner.getMangaList().map((m) => ({ title: m.title, id: m.apiId }));
    const beforeChapters = scanner.getManga("sss-class-suicide-hunter")!
      .chapters.map((c) => ({ dir: c.dir, id: c.apiId }));

    // Delete every scrap of metadata and rescan from bare directories.
    for (const s of await readdir(ROOT)) {
      await rm(join(ROOT, s, "paperbox.json"), { force: true });
    }
    await scanner.scan();

    const after = scanner.getMangaList().map((m) => ({ title: m.title, id: m.apiId }));
    expect(after).toEqual(before);

    const afterChapters = scanner.getManga("sss-class-suicide-hunter")!
      .chapters.map((c) => ({ dir: c.dir, id: c.apiId }));
    expect(afterChapters).toEqual(beforeChapters);
  });

  test("a pinned uid overrides the derived one", async () => {
    await scanner.scan();
    const derived = scanner.getManga("nano-machine")!.apiId;

    await writeFile(
      join(ROOT, "Nano Machine", "paperbox.json"),
      JSON.stringify({ schemaVersion: 1, uid: "pinned-identity", chapters: {} }),
    );
    await scanner.scan();

    expect(scanner.getManga("nano-machine")!.uid).toBe("pinned-identity");
    expect(scanner.getManga("nano-machine")!.apiId).not.toBe(derived);
  });

  test("a scoped scan updates one series and leaves the rest untouched", async () => {
    await scanner.scan();
    const otherBefore = scanner.getManga("nano-machine")!;
    const sssBefore = scanner.getManga("sss-class-suicide-hunter")!;

    await makeChapter("SSS-Class Suicide Hunter", "Chapter 099");
    await scanner.scan({ series: "SSS-Class Suicide Hunter" });

    // In scope: the new chapter is there.
    const sssAfter = scanner.getManga("sss-class-suicide-hunter")!;
    expect(sssAfter.chapters.map((c) => c.dir)).toContain("Chapter 099");
    expect(sssAfter.apiId).toBe(sssBefore.apiId);

    // Out of scope: carried over whole, ids and all.
    const otherAfter = scanner.getManga("nano-machine")!;
    expect(otherAfter.apiId).toBe(otherBefore.apiId);
    expect(otherAfter.chapters.map((c) => c.apiId)).toEqual(otherBefore.chapters.map((c) => c.apiId));

    // And the new chapter is reachable by the Int a client would cache.
    const fresh = sssAfter.chapters.find((c) => c.dir === "Chapter 099")!;
    expect(scanner.getChapterByApiId(fresh.apiId)?.chapter.dir).toBe("Chapter 099");
  });

  test("scan progress reports completion", async () => {
    await scanner.scan();
    const p = scanner.getScanProgress();
    expect(p.active).toBe(false);
    expect(p.phase).toBe("done");
    expect(p.seriesDone).toBe(p.seriesTotal);
    expect(p.chaptersSeen).toBeGreaterThan(0);
    expect(p.durationMs).not.toBeNull();
  });
});
