/**
 * Read-only enumeration of the library, for rule evaluation.
 *
 * A rule needs the chapter list of one series. The scanner already builds that,
 * but only for a library it has scanned into memory, and the bench needs to
 * evaluate rules against the real library without starting a server or paying
 * for a scan. This reads `paperbox.json` and nothing else: one file per series,
 * no descent into chapter directories, no stat per chapter.
 *
 * **It never writes.** That is not a style preference:
 *
 *   - `/mnt/user/Media/Manga-new` is real user data. Nothing in a measurement
 *     path has any business modifying it.
 *   - `loadMeta()` in metadata.ts is deliberately NOT used here even though it
 *     parses the same file, because it has a side effect: an unparseable
 *     sidecar is *renamed* to `.corrupt-<timestamp>`. That is right for the
 *     scanner, which must not overwrite an identity manifest it cannot read,
 *     and wrong for a reader that was only asked to count chapters. Reusing it
 *     would mean a benchmark run could rename a file in the user's library.
 *
 * A series with no readable sidecar is skipped and reported, never repaired.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathUid } from "../ids";
import { METADATA_FILE, type SeriesMeta } from "../metadata";
import type { ChapterRef } from "./resolver";

export interface SeriesChapters {
  /** Directory name on disk. */
  dir: string;
  /** Identity of record: the pinned uid, else derived from the path. */
  uid: string;
  title: string;
  chapters: ChapterRef[];
}

export interface ImportReport {
  series: SeriesChapters[];
  /** Directories with no readable `paperbox.json`, and why. */
  skipped: Array<{ dir: string; reason: string }>;
}

function refsFrom(seriesDir: string, meta: SeriesMeta): ChapterRef[] {
  const out: ChapterRef[] = [];
  for (const [dir, c] of Object.entries(meta.chapters ?? {})) {
    if (!c) continue;
    out.push({
      // Same derivation as the scanner: a pinned uid wins, else the path.
      // Duplicating the expression rather than importing the scanner keeps this
      // module free of the scanner's module-load-time library binding.
      uid: c.uid ?? pathUid(seriesDir, dir),
      dir,
      label: c.label ?? dir,
      // A pre-v2 sidecar has no sortKey. Fall back to the legacy `number`
      // rather than re-deriving the key here -- re-deriving is exactly the
      // silent re-keying docs/decisions.md forbids, and a benchmark is the last
      // place that should be inventing chapter identity.
      sortKey: c.sortKey ?? c.number ?? 0,
      sortKeyEnd: c.sortKeyEnd,
      sequence: c.sequence ?? "main",
      pages: c.pages ?? 0,
    });
  }
  return out;
}

/** One series, or null when there is no readable sidecar. */
export async function importSeries(root: string, dir: string): Promise<SeriesChapters | null> {
  let raw: string;
  try {
    raw = await readFile(join(root, dir, METADATA_FILE), "utf-8");
  } catch {
    return null;
  }
  let meta: SeriesMeta;
  try {
    meta = JSON.parse(raw) as SeriesMeta;
  } catch {
    // Left exactly as found. See the header: repairing is the scanner's job.
    return null;
  }
  return {
    dir,
    uid: meta.uid ?? pathUid(dir),
    title: meta.title || dir,
    chapters: refsFrom(dir, meta),
  };
}

/** Every series under `root` that carries a readable sidecar. */
export async function importLibrary(root: string): Promise<ImportReport> {
  const series: SeriesChapters[] = [];
  const skipped: Array<{ dir: string; reason: string }> = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const s = await importSeries(root, e.name);
    if (s) series.push(s);
    else skipped.push({ dir: e.name, reason: `no readable ${METADATA_FILE}` });
  }
  series.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return { series, skipped };
}
