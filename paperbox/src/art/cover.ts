/**
 * Series covers, moved out of the library.
 *
 * Until now the download path wrote `cover.webp` (or `.jpg`, `.png` ...) into
 * the series directory, beside the user's pages. That is the one thing `ui.md`
 * promises never happens, and it happened on every metadata save.
 *
 * -------------------------------------------------------------------------
 * Adopt, never delete
 * -------------------------------------------------------------------------
 * Covers that are already on disk are treated as **input**. They are read,
 * normalised into the derived store, and left exactly where they are. Deleting
 * them is not this pipeline's call to make: some of them were put there by the
 * user, some by Komga or Kavita, and some by an earlier version of Paperbox --
 * and nothing on disk distinguishes the three. See `docs/decisions.md`,
 * "Existing cover.webp files are adopted, not removed".
 *
 * The source signature is part of the key, so replacing `cover.jpg` with a
 * different image changes the key and the old normalisation stops being
 * addressable, with no invalidation step to forget.
 */
import sharp from "sharp";
import { readdir, stat } from "fs/promises";
import { join, extname } from "path";
import { artKey, put, has, type StoredArt } from "./store";

/** Wide enough for a retina library grid, small enough to be free to store. */
const COVER_W = 640;

export type CoverSource =
  | { kind: "file"; sig: string; path: string }
  | { kind: "bytes"; sig: string; bytes: Uint8Array };

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"]);

/**
 * Find what this series' cover should be derived from.
 *
 * Order matters and mirrors what the scanner already does for `coverUrl`, so
 * the store and the legacy image URL cannot disagree about which picture is the
 * cover:
 *
 *   1. the sidecar's `cover`, when it names a file that exists
 *   2. any `cover.<ext>` in the series directory -- what adoption from Komga,
 *      Kavita and older Paperbox all leave behind
 *   3. the first page of the first chapter
 *
 * A remote `cover` URL is deliberately *not* a source here. Fetching from the
 * background worker would make a cache-warm job depend on a third-party host
 * being up; the download path already has the bytes in hand and calls
 * `adoptCoverBytes` with them instead.
 */
export async function resolveCoverSource(
  seriesPath: string,
  sidecarCover: string | undefined,
  chapterDirs: string[],
): Promise<CoverSource | null> {
  const named = sidecarCover && !sidecarCover.startsWith("http") ? sidecarCover : undefined;
  if (named) {
    const p = join(seriesPath, named);
    const s = await stat(p).catch(() => null);
    if (s?.isFile()) return { kind: "file", sig: `file:${named}:${s.size}`, path: p };
  }

  let names: string[] = [];
  try {
    names = await readdir(seriesPath);
  } catch {
    return null;
  }
  const onDisk = names.find((n) => {
    const e = extname(n).toLowerCase();
    return IMAGE_EXTS.has(e) && n.slice(0, n.length - e.length).toLowerCase() === "cover";
  });
  if (onDisk) {
    const p = join(seriesPath, onDisk);
    const s = await stat(p).catch(() => null);
    if (s?.isFile()) return { kind: "file", sig: `file:${onDisk}:${s.size}`, path: p };
  }

  for (const chapter of chapterDirs.slice(0, 1)) {
    let pages: string[] = [];
    try {
      pages = (await readdir(join(seriesPath, chapter)))
        .filter((f) => !f.startsWith(".") && IMAGE_EXTS.has(extname(f).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    } catch {
      continue;
    }
    const first = pages[0];
    if (!first) continue;
    const p = join(seriesPath, chapter, first);
    const s = await stat(p).catch(() => null);
    if (s?.isFile()) return { kind: "file", sig: `page:${chapter}/${first}:${s.size}`, path: p };
  }
  return null;
}

export function coverKey(seriesUid: string, sig: string): string {
  return artKey("cover", seriesUid, sig);
}

/**
 * Normalise one image into a cover.
 *
 * `fit: "cover"` is not used: a cover is the artwork as drawn, and cropping a
 * portrait plate to a fixed ratio is the kind of silent rewriting this store
 * exists to stop doing to the user's files. Only the width is bounded.
 */
async function normalise(input: string | Uint8Array): Promise<Uint8Array | null> {
  try {
    const buf = await sharp(input as never, { limitInputPixels: false, sequentialRead: true })
      .resize({ width: COVER_W, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

export interface CoverWriteResult {
  key: string | null;
  art: StoredArt | null;
  cached: boolean;
}

/** Derive and store a series cover from whatever is already on disk. */
export async function ensureCover(
  seriesUid: string,
  seriesPath: string,
  sidecarCover: string | undefined,
  chapterDirs: string[],
): Promise<CoverWriteResult> {
  const source = await resolveCoverSource(seriesPath, sidecarCover, chapterDirs);
  if (!source) return { key: null, art: null, cached: false };
  const key = coverKey(seriesUid, source.sig);
  if (await has("cover", key)) return { key, art: null, cached: true };
  const body = await normalise(source.kind === "file" ? source.path : source.bytes);
  if (!body) return { key, art: null, cached: false };
  return { key, art: await put("cover", key, body), cached: false };
}

/**
 * Store a cover from bytes the caller already holds.
 *
 * This is the download path's replacement for writing `cover.webp` into the
 * series directory. The signature is the source URL rather than the byte
 * length, because that is the input that decided which picture this is: the
 * same URL re-fetched is the same cover even if the host re-encoded it, and a
 * different URL is a different cover even at an identical size.
 */
export async function adoptCoverBytes(
  seriesUid: string,
  sourceUrl: string,
  bytes: Uint8Array,
): Promise<CoverWriteResult> {
  const key = coverKey(seriesUid, `url:${sourceUrl}`);
  if (await has("cover", key)) return { key, art: null, cached: true };
  const body = await normalise(bytes);
  if (!body) return { key, art: null, cached: false };
  return { key, art: await put("cover", key, body), cached: false };
}
