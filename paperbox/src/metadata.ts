// paperbox.json -- the per-series source of truth.
//
// Everything the API needs to identify a series and its chapters lives here, on
// disk, next to the pages. The scan reads it; the directory layout no longer
// decides identity. Chapters additionally carry provenance, so a library built
// from several sources can answer "where did this chapter come from" without
// anyone having to look at the artwork to guess.

import { readFile, rename, stat, open, unlink } from "fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "path";
import { newUid } from "./ids";

export const METADATA_FILE = "paperbox.json";
export const SCHEMA_VERSION = 2;
// v2 (2026-08-28): chapters gained label/sortKey/sequence. See docs/decisions.md.

/** Where one chapter's pages came from. */
export interface Provenance {
  /** Source module id, e.g. "mod-asurascans", "weebcentral", "manual". */
  module: string;
  seriesUrl?: string;
  chapterUrl?: string;
  /** Scanlation group, when the source reports one. */
  group?: string;
  fetchedAt: string;
}

export interface ChapterMeta {
  /** Pinned identity. Absent means "derive it from the path" -- the default. */
  uid?: string;
  /** Pinned Int exposed to Suwayomi clients. */
  apiId?: number;
  /** Directory name on disk. The only link back to the filesystem. */
  dir: string;
  /**
   * Legacy numeric chapter number, kept because the Suwayomi/Paperback compat
   * API contract exposes a number. Derived from `sortKey`; not the truth.
   */
  number: number;
  /**
   * The chapter's identity as a *label*, a sort key and a sequence.
   *
   * Stored, never re-derived on read: re-deriving would mean that improving the
   * parser silently re-keys every block hash and invalidates client state with
   * no migration and no signal. See docs/decisions.md.
   */
  label?: string;
  sortKey?: number;
  /** Inclusive range end when one directory covers several chapters (`14-19`). */
  sortKeyEnd?: number;
  /** Which run this belongs to. "main" unless the name says otherwise. */
  sequence?: string;
  /** Compact face for a spine's foot band. Empty when nothing numeric exists. */
  mark?: string;
  pages: number;
  /**
   * Chapter directory mtime at last scan. Cheap replacement detector: page
   * filenames stay 001.jpg.. across a re-pull, so names alone prove nothing.
   * A byte-level hash is deliberately not computed -- it would mean stat-ing
   * every page on every scan.
   */
  updatedAt?: string;
  /**
   * Chapter-level sync hash, over each page's name and byte size.
   *
   * Persisted because deriving it costs a stat per page, and a library of any
   * size cannot afford that on every tree build -- 12 series here is 57,691
   * stats and 17 seconds. It is reused whenever the chapter's page count and
   * directory mtime are both unchanged.
   *
   * mtime is used only to decide whether to recompute, never as the hash
   * itself. A copy or restore bumps mtime and costs one recomputation, which
   * then produces the same value -- so it can never report a false change.
   */
  fingerprint?: string;
  provenance?: Provenance;
  /** Superseded provenance, newest last. Set when a chapter is re-sourced. */
  history?: Provenance[];
}

export interface SeriesMeta {
  schemaVersion: number;
  /** Pinned identity. Absent means "derive it from the path" -- the default. */
  uid?: string;
  apiId?: number;
  title?: string;
  author?: string;
  artist?: string;
  description?: string;
  cover?: string;
  link?: string;
  sourceId?: string;
  tags?: string[];
  status?: "ongoing" | "completed" | "hiatus" | "cancelled";
  /** Every source this series has ever been pulled from. */
  sources?: string[];
  /** Keyed by directory name. */
  chapters: Record<string, ChapterMeta>;
}

function emptyMeta(): SeriesMeta {
  // Deliberately no uid: a series with no sidecar still has a stable identity,
  // derived from its path. A uid is written only when something needs pinning.
  return { schemaVersion: SCHEMA_VERSION, chapters: {}, sources: [] };
}

