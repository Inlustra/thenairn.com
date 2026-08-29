import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import { mangaRoutes } from "./routes/manga";
import { chapterRoutes } from "./routes/chapters";
import { imageRoutes } from "./routes/images";
import { paperbackRoutes } from "./routes/paperback";
import { scriptRoutes } from "./routes/scripts";
import { downloadRoutes } from "./routes/downloads";
import { syncRoutes } from "./routes/sync";
import { graphqlRoutes } from "./routes/graphql";
import { artRoutes } from "./routes/art";
import { jobRoutes } from "./routes/jobs";
import { identityRoutes } from "./routes/identity";
import { scan } from "./scanner";
import { pullScripts, scanScripts } from "./lua/scripts";
import { startJobs, startScheduler, runToCompletion, getBudget } from "./jobs";

const PORT = process.env.PORT || 3000;

const app = new Elysia()
  .use(cors())
  .onRequest(({ request }) => {
    // The idle detector's only input. It is an accelerator, never a gate
    // (docs/scheduler.md section 2c): a request never stops background work,
    // it only drops it back from the idle duty to the at-rest one.
    getBudget()?.noteRequest();
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
  .use(syncRoutes)
  .use(artRoutes)
  .use(jobRoutes)
  .use(identityRoutes)
  .use(graphqlRoutes)
  .use(staticPlugin({ assets: "frontend/dist", prefix: "/" }))
  .get("/", () => Bun.file("frontend/dist/index.html"))
  .get("/paperback", () => Bun.file("frontend/paperback.html"))
  .listen(PORT);

// Initial setup
async function init() {
  // Opened before the scan: read state is the one thing here that cannot be
  // rebuilt by rescanning, so a failure to open it should be visible in the
  // log above everything else, not buried after a minute of scanning.

  // The queue first, and the rotation deliberately not yet: the first scan is
  // itself a job, and the rotation cannot start until something has been
  // scanned, because it addresses series by uid and nothing has a uid before
  // then.
  const queued = startJobs({ scheduler: false });

  // First run is a **foreground errand** -- `docs/scheduler.md` section 1:
  // full concurrency, no duty cap, a percentage on screen, because the user is
  // watching a cold library come up. It is not `silent`, so it is exactly that.
  //
  // Awaited rather than fired and forgotten, so nothing below it -- the
  // rotation especially -- runs against an empty cache. There is no artwork
  // backfill here any more: this scan's own discovery pass queues every missing
  // spine, cover and pixel height, for content that already exists as much as
  // for content that arrives later. That is the point of the pass.
  if (!queued || !(await runToCompletion({ kind: "scan", label: "Scan library" }))) {
    // No queue: the library still has to be readable, so scan directly. The
    // derived work simply does not happen this run, which is what "background
    // work is disabled for this run" already meant.
    await scan();
  }

  startScheduler();

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
