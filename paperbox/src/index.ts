import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import { mangaRoutes } from "./routes/manga";
import { chapterRoutes } from "./routes/chapters";
import { imageRoutes } from "./routes/images";
import { paperbackRoutes } from "./routes/paperback";
import { scriptRoutes } from "./routes/scripts";
import { downloadRoutes } from "./routes/downloads";
import { scan } from "./scanner";
import { pullScripts, scanScripts } from "./lua/scripts";

const PORT = process.env.PORT || 3000;

const app = new Elysia()
  .use(cors())
  .onRequest(({ request }) => {
    const url = new URL(request.url);
    console.log(`→ ${request.method} ${url.pathname}${url.search}`);
  })
  .onAfterResponse(({ request, set }) => {
    const url = new URL(request.url);
    const status = typeof set.status === "number" ? set.status : 200;
    const redirect = (set as any).redirect;
    const extra = redirect ? ` → redirect: ${redirect}` : "";
    if (status >= 400) {
      console.log(`← ${status} ${url.pathname}${extra}`);
    }
  })
  .onError(({ request, code, error }) => {
    const url = new URL(request.url);
    console.error(`✗ ${code} ${url.pathname}: ${"message" in error ? error.message : error}`);
  })
  .use(mangaRoutes)
  .use(chapterRoutes)
  .use(imageRoutes)
  .use(paperbackRoutes)
  .use(scriptRoutes)
  .use(downloadRoutes)
  .use(staticPlugin({ assets: "frontend/dist", prefix: "/" }))
  .get("/", () => Bun.file("frontend/dist/index.html"))
  .get("/paperback", () => Bun.file("frontend/paperback.html"))
  .listen(PORT);

// Initial setup
async function init() {
  await scan();

  // Pull scripts if not already present, otherwise just scan
  try {
    await pullScripts();
  } catch (e) {
    console.error("Failed to pull scripts, scanning local:", e);
    await scanScripts();
  }

  console.log(`Paperbox running at http://localhost:${PORT}`);
}

init();

export type App = typeof app;
