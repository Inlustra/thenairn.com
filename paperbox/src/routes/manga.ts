import { Elysia, t } from "elysia";
import { join } from "path";
import { readFile, writeFile } from "fs/promises";
import { getMangaList, getManga, scan, getLastScan, getMangaDir,
         getScanProgress } from "../scanner";
import { runModule } from "../lua/engine";
import { getScript, listScripts, getScriptsSignature } from "../lua/scripts";
import { saveMetadata, summariseDownloads } from "../downloads/manager";
import { buildTree } from "../hashes";

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

      // The directory is carried on the record, not re-derived by slugifying
      // every entry: slugs are de-duplicated at scan time, so a series whose
      // name collides with another's answers to `re-zero-2` and no directory
      // slugifies to that.
      const mangaDir = getMangaDir();
      const folderName = manga.dir;
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
    // As above: the record's own `dir`, never a slug round-trip.
    const folderName = manga.dir;
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
  /**
   * One envelope for the whole system.
   *
   * A client should never have to poll a dozen endpoints to learn whether
   * anything happened. Each subsystem reports a monotonic `rev`: poll this,
   * compare, and fetch detail only for what moved. Same idea as the sync tree,
   * one layer up -- cheap discrimination first, detail on demand.
   *
   * ETag'd, so an unchanged poll costs a 304 and no body at all.
   */
  .get("/status", ({ headers, set }) => {
    const list = getMangaList();
    const scan = getScanProgress();
    const downloads = summariseDownloads();
    const scripts = listScripts();

    const body = {
      server: {
        name: "Paperbox",
        startedAt: STARTED_AT,
        uptimeMs: Date.now() - STARTED_AT,
      },
      library: {
        // Every signal in this envelope is derived from the thing it describes,
        // never from a counter. A counter answers "did we do work"; a content
        // signal answers "did anything change", and only the second is what a
        // polling client is asking. A scan loop every 30s would make the first
        // churn forever and this endpoint would never return 304.
        sig: buildTree().hash,
        dir: getMangaDir(),
        series: list.length,
        chapters: list.reduce((n, m) => n + m.chapterCount, 0),
        lastScan: getLastScan(),
      },
      scan,
      downloads,
      sources: { sig: getScriptsSignature(), count: scripts.length },
    };

    // The revs are the whole state as far as a poller is concerned.
    // Weak, and deliberately semantic: it answers "has anything meaningful
    // moved", not "are these bytes identical" (uptimeMs always differs).
    const etag = `W/"${body.library.sig}.${body.downloads.sig}.${body.sources.sig}.${scan.active ? scan.seriesDone : "i"}"`;
    set.headers["etag"] = etag;
    set.headers["cache-control"] = "no-cache";
    if (headers["if-none-match"] === etag) {
      set.status = 304;
      return "";
    }
    return body;
  });

const STARTED_AT = Date.now();
