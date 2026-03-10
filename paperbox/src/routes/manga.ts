import { Elysia, t } from "elysia";
import { getMangaList, getManga, scan, getLastScan, getMangaDir } from "../scanner";

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
  .post("/scan", async () => {
    await scan();
    return { ok: true, count: getMangaList().length, lastScan: getLastScan() };
  })
  .get("/status", () => ({
    mangaDir: getMangaDir(),
    mangaCount: getMangaList().length,
    lastScan: getLastScan(),
  }));
