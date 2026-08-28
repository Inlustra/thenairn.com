import { Elysia, t } from "elysia";
import { join } from "path";
import { getMangaList, getManga, getMangaByApiId, getPages, getMangaDir } from "../scanner";
import type { MangaDetail, Chapter } from "../types";
import { chapterReadFields, recordChapterPatch, seriesProgress, unreadCount } from "../readstate";
import type { Progress } from "../readstate";

const NOW_SECS = Math.floor(Date.now() / 1000);

/**
 * Resolve a chapter from a path parameter.
 *
 * Ids are the stable apiId. The positional fallback exists only for clients
 * that built their URLs from `index`/`sourceOrder` under the old scheme; it
 * logs when it fires so we can tell whether anything still relies on it.
 */
function resolveChapter(manga: MangaDetail, raw: string): Chapter | undefined {
  const n = parseInt(raw);
  if (Number.isNaN(n)) return undefined;
  const byId = manga.chapters.find((c) => c.apiId === n);
  if (byId) return byId;
  if (n >= 0 && n < manga.chapters.length) {
    console.log(`  compat: chapter ${n} of ${manga.title} resolved positionally`);
    return manga.chapters[n];
  }
  return undefined;
}

function findManga(raw: string): MangaDetail | undefined {
  const n = parseInt(raw);
  if (Number.isNaN(n)) return undefined;
  return getMangaByApiId(n);
}

export const paperbackRoutes = new Elysia({ prefix: "/api/v1" })
  .get("/category", () => {
    const list = getMangaList();
    return [{
      id: 0,
      name: "Default",
      order: 0,
      default: true,
      size: list.length,
      includeInUpdate: "INCLUDE",
      meta: {},
    }];
  })
  .get("/category/:id", () => {
    return getMangaList().map((m) => toSuwayomiManga(getManga(m.id)!));
  }, { params: t.Object({ id: t.String() }) })

  .get("/manga/:id", ({ params, set }) => {
    const manga = findManga(params.id);
    if (!manga) { set.status = 404; return { error: "Not found" }; }
    return toSuwayomiManga(manga);
  }, { params: t.Object({ id: t.String() }) })

  .get("/manga/:id/full", ({ params, set }) => {
    const manga = findManga(params.id);
    if (!manga) { set.status = 404; return { error: "Not found" }; }
    return toSuwayomiManga(manga);
  }, { params: t.Object({ id: t.String() }) })

  .get("/manga/:id/thumbnail", async ({ params, set }) => {
    const manga = findManga(params.id);
    if (!manga || !manga.coverUrl) { set.status = 404; return { error: "Not found" }; }
    const imgPath = join(getMangaDir(), manga.coverUrl.replace("/api/images/", ""));
    const file = Bun.file(imgPath);
    if (!(await file.exists())) { set.status = 404; return { error: "Image file not found" }; }
    set.headers["cache-control"] = "public, max-age=86400";
    return file;
  }, { params: t.Object({ id: t.String() }) })

  .get("/manga/:id/chapters", ({ params, set }) => {
    const manga = findManga(params.id);
    if (!manga) { set.status = 404; return { error: "Not found" }; }
    // One indexed read for the whole series, not one per chapter.
    const progress = seriesProgress(manga);
    return manga.chapters.map((ch, index) => toSuwayomiChapter(ch, index, manga, progress));
  }, { params: t.Object({ id: t.String() }) })

  .get("/manga/:id/chapter/:chapterId", ({ params, set }) => {
    const manga = findManga(params.id);
    if (!manga) { set.status = 404; return { error: "Not found" }; }
    const chapter = resolveChapter(manga, params.chapterId);
    if (!chapter) { set.status = 404; return { error: "Chapter not found" }; }
    return toSuwayomiChapter(chapter, manga.chapters.indexOf(chapter), manga, seriesProgress(manga));
  }, { params: t.Object({ id: t.String(), chapterId: t.String() }) })

  // The read-state write path. This answered `{ success: true }` while
  // discarding the patch, so a client could mark a chapter read, be told it
  // worked, and see it unread on the next list. See readstate/compat.ts -- and
  // note that nothing on this request says *who* read it, which is why rows
  // carry a reader column from the first write.
  .patch("/manga/:id/chapter/:chapterId", ({ params, body, set }) => {
    const manga = findManga(params.id);
    if (!manga) { set.status = 404; return { error: "Not found" }; }
    const chapter = resolveChapter(manga, params.chapterId);
    if (!chapter) { set.status = 404; return { error: "Chapter not found" }; }
    recordChapterPatch(manga, chapter, body as any);
    return { success: true };
  }, { params: t.Object({ id: t.String(), chapterId: t.String() }), body: t.Optional(t.Any()) })

  .get("/manga/:id/chapter/:chapterId/page/:pageIndex", async ({ params, set }) => {
    const manga = findManga(params.id);
    if (!manga) {
      console.log(`  page: manga ${params.id} not found`);
      set.status = 404; return { error: "Not found" };
    }
    const chapter = resolveChapter(manga, params.chapterId);
    if (!chapter) {
      console.log(`  page: chapter ${params.chapterId} not found in ${manga.title}`);
      set.status = 404; return { error: "Chapter not found" };
    }
    const pages = await getPages(manga.id, chapter.id);
    const page = pages[parseInt(params.pageIndex)];
    if (!page) {
      console.log(`  page: page ${params.pageIndex} not in ${chapter.title} (${pages.length} pages)`);
      set.status = 404; return { error: "Page not found" };
    }
    const imgPath = join(getMangaDir(), page.path);
    const file = Bun.file(imgPath);
    if (!(await file.exists())) { set.status = 404; return { error: "Image file not found" }; }
    set.headers["cache-control"] = "public, max-age=86400";
    return file;
  }, { params: t.Object({ id: t.String(), chapterId: t.String(), pageIndex: t.String() }) })

  .get("/settings/about", () => ({ name: "Paperbox", version: "1.0.0", revision: "1" }))

  .get("/source/list", () => [{
    id: "paperbox", name: "Paperbox", lang: "en",
    iconUrl: "/api/v1/extension/icon/paperbox",
    supportsLatest: false, isConfigurable: false, isNsfw: false, displayName: "Paperbox",
  }])

  .get("/source/:id/popular/:page", () => ({
    mangaList: getMangaList().map((m) => toSuwayomiManga(getManga(m.id)!)), hasNextPage: false,
  }), { params: t.Object({ id: t.String(), page: t.String() }) })

  .get("/source/:id/latest/:page", () => ({
    mangaList: getMangaList().map((m) => toSuwayomiManga(getManga(m.id)!)), hasNextPage: false,
  }), { params: t.Object({ id: t.String(), page: t.String() }) })

  .get("/update/recentChapters/:page", () => ({ page: [], hasNextPage: false }));

