import { Elysia, t } from "elysia";
import { getManga, getPages } from "../scanner";

export const chapterRoutes = new Elysia({ prefix: "/api" })
  .get("/manga/:id/chapters", ({ params, set }) => {
    const manga = getManga(params.id);
    if (!manga) {
      set.status = 404;
      return { error: "Manga not found" };
    }
    return { data: manga.chapters };
  }, {
    params: t.Object({ id: t.String() }),
  })
  .get("/manga/:id/chapters/:chapterId/pages", async ({ params, set }) => {
    const pages = await getPages(params.id, params.chapterId);
    if (pages.length === 0) {
      const manga = getManga(params.id);
      if (!manga) {
        set.status = 404;
        return { error: "Manga not found" };
      }
      const chapter = manga.chapters.find((c) => c.id === params.chapterId);
      if (!chapter) {
        set.status = 404;
        return { error: "Chapter not found" };
      }
    }
    return { data: pages };
  }, {
    params: t.Object({ id: t.String(), chapterId: t.String() }),
  });