/** Read paperbox.json, else adopt the legacy manga.json, else start fresh. */
export class CorruptMetaError extends Error {
  constructor(path: string, cause: unknown) {
    super(`${path} is unreadable and was set aside: ${String(cause)}`);
    this.name = "CorruptMetaError";
  }
}

export async function loadMeta(mangaPath: string): Promise<{ meta: SeriesMeta; existed: boolean }> {
  const target = join(mangaPath, METADATA_FILE);
  let raw: string | undefined;
  try {
    raw = await readFile(target, "utf-8");
  } catch (e: any) {
    // Only "the file is not there" may fall through to a fresh manifest.
    if (e?.code !== "ENOENT") throw e;
  }

  if (raw !== undefined) {
    try {
      const meta = JSON.parse(raw) as SeriesMeta;
      if (!meta.chapters) meta.chapters = {};
      if (!meta.schemaVersion) meta.schemaVersion = SCHEMA_VERSION;
      return { meta, existed: true };
    } catch (e) {
      // A damaged sidecar used to be indistinguishable from an absent one, so
      // the scan treated the series as new, re-derived every uid and apiId, and
      // saved over the only copy. Set it aside and refuse to continue instead:
      // a series skipped this scan is recoverable, an overwritten manifest is
      // not.
      const aside = `${target}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await rename(target, aside).catch(() => {});
      throw new CorruptMetaError(target, e);
    }
  }

  const meta = emptyMeta();
  try {
    const legacy = JSON.parse(await readFile(join(mangaPath, "manga.json"), "utf-8"));
    Object.assign(meta, {
      title: legacy.title,
      author: legacy.author,
      artist: legacy.artist,
      description: legacy.description,
      cover: legacy.cover,
      link: legacy.link,
      sourceId: legacy.sourceId,
      tags: legacy.tags,
      status: legacy.status,
      sources: legacy.sourceId ? [legacy.sourceId] : [],
    });
  } catch {}
  return { meta, existed: false };
}

/** Write atomically -- a torn metadata file would orphan every id in it. */
export async function saveMeta(mangaPath: string, meta: SeriesMeta): Promise<void> {
  const target = join(mangaPath, METADATA_FILE);
  // Unique per writer: a fixed `${target}.tmp` meant two concurrent saves raced
  // on one path, and the loser's rename failed with ENOENT after the winner had
  // already moved it -- reported as success by callers that swallow the error.
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const body = JSON.stringify(meta, null, 2) + "\n";
  try {
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(body, "utf-8");
      // rename() alone is atomic with respect to *readers*, not to a crash. With
      // delayed allocation, write+rename without fsync is the classic route to a
      // zero-length file after power loss -- and this file is the only copy of
      // every pinned id in the series.
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, target);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Serialise load -> mutate -> save for one series.
 *
 * The scanner and the download path both read-modify-write the whole sidecar.
 * Unserialised, the loser's changes are lost wholesale: three concurrent
 * provenance writes left one chapter recorded out of three.
 */
const seriesLocks = new Map<string, Promise<unknown>>();

export function withSeriesLock<T>(mangaPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = seriesLocks.get(mangaPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  seriesLocks.set(
    mangaPath,
    next.catch(() => {}).finally(() => {
      if (seriesLocks.get(mangaPath) === next) seriesLocks.delete(mangaPath);
    }),
  );
  return next;
}

export async function dirMtime(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Record where a chapter came from, retiring any previous record into history.
 * Re-recording the same module and url is a no-op, so repeated scans of an
 * unchanged chapter don't grow the file.
 */
export function recordProvenance(chapter: ChapterMeta, next: Provenance): void {
  const prev = chapter.provenance;
  if (prev && prev.module === next.module && prev.chapterUrl === next.chapterUrl) return;
  if (prev) (chapter.history ||= []).push(prev);
  chapter.provenance = next;
}
