import { Elysia, t } from "elysia";
import { getJobs, getScheduler, enqueueNow } from "../jobs";

const JobSchema = t.Object({
  id: t.String(),
  kind: t.Union([t.Literal("scan"), t.Literal("art"), t.Literal("cover")]),
  scope: t.Union([t.String(), t.Null()]),
  label: t.String(),
  state: t.Union([
    t.Literal("queued"),
    t.Literal("running"),
    t.Literal("done"),
    t.Literal("failed"),
    t.Literal("cancelled"),
  ]),
  done: t.Integer(),
  total: t.Union([t.Integer(), t.Null()]),
  startedAt: t.Union([t.Integer(), t.Null()]),
  finishedAt: t.Union([t.Integer(), t.Null()]),
  error: t.Union([t.String(), t.Null()]),
});

export const jobRoutes = new Elysia({ prefix: "/api" })
  /**
   * Everything the background pipeline is doing.
   *
   * ETag'd exactly like `/api/status`: the signature is derived from what a
   * client renders, never from a counter, so an unchanged poll costs a 304 and
   * no body. A counter would churn on every prune and the endpoint would never
   * revalidate -- see `docs/decisions.md`, "Every status signal is
   * content-derived, never a counter".
   *
   * Note what is *not* here: the rolling background scan. `docs/scheduler.md`
   * section 3 is explicit that a scan nobody asked for gets no spinner and no
   * count, so it is not a job and never appears in this list. Its freshness
   * lives on `/api/status` instead, as dated facts rather than as progress.
   */
  .get(
    "/jobs",
    ({ headers, set }) => {
      const queue = getJobs();
      if (!queue) {
        set.status = 503;
        return { jobs: [], running: 0, queued: 0 };
      }
      const etag = `W/"jobs-${queue.signature()}"`;
      set.headers["etag"] = etag;
      set.headers["cache-control"] = "no-cache";
      if (headers["if-none-match"] === etag) {
        set.status = 304;
        return { jobs: [], running: 0, queued: 0 };
      }
      const counts = queue.counts();
      return { jobs: queue.list(), running: counts.running, queued: counts.queued };
    },
    {
      response: t.Object({
        jobs: t.Array(JobSchema),
        running: t.Integer(),
        queued: t.Integer(),
      }),
    },
  )

  /**
   * Cancel one job.
   *
   * Idempotent, and it answers `{ ok: true }` for a job that is already
   * finished: the caller asked for it not to be running, and it is not. A 409
   * here would put a retry affordance in front of a user for a condition that
   * has already resolved itself, which `docs/decisions.md` rejects outright.
   * A missing id is still a 404 -- that is a client bug, not weather.
   */
  .post(
    "/jobs/:id/cancel",
    ({ params, set }) => {
      const queue = getJobs();
      if (!queue) {
        set.status = 503;
        return { ok: false as const };
      }
      if (!queue.get(params.id)) {
        set.status = 404;
        return { ok: false as const };
      }
      queue.cancel(params.id);
      return { ok: true as const };
    },
    { params: t.Object({ id: t.String() }) },
  )

  /**
   * Ask for artwork to be derived.
   *
   * Deduplicated by the queue's partial unique index, so a client that fires
   * this on every render of a shelf gets one job, not one per render.
   */
  .post(
    "/jobs/art",
    ({ body, set }) => {
      const job = enqueueNow({
        kind: "art",
        scope: body.scope ?? null,
        label: body.label ?? "Library artwork",
      });
      if (!job) {
        set.status = 503;
        return { error: "background work is disabled" };
      }
      return job;
    },
    {
      body: t.Object({
        scope: t.Optional(t.Union([t.String(), t.Null()])),
        label: t.Optional(t.String()),
      }),
    },
  )

  /**
   * How fresh the library's knowledge is.
   *
   * Not progress. `docs/scheduler.md` section 3: freshness is the pencil layer
   * applied to time, rendered as dated sentences ("Last looked at Tuesday"),
   * never as a ticking number -- it is not something the user can influence.
   * `behind` is the amber condition, and it deliberately carries no retry.
   */
  .get("/scan/freshness", ({ set }) => {
    const scheduler = getScheduler();
    if (!scheduler) {
      set.status = 503;
      return { error: "the rolling scan is not running" };
    }
    return { ...scheduler.status(), series: scheduler.freshness() };
  });
