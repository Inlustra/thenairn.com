/**
 * The client-facing contract — every interface the web client consumes,
 * whether or not the server implements it yet.
 *
 * This is the single seam between UI and server. Views import from here and
 * from `./index` only; they never call `fetch` themselves and never carry
 * hardcoded data. Two implementations satisfy this contract:
 *
 *   - `real.ts`    — the endpoints that exist today
 *                    (/api/manga, /api/status, /api/scan, /api/sync/*,
 *                     /api/downloads, /api/scripts, /api/images/*)
 *   - `pending.ts` — everything the design needs that the server does not
 *                    yet provide. The ONLY place unimplemented behaviour
 *                    lives. Each entry documents the server work it stands
 *                    in for. See docs/api-gaps.md.
 *
 * When the server catches up, deleting the adapter entry and pointing the
 * composed client (index.ts) at the real route is the whole change.
 */

/* ------------------------------------------------------------------ */
/* Library — real, mirrors src/types.ts                                */
/* ------------------------------------------------------------------ */

export interface SeriesMetaInfo {
  title?: string;
  author?: string;
  artist?: string;
  description?: string;
  cover?: string;
  link?: string;
  sourceId?: string;
  tags?: string[];
  /** Free string on disk in practice ("Ongoing", "Completed", "Hiatus"). */
  status?: string;
}

export interface SeriesSummary {
  id: string;
  uid: string;
  apiId: number;
  dir: string;
  title: string;
  coverUrl: string | null;
  chapterCount: number;
  meta: SeriesMetaInfo;
}

export interface ChapterInfo {
  id: string;
  uid: string;
  apiId: number;
  mangaId: string;
  dir: string;
  title: string;
  number: number;
  /** Verbatim directory name. Never lossy; never truncated by the client. */
  label: string;
  /** Stored ordering key. 0 with an empty mark means "no number exists". */
  sortKey: number;
  /** Inclusive range end when one directory covers several chapters. */
  sortKeyEnd?: number;
  /** Which run this belongs to; "main" unless the name says otherwise. */
  sequence: string;
  /** Compact face for a spine's foot band; empty when nothing numeric exists. */
  mark: string;
  pageCount: number;
  fingerprint?: string;
  provenance?: {
    sourceId?: string;
    sourceName?: string;
    url?: string;
    fetchedAt?: number;
  };
}

export interface SeriesDetail extends SeriesSummary {
  chapters: ChapterInfo[];
}

export interface PageInfo {
  index: number;
  filename: string;
  /** Client-facing, percent-encoded per segment. */
  url: string;
}

export interface LibraryPage {
  data: SeriesSummary[];
  total: number;
  page: number;
  limit: number;
}

export interface LibraryApi {
  list(opts?: { search?: string; page?: number; limit?: number }): Promise<LibraryPage>;
  get(id: string): Promise<SeriesDetail>;
  pages(id: string, chapterId: string): Promise<PageInfo[]>;
  /** Re-pull series metadata (cover, description, chapter list) from a source. */
  refresh(id: string, sourceId: string, url: string): Promise<{ ok: boolean; fetched: Record<string, unknown>; coverSaved: boolean }>;
  /** Bind or change the source a series follows. */
  setSource(id: string, opts: { sourceId?: string; url?: string }): Promise<{ ok: boolean }>;
}

/* ------------------------------------------------------------------ */
/* Status — real, /api/status                                          */
/* ------------------------------------------------------------------ */

export interface ServerStatus {
  server: { name: string; startedAt: number; uptimeMs: number };
  library: { sig: string; dir: string; series: number; chapters: number; lastScan: number };
  scan: ScanProgress;
  downloads: {
    sig: string;
    tasks: number;
    active: number;
    queued: number;
    failed: number;
    completed: number;
    chaptersFailed: number;
    pagesDone: number;
    pagesTotal: number;
  };
  sources: { sig: string; count: number };
}

