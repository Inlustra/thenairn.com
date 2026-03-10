import { Elysia, t } from "elysia";
import { join } from "path";
import { getMangaList, getManga, getPages, getMangaDir } from "../scanner";
import type { MangaDetail } from "../types";

const NOW_SECS = Math.floor(Date.now() / 1000);

// Suwayomi-compatible API routes for the TachiDesk Paperback extension
export const paperbackRoutes = new Elysia({ prefix: "/api/v1" })
  // The extension fetches categories to list manga
  .get("/category", () => {
    const list = getMangaList();
    // Return a single "default" category containing all manga
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
  .get("/category/:id", ({ params }) => {
    // Return all manga in this category (we only have one)
    const list = getMangaList();
    return list.map((m, index) => toSuwayomiManga(getManga(m.id)!, index));
  }, {
    params: t.Object({ id: t.String() }),
  })
  // Manga details
  .get("/manga/:id", ({ params, set }) => {
    const manga = findMangaByNumericId(params.id);
    if (!manga) {
      set.status = 404;
      return { error: "Not found" };
    }
    return toSuwayomiManga(manga, parseInt(params.id));
  }, {
    params: t.Object({ id: t.String() }),
  })
  .get("/manga/:id/full", ({ params, set }) => {
    const manga = findMangaByNumericId(params.id);
    if (!manga) {
      set.status = 404;
      return { error: "Not found" };
    }
    return toSuwayomiManga(manga, parseInt(params.id));
  }, {
    params: t.Object({ id: t.String() }),
  })
  // Manga thumbnail - serves the cover image directly
  .get("/manga/:id/thumbnail", async ({ params, set }) => {
    const manga = findMangaByNumericId(params.id);
    if (!manga || !manga.coverUrl) {
      set.status = 404;
      return { error: "Not found" };
    }
    const imgPath = join(getMangaDir(), manga.coverUrl.replace("/api/images/", ""));
    const file = Bun.file(imgPath);
    if (!(await file.exists())) {
      set.status = 404;
      return { error: "Image file not found" };
    }
    set.headers["cache-control"] = "public, max-age=86400";
    return file;
  }, {
    params: t.Object({ id: t.String() }),
  })
  // Chapter list
  .get("/manga/:id/chapters", ({ params, set }) => {
    const manga = findMangaByNumericId(params.id);
    if (!manga) {
      set.status = 404;
      return { error: "Not found" };
    }
    return manga.chapters.map((ch, index) => toSuwayomiChapter(ch, index, parseInt(params.id), manga.chapterCount));
  }, {
    params: t.Object({ id: t.String() }),
  })
  // Chapter detail
  .get("/manga/:id/chapter/:chapterId", ({ params, set }) => {
    const manga = findMangaByNumericId(params.id);
    if (!manga) {
      set.status = 404;
      return { error: "Not found" };
    }
    const chIdx = parseInt(params.chapterId);
    const chapter = manga.chapters[chIdx];
    if (!chapter) {
      set.status = 404;
      return { error: "Chapter not found" };
    }
    return toSuwayomiChapter(chapter, chIdx, parseInt(params.id), manga.chapterCount);
  }, {
    params: t.Object({ id: t.String(), chapterId: t.String() }),
  })
  // Chapter read marking - extension PATCHes this to mark chapters as read
  .patch("/manga/:id/chapter/:chapterId", ({ params }) => {
    // We don't persist read state, just acknowledge the request
    return { success: true };
  }, {
    params: t.Object({ id: t.String(), chapterId: t.String() }),
  })
  // Page image - the extension requests /api/v1/manga/{id}/chapter/{id}/page/{pageIndex}
  .get("/manga/:id/chapter/:chapterId/page/:pageIndex", async ({ params, set }) => {
    const manga = findMangaByNumericId(params.id);
    if (!manga) {
      console.log(`  page: manga ${params.id} not found`);
      set.status = 404;
      return { error: "Not found" };
    }
    const chIdx = parseInt(params.chapterId);
    const chapter = manga.chapters[chIdx];
    if (!chapter) {
      console.log(`  page: chapter ${params.chapterId} not found in ${manga.title} (has ${manga.chapters.length} chapters)`);
      set.status = 404;
      return { error: "Chapter not found" };
    }

    const pages = await getPages(manga.id, chapter.id);
    const pageIdx = parseInt(params.pageIndex);
    const page = pages[pageIdx];
    if (!page) {
      console.log(`  page: page ${params.pageIndex} not found in ${chapter.title} (has ${pages.length} pages)`);
      set.status = 404;
      return { error: "Page not found" };
    }

    // Serve the image directly - Paperback doesn't follow redirects
    const imgPath = join(getMangaDir(), page.url.replace("/api/images/", ""));
    console.log(`  page: serving ${imgPath}`);
    const file = Bun.file(imgPath);
    if (!(await file.exists())) {
      set.status = 404;
      return { error: "Image file not found" };
    }
    set.headers["cache-control"] = "public, max-age=86400";
    return file;
  }, {
    params: t.Object({ id: t.String(), chapterId: t.String(), pageIndex: t.String() }),
  })
  // Settings/about - extension uses this to test connectivity
  .get("/settings/about", () => ({
    name: "Paperbox",
    version: "1.0.0",
    revision: "1",
  }))
  // Source list - the Tachidesk Paperback extension queries this to discover available sources
  .get("/source/list", () => [
    {
      id: "paperbox",
      name: "Paperbox",
      lang: "en",
      iconUrl: "/api/v1/extension/icon/paperbox",
      supportsLatest: false,
      isConfigurable: false,
      isNsfw: false,
      displayName: "Paperbox",
    },
  ])
  // Popular/latest per source
  .get("/source/:id/popular/:page", ({ params }) => {
    const list = getMangaList();
    return { mangaList: list.map((m, i) => toSuwayomiManga(getManga(m.id)!, i)), hasNextPage: false };
  }, {
    params: t.Object({ id: t.String(), page: t.String() }),
  })
  .get("/source/:id/latest/:page", ({ params }) => {
    const list = getMangaList();
    return { mangaList: list.map((m, i) => toSuwayomiManga(getManga(m.id)!, i)), hasNextPage: false };
  }, {
    params: t.Object({ id: t.String(), page: t.String() }),
  })
  // Recently updated
  .get("/update/recentChapters/:page", () => ({
    page: [],
    hasNextPage: false,
  }));

// -- Helpers --

function findMangaByNumericId(numId: string): MangaDetail | undefined {
  const list = getMangaList();
  const idx = parseInt(numId);
  if (idx < 0 || idx >= list.length) return undefined;
  return getManga(list[idx].id);
}

function toSuwayomiManga(manga: MangaDetail, numId: number) {
  return {
    id: numId,
    sourceId: "paperbox",
    url: `/manga/${numId}`,
    title: manga.title,
    thumbnailUrl: `/api/v1/manga/${numId}/thumbnail`,
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
      id: "paperbox",
      name: "Paperbox",
      lang: "en",
      iconUrl: "",
      supportsLatest: false,
      isConfigurable: false,
      isNsfw: false,
      displayName: "Paperbox",
    },
    meta: {},
    realUrl: "",
    lastFetchedAt: NOW_SECS,
    chaptersLastFetchedAt: NOW_SECS,
    updateStrategy: "ALWAYS_UPDATE",
    freshData: true,
    unreadCount: manga.chapterCount,
    downloadCount: manga.chapterCount,
    chapterCount: manga.chapterCount,
    lastReadAt: 0,
    age: 0,
    chaptersAge: 0,
  };
}

function toSuwayomiChapter(ch: MangaDetail["chapters"][number], index: number, mangaId: number, chapterCount: number) {
  return {
    id: index,
    url: `/manga/${mangaId}/chapter/${index}`,
    name: ch.title,
    uploadDate: NOW_SECS * 1000,
    chapterNumber: ch.number,
    scanlator: "",
    mangaId: mangaId,
    read: false,
    bookmarked: false,
    lastPageRead: 0,
    lastReadAt: 0,
    index: index,
    fetchedAt: NOW_SECS,
    realUrl: "",
    downloaded: true,
    pageCount: ch.pageCount,
    chapterCount: chapterCount,
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
