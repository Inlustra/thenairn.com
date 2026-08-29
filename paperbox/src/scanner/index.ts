import { readdir, stat } from "fs/promises";
import { join, extname } from "path";
import type { Manga, MangaDetail, MangaMeta, Chapter, Page } from "../types";
import { IdAllocator, newUid, pathUid, hash31 } from "../ids";
import { chapterFingerprint } from "../fingerprint";
import { chapterPixelHeight } from "../pixelheight";
import { deriveChapterKey } from "../chapters";
import { loadMeta, saveMeta, dirMtime, SCHEMA_VERSION, type SeriesMeta, type ChapterMeta } from "../metadata";

/**
 * What counts as a page. Exported because `/api/images/*` must serve exactly
 * this set and nothing else -- it used to serve any file under the library
 * root, so `paperbox.json`, `manga.json` and `source-info.json` were all handed
 * out with a day-long public cache header.
 */
export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"]);
// Read at call time, not module load: the value is env-driven, and binding it
// once makes the module impossible to point at a different library (which also
// made the scanner tests order-dependent when run alongside other suites).
const mangaDir = () => process.env.MANGA_DIR || "/manga";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * A slug is a display alias, never identity -- `uid` is identity.
 *
 * slugify collapses every run of non-alphanumerics to a single hyphen, so
 * distinct directories legitimately normalise to the same string: `Re:Zero` and
 * `Re Zero`; `Chapter 1`, `Chapter-1` and `Chapter_1`;
 * `Warhammer 40,000_ Exterminatus` and `Warhammer 40,000: Exterminatus`.
 *
 * Unchecked, the second series silently overwrote the first in the slug-keyed
 * cache -- one series simply disappeared from the library -- and
 * `getChapterByApiId`, which resolves its chapter with
 * `find(c => c.id === chapterId)`, returned whichever colliding chapter came
 * first, so one chapter's pages could be served under another chapter's id.
 *
 * Duplicates get `-2`, `-3`, ... in scan order. That order is deterministic
 * (the directory listing is naturalSort-ed), so the suffix a given directory
 * receives is stable for as long as the directories either side of it are.
 */
function uniqueSlug(base: string, taken: Set<string>): string {
  // A directory of pure punctuation slugifies to "", which is not addressable.
  const root = base || "untitled";
  let slug = root;
  for (let n = 2; taken.has(slug); n++) slug = `${root}-${n}`;
  taken.add(slug);
  return slug;
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Hidden directories are never content. `.paperbox-backups` sitting in the
 * library root was scanned as a 13th series, and backup copies of a chapter
 * dropped beside the real ones were scanned as extra chapters.
 */
function isHidden(name: string): boolean {
  return name.startsWith(".");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `readdir` already carries the directory-or-not answer in `d_type`, at no
 * extra syscall. Asking again with a stat per entry cost one FUSE round trip
 * per name -- 1,718 serial round trips on this library, for information we
 * were handed. DT_UNKNOWN still falls back to a stat, since some filesystems
 * do not populate it.
 */
interface Listing {
  dirs: string[];
  /**
   * Chapter names currently mid-commit: `.replaced-<dir>` or `.staging-<dir>`.
   * Hidden, so they never appear as content, but their presence is proof that a
   * missing directory is in flight rather than deleted.
   */
  inFlight: Set<string>;
}

/**
 * Returns null when the directory could not be read.
 *
 * This used to swallow every error and return an empty array, which made a
 * transient FUSE failure indistinguishable from "the user deleted everything" --
 * and the caller then deleted the metadata to match. On a library that lives on
 * shfs, one EIO would have permanently destroyed a series' identity manifest.
 */
async function listDirs(path: string): Promise<Listing | null> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const dirs: string[] = [];
    const inFlight = new Set<string>();
    for (const e of entries) {
      const flight = e.name.match(/^\.(?:replaced|staging)-(.+)$/);
      if (flight?.[1]) {
        inFlight.add(flight[1]);
        continue;
      }
      if (isHidden(e.name)) continue;
      if (e.isDirectory()) dirs.push(e.name);
      else if (!e.isFile() && !e.isSymbolicLink() && (await isDirectory(join(path, e.name)))) {
        dirs.push(e.name); // d_type was unknown
      }
    }
    return { dirs: dirs.sort(naturalSort), inFlight };
  } catch (e) {
    console.error(`[scan] could not read ${path}; leaving its metadata untouched`, e);
    return null;
  }
}

