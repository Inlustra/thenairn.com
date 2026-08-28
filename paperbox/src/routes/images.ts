import { Elysia } from "elysia";
import { getMangaDir } from "../scanner";
import { resolveWithin, tryDecode } from "../safepath";

export const imageRoutes = new Elysia()
  .get("/api/images/*", async ({ params, set }) => {
    const rawPath = (params as any)["*"];
    if (!rawPath) {
      set.status = 400;
      return { error: "Invalid path" };
    }

    // Elysia may or may not decode the wildcard, so both spellings are still
    // tried - but each one goes through containment rather than being joined
    // straight onto the library root. Decoding happens before the check, not
    // after it, which is what let `%2e%2e%2f` walk out of the library.
    const decoded = tryDecode(rawPath);
    const candidates = decoded === rawPath ? [rawPath] : [decoded, rawPath];

    for (const candidate of candidates) {
      const fullPath = await resolveWithin(getMangaDir(), candidate);
      if (fullPath === null) continue;
      const file = Bun.file(fullPath);
      if (await file.exists()) {
        set.headers["cache-control"] = "public, max-age=86400";
        return file;
      }
    }

    set.status = 404;
    return { error: "File not found" };
  });
