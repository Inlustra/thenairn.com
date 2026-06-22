import { Elysia, t } from "elysia";
import { join } from "path";
import { readFile, writeFile, readdir } from "fs/promises";
import { getMangaList, getManga, scan, getLastScan, getMangaDir } from "../scanner";
import { runModule } from "../lua/engine";
import { getScript } from "../lua/scripts";
import { saveMetadata } from "../downloads/manager";

export const mangaRoutes = new Elysia({ prefix: "/api" })
  .get("/manga", ({ query }) => {
    const list = getMangaList();
    const search = query.search?.toLowerCase();
    const filtered = search
      ? list.filter((m) => m.title.toLowerCase().includes(search))
      : list;

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const start = (page - 1) * limit;

    return {
      data: filtered.slice(start, start + limit),
      total: filtered.length,
      page,
      limit,
    };
  }, {
    query: t.Object({
      search: t.Optional(t.String()),
      page: t.Optional(t.String()),
      limit: t.Optional(t.String()),
    }),
  })
  .get("/manga/:id", ({ params, set }) => {
    const manga = getManga(params.id);
    if (!manga) {
      set.status = 404;
      return { error: "Manga not found" };
    }
    return manga;
  }, {
    params: t.Object({ id: t.String() }),
  })
  .post("/manga/:id/refresh", async ({ params, body, set }) => {
    const manga = getManga(params.id);
    if (!manga) {
      set.status = 404;
      return { error: "Manga not found" };
    }

    const script = getScript(body.sourceId);
    if (!script) {
      set.status = 404;
      return { error: "Script not found" };
    }

    try {
      const infoResult = await runModule(script.path, "GetInfo", {
        url: body.url,
        rootUrl: script.rootUrl,
      });

      const info = infoResult.mangaInfo;

      // Build a report of what was fetched
      const fetched = {
        title: info.title || null,
        authors: info.authors || null,
        artists: info.artists || null,
        description: info.summary || null,
        status: info.status || null,
        coverLink: info.coverLink || null,
        genres: info.genres || null,
        chapters: info.chapterNames?.length || 0,
      };

      // Find the original folder name on disk
      const mangaDir = getMangaDir();
      const entries = await readdir(mangaDir);
      const slugify = (name: string) =>
        name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const folderName = entries.find((e) => slugify(e) === params.id);
      if (!folderName) {
        set.status = 404;
        return { error: "Manga folder not found on disk" };
      }

      const seriesDir = join(mangaDir, folderName);
      const saveResult = await saveMetadata(seriesDir, info, manga.title, body.url, body.sourceId);
      await scan();

      return { ok: true, manga: getManga(params.id), fetched, coverSaved: saveResult.coverSaved };
    } catch (e: any) {
      console.error(`[refresh] Failed:`, e);
      set.status = 500;
      return { error: e?.message || "Refresh failed" };
    }
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      url: t.String(),
      sourceId: t.String(),
    }),
  })
  .patch("/manga/:id/source", async ({ params, body, set }) => {
    const manga = getManga(params.id);
    if (!manga) {
      set.status = 404;
      return { error: "Manga not found" };
    }

    const mangaDir = getMangaDir();
    const entries = await readdir(mangaDir);
    const slugify = (name: string) =>
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const folderName = entries.find((e) => slugify(e) === params.id);
    if (!folderName) {
      set.status = 404;
      return { error: "Manga folder not found on disk" };
    }

    const metaPath = join(mangaDir, folderName, "manga.json");
    try {
      let meta: Record<string, any> = { title: folderName };
      try {
        const raw = await readFile(metaPath, "utf-8");
        meta = JSON.parse(raw);
      } catch {}
      if (body.sourceId !== undefined) meta.sourceId = body.sourceId;
      if (body.url !== undefined) meta.link = body.url;
      await writeFile(metaPath, JSON.stringify(meta, null, 2));
      await scan();
      return { ok: true, manga: getManga(params.id) };
    } catch (e: any) {
      set.status = 500;
      return { error: e?.message || "Failed to update source" };
    }
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      sourceId: t.Optional(t.String()),
      url: t.Optional(t.String()),
    }),
  })
  .post("/scan", async () => {
    await scan();
    return { ok: true, count: getMangaList().length, lastScan: getLastScan() };
  })
  .get("/status", () => ({
    mangaDir: getMangaDir(),
    mangaCount: getMangaList().length,
    lastScan: getLastScan(),
  }));