async function getPageFiles(chapterPath: string): Promise<string[]> {
  try {
    const entries = await readdir(chapterPath);
    return entries
      .filter((f) => !isHidden(f) && IMAGE_EXTS.has(extname(f).toLowerCase()))
      .sort(naturalSort);
  } catch {
    return [];
  }
}

async function findCover(mangaPath: string, chapters: string[]): Promise<string | null> {
  try {
    const names = await readdir(mangaPath);
    const cover = names.find((n) => {
      const e = extname(n).toLowerCase();
      return IMAGE_EXTS.has(e) && n.slice(0, n.length - e.length).toLowerCase() === "cover";
    });
    if (cover) return cover;
  } catch {}
  if (chapters.length > 0) {
    const first = chapters[0]!;
    const pages = await getPageFiles(join(mangaPath, first));
    if (pages.length > 0) return `${first}/${pages[0]}`;
  }
  return null;
}

function toMangaMeta(s: SeriesMeta): MangaMeta {
  return {
    title: s.title, author: s.author, artist: s.artist, description: s.description,
    cover: s.cover, link: s.link, sourceId: s.sourceId, tags: s.tags, status: s.status,
  };
}

// In-memory cache, keyed by slug, plus Int lookup tables for the Suwayomi API.
let mangaCache = new Map<string, MangaDetail>();
let mangaByApiId = new Map<number, string>();
let chapterByApiId = new Map<number, { mangaId: string; chapterId: string }>();
// Keyed by *uid*, not apiId. The derived store keys artwork on a chapter's uid
// and fingerprint (see src/art/store.ts), so serving a spine means resolving a
// uid, and the Int-keyed tables above cannot answer that. Built in the same
// pass rather than derived on demand: at the R-12 target a linear walk of the
// cache per image request is a full-library scan per spine on a shelf.
let mangaByUid = new Map<string, string>();
let chapterByUid = new Map<string, { mangaId: string; chapterId: string }>();
let lastScan = 0;
// Monotonic scan counter. The tree cache keys on this rather than on lastScan:
// two scans inside the same millisecond share a Date.now() value, which would
// serve a stale tree after a download that finishes quickly.
let scanGeneration = 0;

interface Pending {
  dir: string;
  path: string;
  /** Assigned after the carry-over pass, so it can be de-duplicated against it. */
  slug: string;
  /** Effective identity: pinned in the sidecar, else derived from the path. */
  uid: string;
  meta: SeriesMeta;
  existed: boolean;
  chapterDirs: string[];
  inFlight: Set<string>;
  /** The directory could not be read; nothing about this series may be deleted. */
  readFailed: boolean;
  dirty: boolean;
}

export interface ScanProgress {
  active: boolean;
  /** Series directory when this is a targeted scan, else null for the library. */
  scope: string | null;
  phase: "idle" | "listing" | "scanning" | "done";
  seriesTotal: number;
  seriesDone: number;
  currentSeries: string | null;
  chaptersSeen: number;
  startedAt: number | null;
  durationMs: number | null;
}

const idleProgress = (): ScanProgress => ({
  active: false, scope: null, phase: "idle", seriesTotal: 0, seriesDone: 0,
  currentSeries: null, chaptersSeen: 0, startedAt: null, durationMs: null,
});

let progress: ScanProgress = idleProgress();

/** A scan can run for minutes on a large library; it must never look frozen. */
export function getScanProgress(): ScanProgress {
  return { ...progress };
}

/**
 * Scan the library, or one series of it.
 *
 * Scoped scans exist because we are the writer: after a download we know
 * exactly which series changed, so re-walking the whole library is a tax we
 * can simply decline to pay. Everything not in scope is carried over from the
 * existing cache, ids included.
 */
/**
 * Serialises every scan. Two scans interleaving read-modify-write on the same
 * sidecar lose one side's changes wholesale, and `POST /api/scan` is reachable
 * by any client while processQueue is also scanning after each download.
 */
let scanChain: Promise<void> = Promise.resolve();

export function scan(opts: { series?: string } = {}): Promise<void> {
  const next = scanChain.then(
    () => runScan(opts),
    () => runScan(opts),
  );
  // Keep the chain alive past a failure, but let the caller still see it.
  scanChain = next.catch(() => {});
  return next;
}

