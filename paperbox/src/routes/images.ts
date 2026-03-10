import { Elysia } from "elysia";
import { join } from "path";
import { getMangaDir } from "../scanner";

export const imageRoutes = new Elysia()
  .get("/api/images/*", async ({ params, set }) => {
    const rawPath = (params as any)["*"];
    if (!rawPath || rawPath.includes("..")) {
      set.status = 400;
      return { error: "Invalid path" };
    }

    // Try both raw and decoded - Elysia may or may not decode the wildcard
    const candidates = [
      join(getMangaDir(), rawPath),
      join(getMangaDir(), decodeURIComponent(rawPath)),
    ];

    for (const fullPath of candidates) {
      try {
        const file = Bun.file(fullPath);
        if (await file.exists()) {
          console.log(`  image: found ${fullPath}`);
          set.headers["cache-control"] = "public, max-age=86400";
          return file;
        }
      } catch {}
    }

    console.log(`  image: NOT FOUND, tried:`);
    for (const p of candidates) console.log(`    ${p}`);
    set.status = 404;
    return { error: "File not found" };
  });
