import { Elysia, t } from "elysia";
import { join } from "path";
import { getMangaList, getManga, getPages, getMangaDir } from "../scanner";
import type { MangaDetail } from "../types";

// Suwayomi-compatible API routes for the TachiDesk Paperback extension
export const paperbackRoutes = new Elysia({ prefix: "/api/v1" })
  // The extension fetches categories to list manga
  .get("/category", () => {
    // Return a single "default" category containing all manga
    return [{ id: 0, name: "Default", order: 0 }];
  })
  .get("/category/:id", ({ params }) => {
    // Return all manga in this category (we only have one)
    const list = getMangaList();
    return list.map((m, index) => ({
      id: index,
      sourceId: "paperbox",
      url: `/manga/${m.id}`,
      title: m.title,
      thumbnailUrl: m.coverUrl || "",
      artist: m.meta.artist || "",
      author: m.meta.author || "",
      description: m.meta.description || "",
      genre: m.meta.tags || [],
      status: mapStatus(m.meta.status),
      inLibrary: true,
    }));
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
  // Chapter list
  .get("/manga/:id/chapters", ({ params, set }) => {
    const manga = findMangaByNumericId(params.id);
    if (!manga) {
      set.status = 404;
      return { error: "Not found" };
    }
    return manga.chapters.map((ch, index) => ({
      id: index,
      url: `/manga/${params.id}/chapter/${index}`,
      name: ch.title,
      chapterNumber: ch.number,
      scanlator: "",
      mangaId: parseInt(params.id),
      read: false,
      bookmarked: false,
      lastPageRead: 0,
      pageCount: ch.pageCount,
      index: index,
      uploadDate: 0,
      downloaded: true,
    }));
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
    return {
      id: chIdx,
      url: `/manga/${params.id}/chapter/${params.chapterId}`,
      name: chapter.title,
      chapterNumber: chapter.number,
      mangaId: parseInt(params.id),
      read: false,
      bookmarked: false,
      lastPageRead: 0,
      pageCount: chapter.pageCount,
      index: chIdx,
      uploadDate: 0,
      downloaded: true,
    };
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
  // Source list - extension may request this
  .get("/source/list", () => [])
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
    url: `/manga/${manga.id}`,
    title: manga.title,
    thumbnailUrl: manga.coverUrl || "",
    artist: manga.meta.artist || "",
    author: manga.meta.author || "",
    description: manga.meta.description || "",
    genre: manga.meta.tags || [],
    status: mapStatus(manga.meta.status),
    inLibrary: true,
    source: { id: "paperbox", name: "Paperbox" },
    realUrl: "",
    freshData: true,
    unreadCount: 0,
    downloadCount: 0,
    chapterCount: manga.chapterCount,
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