async function runScan(opts: { series?: string } = {}): Promise<void> {
  const startedAt = Date.now();
  const scopedDir = opts.series && mangaCache.size > 0 ? opts.series : undefined;
  progress = {
    ...idleProgress(),
    active: true, phase: "listing", scope: scopedDir ?? null, startedAt,
  };

  let seriesDirs: string[];
  if (scopedDir) {
    seriesDirs = [scopedDir].filter((d) => !isHidden(d));
  } else {
    const rootListing = await listDirs(mangaDir());
    if (rootListing === null) {
      // The library root itself is unreadable -- an unmounted share, an array
      // stop, an shfs hiccup. Publishing this as a scan would replace the whole
      // cache with nothing and tell every syncing client its entire library is
      // gone. Abort and keep serving the last good state.
      progress = idleProgress();
      throw new Error(`library root ${mangaDir()} is unreadable; scan aborted`);
    }
    seriesDirs = rootListing.dirs;
  }
  progress.seriesTotal = seriesDirs.length;
  progress.phase = "scanning";

  const pending: Pending[] = [];

  for (const dir of seriesDirs) {
    const path = join(mangaDir(), dir);
    const { meta, existed } = await loadMeta(path);
    const listing0 = await listDirs(path);
    pending.push({
      dir, path, slug: "", // filled by the de-duplicating pass below
      uid: meta.uid ?? pathUid(dir),
      meta, existed,
      ...(() => {
        const listing = listing0;
        return {
          // On a read failure, fall back to what the sidecar already knows, so
          // the series keeps its shape instead of appearing to have emptied.
          chapterDirs: listing?.dirs ?? Object.keys(meta.chapters),
          inFlight: listing?.inFlight ?? new Set<string>(),
          readFailed: listing === null,
        };
      })(),
      dirty: !existed,
    });
  }

  // Two passes so a newly-seen series can never steal an id another series has
  // already pinned: claim everything pinned first, allocate the remainder after.
  const mangaIds = new IdAllocator();
  const chapterIds = new IdAllocator();

  for (const p of pending) {
    if (p.meta.apiId !== undefined && !mangaIds.claim(p.meta.apiId, p.uid)) {
      p.meta.apiId = undefined; // collided with an existing owner; reallocate below
      p.dirty = true;
    }
  }
  for (const p of pending) {
    if (p.meta.apiId === undefined) {
      p.meta.apiId = mangaIds.allocate(p.uid);
      // Only worth persisting when a collision forced us off the derived slot;
      // otherwise the id is reproducible from the path and needs no file.
      if (p.meta.apiId !== hash31(p.uid)) p.dirty = true;
    }
  }

  for (const p of pending) {
    for (const dir of p.chapterDirs) {
      const c = p.meta.chapters[dir];
      if (c?.apiId !== undefined && !chapterIds.claim(c.apiId, c.uid ?? pathUid(p.dir, dir))) {
        c.apiId = undefined;
        p.dirty = true;
      }
    }
  }

  const newCache = new Map<string, MangaDetail>();
  const newMangaByApiId = new Map<number, string>();
  const newChapterByApiId = new Map<number, { mangaId: string; chapterId: string }>();
  const newMangaByUid = new Map<string, string>();
  const newChapterByUid = new Map<string, { mangaId: string; chapterId: string }>();

  // Carry over everything outside the scope, and reserve its ids so the series
  // being rescanned cannot be allocated an id another series already holds.
  if (scopedDir) {
    // Matched on `dir`, not on a re-slugified name: once slugs are
    // de-duplicated the scoped series' slug is not necessarily
    // slugify(scopedDir), and comparing the two would carry the series over
    // *and* rescan it, leaving two cache entries for one directory.
    for (const [slug, m] of mangaCache) {
      if (m.dir === scopedDir) continue;
      mangaIds.claim(m.apiId, m.uid);
      newCache.set(slug, m);
      newMangaByApiId.set(m.apiId, slug);
      newMangaByUid.set(m.uid, slug);
      for (const c of m.chapters) {
        chapterIds.claim(c.apiId, c.uid);
        newChapterByApiId.set(c.apiId, { mangaId: slug, chapterId: c.id });
        newChapterByUid.set(c.uid, { mangaId: slug, chapterId: c.id });
      }
    }
  }

  // Now that every carried-over slug is known, allocate a unique slug per
  // series, in scan order.
  const takenSlugs = new Set(newCache.keys());
  for (const p of pending) p.slug = uniqueSlug(slugify(p.dir), takenSlugs);

  for (const p of pending) {
    progress.currentSeries = p.dir;
    const { meta } = p;
    const chapters: Chapter[] = [];
    // Chapter slugs collide inside a series for exactly the same reason.
    const takenChapterSlugs = new Set<string>();

    for (const dir of p.chapterDirs) {
      const pages = await getPageFiles(join(p.path, dir));
      let c: ChapterMeta | undefined = meta.chapters[dir];
      if (!c) {
        const k = deriveChapterKey(p.dir, dir);
        c = {
          dir,
          number: k.sortKey,
          label: k.label,
          sortKey: k.sortKey,
          sortKeyEnd: k.sortKeyEnd,
          sequence: k.sequence,
          mark: k.mark,
          pages: pages.length,
        };
        meta.chapters[dir] = c;
        p.dirty = true;
      } else if (c.sortKey === undefined) {
        // Migration to schema v2. Derived once here and then persisted; from now
        // on this chapter's key is whatever is on disk, not whatever the current
        // parser would say. Improving the parser must not silently re-key it.
        const k = deriveChapterKey(p.dir, dir);
        c.label = k.label;
        c.sortKey = k.sortKey;
        c.sortKeyEnd = k.sortKeyEnd;
        c.sequence = k.sequence;
        c.mark = k.mark;
        c.number = k.sortKey;
        p.dirty = true;
      }
      const cuid = c.uid ?? pathUid(p.dir, dir);
      if (c.apiId === undefined) {
        c.apiId = chapterIds.allocate(cuid);
        if (c.apiId !== hash31(cuid)) p.dirty = true;
      }
      const mtime = await dirMtime(join(p.path, dir));
      // Recompute the sync fingerprint only when something might have moved.
      // Pixel height rides the same trigger: both are facts derived from the
      // pages, invalidated by exactly the same events.
      if (c.pages !== pages.length || c.updatedAt !== mtime || !c.fingerprint || c.pixelHeight === undefined) {
        c.pages = pages.length;
        c.updatedAt = mtime;
        // Deliberately does NOT re-derive the chapter key. Pages moving is not a
        // reason to re-key a chapter, and re-deriving here would reintroduce the
        // silent re-key this schema exists to prevent.
        c.fingerprint = await chapterFingerprint(join(p.path, dir), pages);
        c.pixelHeight = await chapterPixelHeight(join(p.path, dir), pages);
        p.dirty = true;
      }

      const chapter: Chapter = {
        id: `${p.slug}--${uniqueSlug(slugify(dir), takenChapterSlugs)}`,
        uid: cuid,
        apiId: c.apiId,
        mangaId: p.slug,
        dir,
        title: dir,
        number: c.number,
        label: c.label ?? dir,
        sortKey: c.sortKey ?? c.number,
        sortKeyEnd: c.sortKeyEnd,
        sequence: c.sequence ?? "main",
        mark: c.mark ?? "",
        pageCount: pages.length,
        pixelHeight: c.pixelHeight,
        fingerprint: c.fingerprint,
        provenance: c.provenance,
      };
      chapters.push(chapter);
      progress.chaptersSeen++;
      newChapterByApiId.set(c.apiId, { mangaId: p.slug, chapterId: chapter.id });
      newChapterByUid.set(cuid, { mangaId: p.slug, chapterId: chapter.id });
    }

    // Advance the stored schema version once every chapter carries a key.
    // loadMeta only fills an *absent* version, so without this an existing
    // sidecar stays on its old number forever and nothing downstream can tell a
    // migrated file from an unmigrated one.
    if (meta.schemaVersion !== SCHEMA_VERSION) {
      const allKeyed = Object.values(meta.chapters).every((c) => c.sortKey !== undefined);
      if (allKeyed) {
        meta.schemaVersion = SCHEMA_VERSION;
        p.dirty = true;
      }
    }

    // Drop metadata for chapters whose directories are gone, so the file does
    // not accumulate ghosts -- but keep ids stable for everything still present.
    //
    // Corroboration matters here. commitChapter deliberately makes the live
    // directory vanish for the span of two renames (it becomes `.replaced-<dir>`,
    // which is dot-prefixed and so invisible to listDirs). A scan landing inside
    // that window used to delete the entry outright, destroying the chapter's
    // uid, apiId, sortKey and provenance -- the exact silent re-key this schema
    // exists to prevent, on the path processQueue drives after every download.
    // The same applies to any transient readdir failure, which listDirs reports
    // as an empty directory.
    if (!p.readFailed) {
      for (const key of Object.keys(meta.chapters)) {
        if (!p.chapterDirs.includes(key) && !p.inFlight.has(key)) {
          delete meta.chapters[key];
          p.dirty = true;
        }
      }
    }

    let coverUrl: string | null = null;
    let localCover: string | null = null;
    if (meta.cover && !meta.cover.startsWith("http")) {
      try {
        await stat(join(p.path, meta.cover));
        localCover = meta.cover;
      } catch {}
    }
    if (localCover) {
      coverUrl = `/api/images/${p.dir}/${localCover}`;
    } else if (meta.cover?.startsWith("http")) {
      coverUrl = meta.cover;
    } else {
      const fallback = await findCover(p.path, p.chapterDirs);
      if (fallback) coverUrl = `/api/images/${p.dir}/${fallback}`;
    }

    newCache.set(p.slug, {
      id: p.slug,
      uid: p.uid,
      apiId: meta.apiId!,
      dir: p.dir,
      title: meta.title || p.dir,
      coverUrl,
      chapterCount: chapters.length,
      meta: toMangaMeta(meta),
      chapters,
      series: meta,
    });
    newMangaByApiId.set(meta.apiId!, p.slug);
    newMangaByUid.set(p.uid, p.slug);
    progress.seriesDone++;

    if (p.dirty) {
      try {
        await saveMeta(p.path, meta);
      } catch (e) {
        console.error(`  failed to write metadata for ${p.dir}`, e);
      }
    }
  }

  mangaCache = newCache;
  mangaByApiId = newMangaByApiId;
  chapterByApiId = newChapterByApiId;
  mangaByUid = newMangaByUid;
  chapterByUid = newChapterByUid;
  lastScan = Date.now();
  scanGeneration++;
  progress = {
    ...progress,
    active: false, phase: "done", currentSeries: null,
    seriesDone: progress.seriesTotal,
    durationMs: Date.now() - startedAt,
  };
  const what = scopedDir ? `"${scopedDir}"` : `${mangaCache.size} manga series`;
  console.log(`Scanned ${what}, ${newChapterByApiId.size} chapters in ${Date.now() - startedAt}ms`);
}

