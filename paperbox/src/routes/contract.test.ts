import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// MANGA_DIR is read at module load, so seed the library before importing.
const ROOT = await mkdtemp(join(tmpdir(), "paperbox-contract-"));
process.env.MANGA_DIR = ROOT;
const scanner = await import("../scanner");
const { handle } = await import("./graphql");

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let MANGA_ID = 0;
let CHAPTER_ID = 0;

beforeAll(async () => {
  for (const ch of ["Chapter 070", "Chapter 071"]) {
    const dir = join(ROOT, "SSS-Class Suicide Hunter", ch);
    await mkdir(dir, { recursive: true });
    for (let i = 1; i <= 3; i++) await writeFile(join(dir, `00${i}.png`), PIXEL);
  }
  await scanner.scan();
  const m = scanner.getManga("sss-class-suicide-hunter")!;
  MANGA_ID = m.apiId;
  CHAPTER_ID = m.chapters[1]!.apiId;
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

/**
 * The Paperback extension aborts the whole call on any `errors` key, even when
 * `data` is populated -- so "no errors" is the contract, not a nicety.
 */
async function run(query: string, variables: Record<string, unknown> = {}) {
  const res: any = await handle({ query, variables });
  expect(res.errors ?? []).toEqual([]);
  return res.data;
}

// Verbatim operation documents sent by the Suwayomi/Tachidesk Paperback extension.
describe("Paperback extension operations", () => {
  test("TestConnection", async () => {
    const d = await run(`query { aboutServer { name version } }`);
    expect(typeof d.aboutServer.name).toBe("string");
    expect(typeof d.aboutServer.version).toBe("string");
  });

  test("ListCategories", async () => {
    const d = await run(`query { categories(orderBy: ORDER) {
      nodes { id order name default meta { key value } } } }`);
    expect(d.categories.nodes.length).toBeGreaterThan(0);
  });

  test("ListSources", async () => {
    const d = await run(`query { sources {
      nodes { id name lang iconUrl supportsLatest isConfigurable isNsfw displayName } } }`);
    // sourceId is LongString: it must serialise as a JSON string, never a number.
    expect(typeof d.sources.nodes[0].id).toBe("string");
  });

  test("GetManga", async () => {
    const d = await run(
      `query GetManga($id: Int!) { manga(id: $id) {
        id title author artist description genre status thumbnailUrl lastFetchedAt } }`,
      { id: MANGA_ID },
    );
    expect(d.manga.id).toBe(MANGA_ID);
    expect(Array.isArray(d.manga.genre)).toBe(true); // [String!]! -- [] never null
    expect(d.manga.thumbnailUrl.startsWith("/")).toBe(true); // root-relative
  });

  test("FetchManga (mutation)", async () => {
    const d = await run(
      `mutation FetchManga($id: Int!) { fetchManga(input: { id: $id }) {
        manga { id title lastFetchedAt } } }`,
      { id: MANGA_ID },
    );
    expect(d.fetchManga.manga.id).toBe(MANGA_ID);
  });

  test("GetChapters accepts the deprecated ordering args", async () => {
    const d = await run(
      `query GetChapters($mangaId: Int!) {
        chapters(condition: { mangaId: $mangaId }, orderBy: SOURCE_ORDER, orderByType: DESC) {
          nodes { id sourceOrder name chapterNumber uploadDate pageCount mangaId } } }`,
      { mangaId: MANGA_ID },
    );
    expect(d.chapters.nodes.length).toBe(2);
    for (const n of d.chapters.nodes) {
      expect(typeof n.uploadDate).toBe("string"); // LongString, epoch ms
      expect(typeof n.chapterNumber).toBe("number");
      expect(n.pageCount).toBe(3);
    }
  });

  test("FetchChapters (mutation)", async () => {
    const d = await run(
      `mutation FetchChapters($mangaId: Int!) {
        fetchChapters(input: { mangaId: $mangaId }) { chapters { id sourceOrder } } }`,
      { mangaId: MANGA_ID },
    );
    expect(d.fetchChapters.chapters.length).toBe(2);
  });

  test("GetChapter resolves exactly one node by (mangaId, sourceOrder)", async () => {
    const d = await run(
      `query GetChapter($mangaId: Int!, $sourceOrder: Int!) {
        chapters(condition: { mangaId: $mangaId, sourceOrder: $sourceOrder }, first: 1) {
          nodes { id sourceOrder name chapterNumber pageCount mangaId } } }`,
      { mangaId: MANGA_ID, sourceOrder: 1 },
    );
    expect(d.chapters.nodes.length).toBe(1);
    expect(d.chapters.nodes[0].sourceOrder).toBe(1);
  });

  test("FetchChapterPages returns root-relative page URLs", async () => {
    const d = await run(
      `mutation FetchChapterPages($chapterId: Int!) {
        fetchChapterPages(input: { chapterId: $chapterId }) { pages } }`,
      { chapterId: CHAPTER_ID },
    );
    expect(d.fetchChapterPages.pages.length).toBe(3);
    for (const p of d.fetchChapterPages.pages) expect(p.startsWith("/api/v1/manga/")).toBe(true);
  });

  test("GetRecentChapters paginates with offset/first", async () => {
    const d = await run(
      `query GetRecentChapters($offset: Int, $first: Int) {
        chapters(condition: { isDownloaded: false }, orderBy: FETCHED_AT, orderByType: DESC,
                 offset: $offset, first: $first) {
          nodes { id name manga { id title thumbnailUrl } }
          pageInfo { hasNextPage } } }`,
      { offset: 0, first: 10 },
    );
    expect(typeof d.chapters.pageInfo.hasNextPage).toBe("boolean");
  });

  test("GetCategoryMangas", async () => {
    const d = await run(
      `query GetCategoryMangas($categoryId: Int!) {
        category(id: $categoryId) { id name mangas { nodes { id title thumbnailUrl } } } }`,
      { categoryId: 0 },
    );
    expect(d.category.mangas.nodes.length).toBeGreaterThan(0);
  });

  test("GetSourceMangas is a MUTATION, not a query", async () => {
    const d = await run(
      `mutation GetSourceMangas($sourceId: LongString!, $type: FetchSourceMangaType!, $page: Int!) {
        fetchSourceManga(input: { source: $sourceId, type: $type, page: $page }) {
          hasNextPage mangas { id title thumbnailUrl } } }`,
      { sourceId: "paperbox", type: "POPULAR", page: 1 },
    );
    expect(d.fetchSourceManga.mangas.length).toBeGreaterThan(0);
  });

  test("SearchSource tolerates a null query", async () => {
    const d = await run(
      `mutation SearchSource($sourceId: LongString!, $query: String, $page: Int!) {
        fetchSourceManga(input: { source: $sourceId, type: SEARCH, page: $page, query: $query }) {
          hasNextPage mangas { id title thumbnailUrl } } }`,
      { sourceId: "paperbox", query: null, page: 1 },
    );
    expect(Array.isArray(d.fetchSourceManga.mangas)).toBe(true);
  });

  test("GetMangaFull", async () => {
    const d = await run(
      `query GetMangaFull($id: Int!) { manga(id: $id) {
        id title lastReadChapter { id chapterNumber } } }`,
      { id: MANGA_ID },
    );
    expect(d.manga.id).toBe(MANGA_ID);
  });

  test("UpdateChapter echoes the chapter back", async () => {
    const d = await run(
      `mutation UpdateChapter($id: Int!) {
        updateChapter(input: { id: $id, patch: { isRead: true } }) { chapter { id isRead } } }`,
      { id: CHAPTER_ID },
    );
    expect(d.updateChapter.chapter.id).toBe(CHAPTER_ID);
  });
});
