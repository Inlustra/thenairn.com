// paperbox.json -- the per-series source of truth.
//
// Everything the API needs to identify a series and its chapters lives here, on
// disk, next to the pages. The scan reads it; the directory layout no longer
// decides identity. Chapters additionally carry provenance, so a library built
// from several sources can answer "where did this chapter come from" without
// anyone having to look at the artwork to guess.

import { readFile, writeFile, rename, stat } from "fs/promises";
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
export async function loadMeta(mangaPath: string): Promise<{ meta: SeriesMeta; existed: boolean }> {
  try {
    const raw = await readFile(join(mangaPath, METADATA_FILE), "utf-8");
    const meta = JSON.parse(raw) as SeriesMeta;
    if (!meta.chapters) meta.chapters = {};
    if (!meta.schemaVersion) meta.schemaVersion = SCHEMA_VERSION;
    return { meta, existed: true };
  } catch {}

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
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  await rename(tmp, target);
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
