import { Elysia, t } from "elysia";
import { getChapterByUid, getMangaByUid, getMangaDir } from "../scanner";
import { find, readJson, spineKey, coverKey, resolveCoverSource, type Tint } from "../art";
import { join } from "path";

/**
 * Derived artwork.
 *
 * -------------------------------------------------------------------------
 * 404 when it has not been generated. Never a placeholder.
 * -------------------------------------------------------------------------
 * `ui.md`: *"Only a real book has a face. Pencil states carry no artwork,
 * because those pages are not on disk to cut from."* And, on the web client:
 * *"theatre is worse than absence."* A generated stand-in -- a grey rectangle,
 * a letter, a hashed colour -- would be a picture the client cannot tell from a
 * real one, so a shelf mid-backfill would look finished and wrong instead of
 * unfinished and honest. The 404 is the signal that the pencil layer is the
 * correct rendering.
 *
 * -------------------------------------------------------------------------
 * The cache headers are safe *because* the key is content-addressed
 * -------------------------------------------------------------------------
 * A URL here is `/api/art/spine/<chapterUid>`, which is stable across content
 * changes -- so a long `max-age` on its own would pin a stale picture in every
 * proxy between here and the reader. What makes it safe is that the ETag is the
 * store key, and the store key contains the chapter's fingerprint and
 * ART_VERSION. `must-revalidate` plus a strong ETag gives a 304 on the common
 * path and a new body the instant either input moves.
 */
export const artRoutes = new Elysia({ prefix: "/api/art" })
  .get(
    "/spine/:chapterUid",
    async ({ params, headers, set }) => {
      const found = getChapterByUid(params.chapterUid);
      if (!found) {
        set.status = 404;
        return { error: "Chapter not found" };
      }
      const key = spineKey(found.chapter.uid, found.chapter.fingerprint);
      const art = await find("spine", key);
      if (!art) {
        // Not an error, and deliberately not a placeholder: the artwork has not
        // been derived yet. The shelf draws pencil.
        set.status = 404;
        return { error: "Not generated" };
      }
      set.headers["etag"] = art.etag;
      set.headers["cache-control"] = "public, max-age=31536000, must-revalidate";
      if (headers["if-none-match"] === art.etag) {
        set.status = 304;
        return "";
      }
      return Bun.file(art.path);
    },
    { params: t.Object({ chapterUid: t.String() }) },
  )

  /**
   * The chapter's dominant colour and the foot band's text colour.
   *
   * Served beside the picture rather than inside it because the shelf needs the
   * colour to lay out a spine it may not have loaded the artwork for yet, and
   * because `ui.md` picks the numeral's colour by luminance -- which is a
   * decision the client makes at paint time, from a number.
   */
  .get(
    "/tint/:chapterUid",
    async ({ params, headers, set }) => {
      const found = getChapterByUid(params.chapterUid);
      if (!found) {
        set.status = 404;
        return { error: "Chapter not found" };
      }
      const key = spineKey(found.chapter.uid, found.chapter.fingerprint);
      const tint = await readJson<Tint>("tint", key);
      if (!tint) {
        set.status = 404;
        return { error: "Not generated" };
      }
      const etag = `"tint-${key}"`;
      set.headers["etag"] = etag;
      set.headers["cache-control"] = "public, max-age=31536000, must-revalidate";
      if (headers["if-none-match"] === etag) {
        set.status = 304;
        return "";
      }
      return tint;
    },
    { params: t.Object({ chapterUid: t.String() }) },
  )

  .get(
    "/cover/:seriesUid",
    async ({ params, headers, set }) => {
      const manga = getMangaByUid(params.seriesUid);
      if (!manga) {
        set.status = 404;
        return { error: "Series not found" };
      }
      // The key depends on which file the cover was derived *from*, so it is
      // resolved rather than remembered. One readdir of a series directory,
      // against a picture that is then cached for a year.
      const source = await resolveCoverSource(
        join(getMangaDir(), manga.dir),
        manga.series.cover,
        manga.chapters.map((c) => c.dir),
      );
      if (!source) {
        set.status = 404;
        return { error: "Not generated" };
      }
      const art = await find("cover", coverKey(manga.uid, source.sig));
      if (!art) {
        set.status = 404;
        return { error: "Not generated" };
      }
      set.headers["etag"] = art.etag;
      set.headers["cache-control"] = "public, max-age=31536000, must-revalidate";
      if (headers["if-none-match"] === art.etag) {
        set.status = 304;
        return "";
      }
      return Bun.file(art.path);
    },
    { params: t.Object({ seriesUid: t.String() }) },
  );