// -- Helpers --

function toSuwayomiManga(manga: MangaDetail) {
  const id = manga.apiId;
  return {
    id,
    sourceId: "paperbox",
    url: `/manga/${id}`,
    title: manga.title,
    thumbnailUrl: `/api/v1/manga/${id}/thumbnail`,
    thumbnailUrlLastFetched: NOW_SECS,
    initialized: true,
    artist: manga.meta.artist || "",
    author: manga.meta.author || "",
    description: manga.meta.description || "",
    genre: manga.meta.tags || [],
    status: mapStatus(manga.meta.status),
    inLibrary: true,
    inLibraryAt: NOW_SECS,
    source: {
      id: "paperbox", name: "Paperbox", lang: "en", iconUrl: "",
      supportsLatest: false, isConfigurable: false, isNsfw: false, displayName: "Paperbox",
    },
    meta: {},
    realUrl: manga.meta.link || "",
    lastFetchedAt: NOW_SECS,
    chaptersLastFetchedAt: NOW_SECS,
    updateStrategy: "ALWAYS_UPDATE",
    freshData: true,
    unreadCount: unreadCount(manga),
    downloadCount: manga.chapterCount,
    chapterCount: manga.chapterCount,
    lastReadAt: 0,
    age: 0,
    chaptersAge: 0,
  };
}

function toSuwayomiChapter(ch: Chapter, index: number, manga: MangaDetail, progress?: Map<string, Progress>) {
  const state = chapterReadFields(ch, progress ?? seriesProgress(manga));
  return {
    id: ch.apiId,
    url: `/manga/${manga.apiId}/chapter/${index}`,
    name: ch.title,
    uploadDate: NOW_SECS * 1000,
    chapterNumber: ch.number,
    scanlator: ch.provenance?.group || "",
    mangaId: manga.apiId,
    read: state.read,
    bookmarked: false,
    lastPageRead: state.lastPageRead,
    lastReadAt: state.lastReadAt,
    index,
    fetchedAt: NOW_SECS,
    realUrl: ch.provenance?.chapterUrl || "",
    downloaded: true,
    pageCount: ch.pageCount,
    chapterCount: manga.chapterCount,
    meta: {},
  };
}

function mapStatus(status?: string): string {
  switch (status) {
    case "ongoing": return "ONGOING";
    case "completed": return "COMPLETED";
    case "hiatus": return "ON_HIATUS";
    case "cancelled": return "CANCELLED";
    default: return "UNKNOWN";
  }
}
