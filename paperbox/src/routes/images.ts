import { Elysia } from "elysia";
import { extname } from "path";
import { getMangaDir, IMAGE_EXTS } from "../scanner";
import { resolveWithin, tryDecode } from "../safepath";

export const imageRoutes = new Elysia()
  .get("/api/images/*", async ({ params, set }) => {
    const rawPath = (params as any)["*"];
    if (!rawPath) {
      set.status = 400;
      return { error: "Invalid path" };
    }

    // Containment keeps the read inside the library; it says nothing about
    // *what* is read. This route served every file under the library root, so
    // `paperbox.json` (uids, pinned api ids, per-chapter provenance),
    // `manga.json` and `source-info.json` all came back 200 with
    // `cache-control: public, max-age=86400` -- cached by every proxy in front
    // of it. The extension is checked on the requested path rather than the
    // resolved one so a rejection costs no filesystem work.
    if (!IMAGE_EXTS.has(extname(tryDecode(rawPath)).toLowerCase())) {
      set.status = 404;
      return { error: "File not found" };
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