export function getMangaList(): Manga[] {
  return Array.from(mangaCache.values()).map(({ chapters, series, ...manga }) => manga);
}

export function getManga(id: string): MangaDetail | undefined {
  return mangaCache.get(id);
}

/** Resolve the Int a Suwayomi client holds. */
export function getMangaByApiId(apiId: number): MangaDetail | undefined {
  const slug = mangaByApiId.get(apiId);
  return slug ? mangaCache.get(slug) : undefined;
}

export function getChapterByApiId(apiId: number): { manga: MangaDetail; chapter: Chapter } | undefined {
  const ref = chapterByApiId.get(apiId);
  if (!ref) return undefined;
  const manga = mangaCache.get(ref.mangaId);
  const chapter = manga?.chapters.find((c) => c.id === ref.chapterId);
  return manga && chapter ? { manga, chapter } : undefined;
}

/**
 * Resolve the identity of record, not the display alias.
 *
 * `uid` survives a rename (it is pinned in `paperbox.json`) whereas the slug is
 * a display alias that moves when a colliding directory is added or removed.
 * Anything that stores a key derived from a series or chapter -- the derived
 * art store, a job's `scope` -- must key on the uid for that reason.
 */
export function getMangaByUid(uid: string): MangaDetail | undefined {
  const slug = mangaByUid.get(uid);
  return slug ? mangaCache.get(slug) : undefined;
}

