import { Elysia, t } from "elysia";
import {
  createTask,
  getTask,
  listTasks,
  cancelTask,
  retryTask,
  removeTask,
  getConfig,
  setConfig,
} from "../downloads/manager";

export const downloadRoutes = new Elysia({ prefix: "/api/downloads" })
  // Get/set download config
  .get("/config", () => getConfig())
  .patch("/config", ({ body }) => setConfig(body), {
    body: t.Object({
      parallelPages: t.Optional(t.Number()),
      parallelChapters: t.Optional(t.Number()),
      retries: t.Optional(t.Number()),
      retryDelayMs: t.Optional(t.Number()),
    }),
  })
  // List all download tasks
  .get("/", () => {
    return { data: listTasks() };
  })
  // Get a specific task
  .get("/:id", ({ params, set }) => {
    const task = getTask(params.id);
    if (!task) {
      set.status = 404;
      return { error: "Task not found" };
    }
    return task;
  }, {
    params: t.Object({ id: t.String() }),
  })
  // Create a new download task
  .post("/", ({ body, set }) => {
    if (!body.mangaTitle || !body.sourceId || !body.chapters?.length) {
      set.status = 400;
      return { error: "mangaTitle, sourceId, and chapters are required" };
    }

    const task = createTask({
      mangaTitle: body.mangaTitle,
      sourceId: body.sourceId,
      mangaUrl: body.mangaUrl || "",
      chapters: body.chapters,
    });

    console.log(`[download] Created task ${task.id}: ${task.mangaTitle} (${task.chapters.length} chapters)`);
    set.status = 201;
    return task;
  }, {
    body: t.Object({
      mangaTitle: t.String(),
      sourceId: t.String(),
      mangaUrl: t.Optional(t.String()),
      chapters: t.Array(
        t.Object({
          name: t.String(),
          url: t.String(),
        })
      ),
    }),
  })
  // Cancel a task
  .post("/:id/cancel", ({ params, set }) => {
    if (cancelTask(params.id)) {
      return { ok: true };
    }
    set.status = 404;
    return { error: "Task not found or already finished" };
  }, {
    params: t.Object({ id: t.String() }),
  })
  // Retry failed chapters in a task
  .post("/:id/retry", ({ params, set }) => {
    if (retryTask(params.id)) {
      return { ok: true };
    }
    set.status = 404;
    return { error: "Task not found" };
  }, {
    params: t.Object({ id: t.String() }),
  })
  // Remove a task from the list
  .delete("/:id", ({ params, set }) => {
    if (removeTask(params.id)) {
      return { ok: true };
    }
    set.status = 404;
    return { error: "Task not found" };
  }, {
    params: t.Object({ id: t.String() }),
  });
