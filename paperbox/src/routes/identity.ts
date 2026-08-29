/**
 * /api/identity — the registry binding.
 *
 * The split that matters is which of these touch the network:
 *
 *   GET  /api/identity                       stored only, free
 *   GET  /api/identity/providers             stored only, free
 *   GET  /api/identity/:id                   stored only, free
 *   POST /api/identity/:id/identify          1 search + <=5 card reads
 *   GET  /api/identity/:id/search?q=         1 search + <=5 card reads
 *   POST /api/identity/:id/confirm           1 card read
 *   POST /api/identity/:id/reject            free
 *   POST /api/identity/:id/files-only        free
 *   POST /api/identity/:id/seasons           free
 *
 * Everything a page render can reach is in the free half, so a client that
 * re-renders costs a stranger's API nothing. The paid half is only ever reached
 * by somebody clicking, and it is serialised at one request per second inside
 * the provider (src/identity/net.ts).
 */

import { Elysia, t } from "elysia";
import {
  allBindings,
  confirm,
  filesOnly,
  getBinding,
  identify,
  providerStatuses,
  reject,
  search,
  setSeasons,
} from "../identity";

export const identityRoutes = new Elysia({ prefix: "/api" })
  .get("/identity", () => allBindings())

  /**
   * Which registries exist, and which are connected.
   *
   * Declared before `/identity/:seriesId` so the static segment wins the route
   * match. `unconfigured` is a real state and this is what lets the workbench
   * name the slot without inventing one per binding.
   */
  .get("/identity/providers", () => ({ providers: providerStatuses() }))

  .get(
    "/identity/:seriesId",
    ({ params, set }) => {
      const b = getBinding(params.seriesId);
      if (!b) {
        set.status = 404;
        return { error: "Manga not found" };
      }
      return b;
    },
    { params: t.Object({ seriesId: t.String() }) },
  )

  /**
   * Look this one up now.
   *
   * `force` exists for one case: re-running against a binding the *machine*
   * made. A human binding is refreshed, never replaced, and `force` does not
   * change that -- it only skips the shortcut that returns early.
   */
  .post(
    "/identity/:seriesId/identify",
    async ({ params, query, set }) => {
      const b = await identify(params.seriesId, { force: query.force === "1" });
      if (!b) {
        set.status = 404;
        return { error: "Manga not found" };
      }
      return b;
    },
    {
      params: t.Object({ seriesId: t.String() }),
      query: t.Object({ force: t.Optional(t.String()) }),
    },
  )

  /**
   * The user searches a title themselves.
   *
   * Returns only candidates that might be correct. A disproven one is discarded
   * here exactly as it is on an automatic match -- the bar belongs to the
   * evidence, not to who asked.
   */
  .get(
    "/identity/:seriesId/search",
    async ({ params, query, set }) => {
      if (!getBinding(params.seriesId)) {
        set.status = 404;
        return { error: "Manga not found" };
      }
      return { data: await search(params.seriesId, query.q ?? "") };
    },
    {
      params: t.Object({ seriesId: t.String() }),
      query: t.Object({ q: t.Optional(t.String()) }),
    },
  )

  .post(
    "/identity/:seriesId/confirm",
    async ({ params, body, set }) => {
      try {
        const b = await confirm(params.seriesId, body.provider, body.registryId);
        if (!b) {
          set.status = 404;
          return { error: "Manga not found" };
        }
        return b;
      } catch (e) {
        set.status = 400;
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    {
      params: t.Object({ seriesId: t.String() }),
      body: t.Object({ provider: t.String(), registryId: t.String() }),
    },
  )

  .post(
    "/identity/:seriesId/reject",
    async ({ params, set }) => {
      const b = await reject(params.seriesId);
      if (!b) {
        set.status = 404;
        return { error: "Manga not found" };
      }
      return b;
    },
    { params: t.Object({ seriesId: t.String() }) },
  )

  .post(
    "/identity/:seriesId/files-only",
    async ({ params, set }) => {
      const b = await filesOnly(params.seriesId);
      if (!b) {
        set.status = 404;
        return { error: "Manga not found" };
      }
      return b;
    },
    { params: t.Object({ seriesId: t.String() }) },
  )

  /**
   * Season boundaries a person confirmed.
   *
   * Its own endpoint because seasons must never arrive any other way: upstream
   * they are markdown prose in a free-text field, and an automatic import would
   * draw dividers through somebody's library on the strength of a regex.
   * Nothing in the web client calls this yet -- see docs/api-gaps.md.
   */
  .post(
    "/identity/:seriesId/seasons",
    async ({ params, body, set }) => {
      const b = await setSeasons(params.seriesId, body.seasons);
      if (!b) {
        set.status = 404;
        return { error: "No binding to attach seasons to" };
      }
      return b;
    },
    {
      params: t.Object({ seriesId: t.String() }),
      body: t.Object({
        seasons: t.Array(t.Object({ name: t.String(), endAfterSortKey: t.Integer() })),
      }),
    },
  );