export function getChapterByUid(uid: string): { manga: MangaDetail; chapter: Chapter } | undefined {
  const ref = chapterByUid.get(uid);
  if (!ref) return undefined;
  const manga = mangaCache.get(ref.mangaId);
  const chapter = manga?.chapters.find((c) => c.id === ref.chapterId);
  return manga && chapter ? { manga, chapter } : undefined;
}

/** Absolute paths of a chapter's pages, in reading order. */
export async function getChapterPagePaths(manga: MangaDetail, chapter: Chapter): Promise<string[]> {
  const dir = join(mangaDir(), manga.dir, chapter.dir);
  return (await getPageFiles(dir)).map((f) => join(dir, f));
}

export async function getPages(mangaId: string, chapterId: string): Promise<Page[]> {
  const manga = mangaCache.get(mangaId);
  if (!manga) return [];
  const chapter = manga.chapters.find((c) => c.id === chapterId);
  if (!chapter) return [];

  const files = await getPageFiles(join(mangaDir(), manga.dir, chapter.dir));
  return files.map((filename, index) => ({
    index,
    filename,
    // Encoded for the client; `path` stays raw for filesystem use. Deriving one
    // from the other by string-replacing the prefix silently breaks on any
    // series or chapter whose name contains a space.
    url: `/api/images/${encodeURIComponent(manga.dir)}/${encodeURIComponent(chapter.dir)}/${encodeURIComponent(filename)}`,
    path: `${manga.dir}/${chapter.dir}/${filename}`,
  }));
}

export function getLastScan(): number {
  return lastScan;
}

export function getScanGeneration(): number {
  return scanGeneration;
}

export function getMangaDir(): string {
  return mangaDir();
}
