import type { Provenance, SeriesMeta } from "./metadata";

export interface MangaMeta {
  title?: string;
  author?: string;
  artist?: string;
  description?: string;
  cover?: string;
  link?: string;
  sourceId?: string;
  tags?: string[];
  status?: "ongoing" | "completed" | "hiatus" | "cancelled";
}

export interface Manga {
  /** Stable slug, used on the internal /api routes. */
  id: string;
  /** Identity of record, from paperbox.json. Survives renames. */
  uid: string;
  /** Pinned Int exposed to Suwayomi clients. */
  apiId: number;
  /** Directory name on disk. */
  dir: string;
  title: string;
  coverUrl: string | null;
  chapterCount: number;
  meta: MangaMeta;
}

export interface MangaDetail extends Manga {
  chapters: Chapter[];
  /** Full on-disk metadata, including per-chapter provenance. */
  series: SeriesMeta;
}

export interface Chapter {
  id: string;
  uid: string;
  apiId: number;
  mangaId: string;
  /** Directory name on disk. */
  dir: string;
  title: string;
  number: number;
  /** Verbatim directory name; see metadata.ChapterMeta.label. */
  label: string;
  /** Ordering and block key. 0 means no number could be derived. */
  sortKey: number;
  /** Inclusive range end when one directory covers several chapters. */
  sortKeyEnd?: number;
  /** Which run this belongs to; "main" unless the name says otherwise. */
  sequence: string;
  /** Compact face for a spine's foot band; empty when nothing numeric exists. */
  mark: string;
  pageCount: number;
  /** Chapter-level sync hash; see metadata.ChapterMeta.fingerprint. */
  fingerprint?: string;
  provenance?: Provenance;
}

export interface Page {
  index: number;
  filename: string;
  /** Client-facing, percent-encoded per segment. */
  url: string;
  /** Filesystem-relative, NOT encoded. Never derive this from `url`. */
  path: string;
}
