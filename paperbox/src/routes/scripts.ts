import { Elysia, t } from "elysia";
import { listScripts, getScript, pullScripts, findScriptForUrl } from "../lua/scripts";
import { runModule } from "../lua/engine";

export const scriptRoutes = new Elysia({ prefix: "/api/scripts" })
  // List available sources
  .get("/", ({ query }) => {
    const scripts = listScripts(query.category as any);
    return {
      data: scripts.map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category,
        rootUrl: s.rootUrl,
      })),
      total: scripts.length,
    };
  }, {
    query: t.Object({
      category: t.Optional(t.String()),
    }),
  })
  // Detect which script handles a given URL
  .get("/detect", ({ query, set }) => {
    if (!query.url) {
      set.status = 400;
      return { error: "url parameter required" };
    }
    const script = findScriptForUrl(query.url);
    if (!script) {
      set.status = 404;
      return { error: "No matching source found for this URL" };
    }
    return { id: script.id, name: script.name, category: script.category, rootUrl: script.rootUrl };
  }, {
    query: t.Object({
      url: t.Optional(t.String()),
    }),
  })
  // Pull/update scripts from GitHub
  .post("/pull", async () => {
    await pullScripts();
    return { ok: true, count: listScripts().length };
  })
  // Search manga using a source script
  .get("/:id/search", async ({ params, query, set }) => {
    const script = getScript(params.id);
    if (!script) {
      set.status = 404;
      return { error: "Script not found" };
    }

    try {
      console.log(`[search] ${script.name}: "${query.q || ""}"`);
      const result = await runModule(script.path, "GetNameAndLink", {
        url: query.q || "",
        pageNumber: Number(query.page) || 1,
      });

      const results = result.search.names.map((name, i) => ({
        name,
        url: result.search.links[i] || "",
      }));

      return { data: results, source: script.name };
    } catch (e: any) {
      console.error(`[search] Failed:`, e);
      set.status = 500;
      return { error: e?.message || "Search failed" };
    }
  }, {
    params: t.Object({ id: t.String() }),
    query: t.Object({
      q: t.Optional(t.String()),
      page: t.Optional(t.String()),
    }),
  })
  // Get manga info from a source
  .get("/:id/info", async ({ params, query, set }) => {
    const script = getScript(params.id);
    if (!script) {
      set.status = 404;
      return { error: "Script not found" };
    }

    if (!query.url) {
      set.status = 400;
      return { error: "url parameter required" };
    }

    try {
      console.log(`[info] ${script.name}: ${query.url}`);
      const result = await runModule(script.path, "GetInfo", {
        url: query.url,
      });

      return {
        manga: result.mangaInfo,
        source: script.name,
      };
    } catch (e: any) {
      console.error(`[info] Failed:`, e);
      set.status = 500;
      return { error: e?.message || "Info fetch failed" };
    }
  }, {
    params: t.Object({ id: t.String() }),
    query: t.Object({
      url: t.Optional(t.String()),
    }),
  });