export interface StatusApi {
  /** One envelope; poll this and fetch detail only for what moved. */
  get(): Promise<ServerStatus>;
}

/* ------------------------------------------------------------------ */
/* Scan — real, POST /api/scan + GET /api/sync/scan                    */
/* ------------------------------------------------------------------ */

export interface ScanProgress {
  active: boolean;
  scope: string | null;
  phase: "idle" | "listing" | "scanning" | "done";
  seriesTotal: number;
  seriesDone: number;
  currentSeries: string | null;
  chaptersSeen: number;
  startedAt: number | null;
  durationMs: number | null;
}

export interface ScanApi {
  /** A user-invoked scan is a foreground errand — it earns numbers. */
  start(): Promise<{ ok: boolean; count: number; lastScan: number }>;
  progress(): Promise<ScanProgress>;
}

/* ------------------------------------------------------------------ */
/* Downloads — real, /api/downloads (the far lane)                     */
/* ------------------------------------------------------------------ */

export type TaskStatus = "queued" | "downloading" | "completed" | "failed" | "cancelled";

export interface ChapterDownload {
  name: string;
  url: string;
  status: TaskStatus;
  pagesTotal: number;
  pagesDownloaded: number;
  error?: string;
}

export interface DownloadTask {
  id: string;
  mangaTitle: string;
  sourceId: string;
  sourceName: string;
  mangaUrl: string;
  chapters: ChapterDownload[];
  status: TaskStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DownloadConfig {
  parallelPages: number;
  parallelChapters: number;
  retries: number;
  retryDelayMs: number;
}

export interface DownloadsApi {
  list(): Promise<DownloadTask[]>;
  create(opts: {
    mangaTitle: string;
    sourceId: string;
    mangaUrl?: string;
    chapters: { name: string; url: string }[];
  }): Promise<DownloadTask>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  config(): Promise<DownloadConfig>;
  setConfig(partial: Partial<DownloadConfig>): Promise<DownloadConfig>;
}

/* ------------------------------------------------------------------ */
/* Sources — real, /api/scripts                                        */
/* ------------------------------------------------------------------ */

export interface SourceInfo {
  id: string;
  name: string;
  category: "module" | "template";
  rootUrl: string;
}

export interface SourceSeriesInfo {
  title?: string;
  authors?: string;
  artists?: string;
  summary?: string;
  status?: string;
  coverLink?: string;
  genres?: string;
  chapterNames?: string[];
  chapterLinks?: string[];
}

export interface SourcesApi {
  list(): Promise<SourceInfo[]>;
  detect(url: string): Promise<SourceInfo | null>;
  info(sourceId: string, url: string): Promise<{ manga: SourceSeriesInfo; source: string }>;
  pull(): Promise<{ ok: boolean; count: number }>;
}

/* ------------------------------------------------------------------ */
/* Sync tree — real, /api/sync/tree + /api/sync/diff (diagnosis)       */
/* ------------------------------------------------------------------ */

export interface TreeChild {
  id: string;
  kind: "root" | "series" | "block" | "chapter" | "page";
  hash: string;
  n: number;
  label: string;
}

export interface SyncApi {
  tree(): Promise<{ root: string; treeVersion: number; blockSize: number; children: TreeChild[] }>;
  diff(body: {
    have?: { id: string; hash: string }[];
    depth?: number;
    resolve?: "nodes" | "pages";
    scope?: string;
  }): Promise<{
    root: string;
    treeVersion: number;
    changed: (TreeChild & { state: "added" | "modified" })[];
    images: { id: string; chapterId: string; file: string; size: number; url: string; hash: string }[];
    gone: string[];
    truncated: boolean;
  }>;
}

/* ================================================================== */
/* Everything below here does NOT exist server-side yet.               */
/* Implemented only by pending.ts. See docs/api-gaps.md.               */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* Read state — MISSING (server work underway in src/readstate/)       */
/* ------------------------------------------------------------------ */

export interface ChapterReadState {
  chapterId: string;
  /** Last page index reached, 0-based. */
  page: number;
  pageCount: number;
  /** A chapter is read when the position reached its last page. */
  read: boolean;
  updatedAt: number;
}

export interface SeriesReadState {
  seriesId: string;
  /** Keyed by chapter id. Absent = never opened. */
  chapters: Record<string, ChapterReadState>;
}

export interface ContinuePoint {
  seriesId: string;
  seriesTitle: string;
  chapterId: string;
  chapterLabel: string;
  page: number;
  pageCount: number;
  updatedAt: number;
}

export interface ReadStateApi {
  series(seriesId: string): Promise<SeriesReadState>;
  /** Positions merge furthest-wins server-side once the route exists. */
  setPosition(seriesId: string, chapterId: string, page: number, pageCount: number): Promise<void>;
  markRead(seriesId: string, chapterId: string, read: boolean): Promise<void>;
  /** The Continue rail — most recent positions across the library. */
  continueRail(limit?: number): Promise<ContinuePoint[]>;
  /** Unread count per series — the one number that drives choosing. */
  unreadCounts(): Promise<Record<string, number>>;
}

/* ------------------------------------------------------------------ */
/* Identity — MISSING (registry binding, docs/upstream.md)             */
/* ------------------------------------------------------------------ */

export type IdentityState =
  /** Corroborated or confirmed; derived facts may stand on it. */
  | "identified"
  /** A guess awaiting a person. External facts render greyed, unconfirmed. */
  | "guess"
  /** Evidence contradicts the match. Red row in the queue; facts retracted. */
  | "contradicted"
  /** No registry we asked knows it — but one we haven't configured might. */
  | "unconfigured"
  /** The user said "keep files-only". A full citizen, never an apology. */
  | "files-only"
  /** Never looked at (or nothing found by the phrasing tried). */
  | "unmatched";

export interface EvidenceRow {
  fact: string;
  verdict: "agree" | "contradict" | "unknown";
}

export interface RegistryFacts {
  provider: string;
  registryId: string;
  canonicalTitle: string;
  /** ongoing / hiatus / complete / unknown — shared vocabulary. */
  status: "ongoing" | "hiatus" | "complete" | "unknown";
  /** The denominator in "you hold 313 of 327". */
  latestChapter: number | null;
  /** Median release interval in days, from dated release records. */
  cadenceDays: number | null;
  cadenceLabel: string | null;
  /** ISO date the registry card was last refreshed — the freshness stamp. */
  asOf: string;
  /** Season boundaries, if the registry states them. */
  seasons: { name: string; endAfterSortKey: number }[];
  nativeTitle?: string;
  year?: number;
}

export interface IdentityBinding {
  seriesId: string;
  state: IdentityState;
  registry: RegistryFacts | null;
  /** Second corroborating provider, when one agrees. */
  alsoConfirmedBy?: string;
  candidate?: { provider: string; title: string; nameScore: number; evidence: EvidenceRow[] };
  /** For "unconfigured": which provider would likely know this series. */
  suggestedProvider?: string;
}

export interface IdentityApi {
  get(seriesId: string): Promise<IdentityBinding>;
  all(): Promise<Record<string, IdentityBinding>>;
  confirm(seriesId: string, provider: string, registryId: string): Promise<void>;
  reject(seriesId: string): Promise<void>;
  keepFilesOnly(seriesId: string): Promise<void>;
  search(seriesId: string, phrase: string): Promise<IdentityBinding["candidate"][]>;
}

/* ------------------------------------------------------------------ */
/* Source health — MISSING (per-source state, docs/upstream.md)        */
/* ------------------------------------------------------------------ */

export type SourceHealthState =
  /** Fetching normally. Renders as silence — no chrome. */
  | "healthy"
  /** Rate limited or briefly down. Amber — heals itself, asks nothing. */
  | "cooling"
  /** Not answering / serving block pages. Amber, patient; diagnosable. */
  | "down"
  /** Alive but not posting new chapters while the series publishes. */
  | "stalled";

export interface SourceHealth {
  sourceId: string;
  sourceName: string;
  state: SourceHealthState;
  /** One flat line — "Cooling down · resumes itself" — never a paragraph. */
  detail: string;
  lastFetchAt: number | null;
  seriesBound: number;
  waitingChapters: number;
}

export interface SourceHealthApi {
  all(): Promise<SourceHealth[]>;
  forSource(sourceId: string): Promise<SourceHealth | null>;
}

/* ------------------------------------------------------------------ */
/* Look elsewhere — MISSING (the survey, docs/upstream.md)             */
/* ------------------------------------------------------------------ */

export interface SurveyRow {
  sourceId: string;
  sourceName: string;
  /** What the source claims to hold, verified as chapters land. */
  holds: string;
  coversWanted: number;
  isCurrent: boolean;
  note?: string;
}

export interface SurveyApi {
  /** Ask every configured source what it actually has for a series. */
  run(seriesId: string): Promise<SurveyRow[]>;
  /** Bind a new source for future chapters. Held chapters keep provenance. */
  adopt(seriesId: string, sourceId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Rules — MISSING (selective sync, docs/rules.md — designed not built)*/
/* ------------------------------------------------------------------ */

export interface SyncRule {
  id: string;
  /** What set: one chapter, a range, next-N-unread, a series, a collection. */
  scope: { kind: "chapter" | "range" | "window" | "series" | "collection"; ref: string; n?: number };
  trigger: "once" | "standing" | "overnight";
  /** Retention is an authored clause; adds-only is the default. */
  retention: { kind: "keep" | "release-after-read"; afterN?: number };
  priority: number;
  /** What the rule resolves to right now — chapters and bytes. */
  resolved: { chapters: number; bytes: number };
  deviceId: string;
  deviceName: string;
}

export interface RulesApi {
  list(): Promise<SyncRule[]>;
}

/* ------------------------------------------------------------------ */
/* Freshness — MISSING (scan scheduler, docs/scheduler.md)             */
/* ------------------------------------------------------------------ */

export interface SeriesFreshness {
  seriesId: string;
  /** When the scanner last looked at this series. */
  lastLookedAt: number | null;
  /** Past its lane's deadline → the pencil-weight freshness stamp. */
  stale: boolean;
}

export interface FreshnessApi {
  all(): Promise<Record<string, SeriesFreshness>>;
}

/* ------------------------------------------------------------------ */
/* Flags — MISSING (human flagging outranks checksums, docs/ui.md)     */
/* ------------------------------------------------------------------ */

export interface ContentFlag {
  seriesId: string;
  chapterId: string;
  flaggedAt: number;
  note?: string;
}

export interface FlagsApi {
  list(): Promise<ContentFlag[]>;
  flag(seriesId: string, chapterId: string, note?: string): Promise<void>;
  unflag(seriesId: string, chapterId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Manage — MISSING (delete/exclude; no delete endpoints exist)        */
/* ------------------------------------------------------------------ */

export interface ManageApi {
  /**
   * Remove a series Paperbox itself fetched. Never touches user-managed
   * files — "the files belong to the user" is the standing promise, so the
   * server-side design must distinguish adopted from fetched before this
   * can exist at all.
   */
  deleteSeries(seriesId: string): Promise<void>;
  /** Exclude a directory from the library without touching it. */
  excludeSeries(seriesId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* The composed client                                                 */
/* ------------------------------------------------------------------ */

export interface PaperboxApi {
  library: LibraryApi;
  status: StatusApi;
  scan: ScanApi;
  downloads: DownloadsApi;
  sources: SourcesApi;
  sync: SyncApi;
  // Pending — served by the adapter until the server catches up:
  readState: ReadStateApi;
  identity: IdentityApi;
  sourceHealth: SourceHealthApi;
  survey: SurveyApi;
  rules: RulesApi;
  freshness: FreshnessApi;
  flags: FlagsApi;
}
