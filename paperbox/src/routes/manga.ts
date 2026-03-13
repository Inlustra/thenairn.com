import { Elysia, t } from "elysia";
import { join } from "path";
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
      });

      // Find the original folder name on disk
      const { readdir } = await import("fs/promises");
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
      await saveMetadata(seriesDir, infoResult.mangaInfo, manga.title, body.url);
      await scan();

      return { ok: true, manga: getManga(params.id) };
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
  .post("/scan", async () => {
    await scan();
    return { ok: true, count: getMangaList().length, lastScan: getLastScan() };
  })
  .get("/status", () => ({
    mangaDir: getMangaDir(),
    mangaCount: getMangaList().length,
    lastScan: getLastScan(),
  }));
