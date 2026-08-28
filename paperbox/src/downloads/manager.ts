import { mkdir, writeFile, rm, rename, readdir } from "fs/promises";
import { join, basename } from "path";
import { runModule, type MangaInfo } from "../lua/engine";
import { getScript, getScriptByName } from "../lua/scripts";
import { getMangaDir, scan } from "../scanner";
import { loadMeta, saveMeta, recordProvenance, type ChapterMeta } from "../metadata";
import { safeSegment, assertDirectChild } from "../safepath";
import { deriveChapterKey } from "../chapters";

export type DownloadStatus = "queued" | "downloading" | "completed" | "failed" | "cancelled";

export interface DownloadTask {
  id: string;
  mangaTitle: string;
  sourceId: string;
  sourceName: string;
  mangaUrl: string;
  chapters: ChapterDownload[];
  status: DownloadStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChapterDownload {
  name: string;
  url: string;
  status: DownloadStatus;
  pagesTotal: number;
  pagesDownloaded: number;
  error?: string;
}

export interface DownloadConfig {
  parallelPages: number;
  parallelChapters: number;
  retries: number;
  retryDelayMs: number;
}

const defaultConfig: DownloadConfig = {
  parallelPages: 3,
  parallelChapters: 1,
  retries: 3,
  retryDelayMs: 1000,
};

let config: DownloadConfig = { ...defaultConfig };

function touch(task: DownloadTask): void {
  task.updatedAt = Date.now();
}

/**
 * Summary for the status envelope, without shipping the whole task list.
 *
 * `sig` is derived from the task state itself, never from a counter. Counts
 * alone are not enough -- a download moving from 40% to 60% changes no count --
 * but page progress is data the UI wants anyway, so including it earns its
 * place twice: it is what a client displays, and it is what tells the client
 * the payload moved.
 */
export function summariseDownloads() {
  const tasks = listTasks();
  const chapters = tasks.flatMap((t) => t.chapters);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const t of tasks) {
    hasher.update(`${t.id}:${t.status}:${t.chapters.length} `);
    for (const c of t.chapters) hasher.update(`${c.status}:${c.pagesDownloaded ?? 0} `);
  }
  return {
    sig: hasher.digest("hex").slice(0, 16),
    tasks: tasks.length,
    active: tasks.filter((t) => t.status === "downloading").length,
    queued: tasks.filter((t) => t.status === "queued").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    completed: tasks.filter((t) => t.status === "completed").length,
    chaptersFailed: chapters.filter((c) => c.status === "failed").length,
    pagesDone: chapters.reduce((n, c) => n + (c.pagesDownloaded || 0), 0),
    pagesTotal: chapters.reduce((n, c) => n + (c.pagesTotal || 0), 0),
  };
}

export function getConfig(): DownloadConfig {
  return { ...config };
}

export function setConfig(partial: Partial<DownloadConfig>): DownloadConfig {
  if (partial.parallelPages !== undefined) {
    config.parallelPages = Math.max(1, Math.min(10, partial.parallelPages));
  }
  if (partial.parallelChapters !== undefined) {
    config.parallelChapters = Math.max(1, Math.min(5, partial.parallelChapters));
  }
  if (partial.retries !== undefined) {
    config.retries = Math.max(0, Math.min(10, partial.retries));
  }
  if (partial.retryDelayMs !== undefined) {
    config.retryDelayMs = Math.max(100, Math.min(30000, partial.retryDelayMs));
  }
  return { ...config };
}

// In-memory task store
const tasks = new Map<string, DownloadTask>();
let taskCounter = 0;
let isProcessing = false;

export function createTask(opts: {
  mangaTitle: string;
  sourceId: string;
  mangaUrl: string;
  chapters: { name: string; url: string }[];
}): DownloadTask {
  const script = getScript(opts.sourceId);
  const id = `dl-${++taskCounter}-${Date.now()}`;
  const task: DownloadTask = {
    id,
    mangaTitle: opts.mangaTitle,
    sourceId: opts.sourceId,
    sourceName: script?.name || opts.sourceId,
    mangaUrl: opts.mangaUrl,
    chapters: opts.chapters.map((ch) => ({
      name: ch.name,
      url: ch.url,
      status: "queued",
      pagesTotal: 0,
      pagesDownloaded: 0,
    })),
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  tasks.set(id, task);
  processQueue(); // Fire and forget
  return task;
}

export function getTask(id: string): DownloadTask | undefined {
  return tasks.get(id);
}

export function listTasks(): DownloadTask[] {
  return Array.from(tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function cancelTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.status === "completed" || task.status === "cancelled") return false;
  task.status = "cancelled";
  touch(task);
  for (const ch of task.chapters) {
    if (ch.status === "queued" || ch.status === "downloading") {
      ch.status = "cancelled";
    }
  }
  return true;
}

export function retryTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) return false;
  task.status = "queued";
  task.error = undefined;
  touch(task);
  for (const ch of task.chapters) {
    if (ch.status === "failed") {
      ch.status = "queued";
      ch.error = undefined;
      ch.pagesDownloaded = 0;
    }
  }
  processQueue();
  return true;
}

export function removeTask(id: string): boolean {
  return tasks.delete(id);
}

async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (true) {
      // Find next queued task
      const task = Array.from(tasks.values()).find((t) => t.status === "queued");
      if (!task) break;

      task.status = "downloading";
      touch(task);
      console.log(`[download] Starting: ${task.mangaTitle}`);

      try {
        await processTask(task);
        const allDone = task.chapters.every(
          (ch) => ch.status === "completed" || ch.status === "cancelled"
        );
        const anyFailed = task.chapters.some((ch) => ch.status === "failed");
        task.status = anyFailed ? "failed" : allDone ? "completed" : "failed";
        // We wrote these files, so we know exactly what moved. Rescanning the
        // whole library after every download is a tax we can decline to pay.
        await scan({ series: sanitizePath(task.mangaTitle) });
      } catch (e: any) {
        task.status = "failed";
        task.error = e?.message || String(e);
        console.error(`[download] Task failed: ${task.mangaTitle}`, e);
      }
      touch(task);
    }
  } finally {
    isProcessing = false;
  }
}

async function processTask(task: DownloadTask): Promise<void> {
  const script = getScript(task.sourceId);
  if (!script) throw new Error(`Script not found: ${task.sourceId}`);

  const mangaDir = getMangaDir();
  const seriesDir = join(mangaDir, sanitizePath(task.mangaTitle));
  await mkdir(seriesDir, { recursive: true });

  // Fetch and save manga metadata via Lua GetInfo
  try {
    const infoResult = await runModule(script.path, "GetInfo", {
      url: task.mangaUrl,
      rootUrl: script.rootUrl,
    });
    await saveMetadata(seriesDir, infoResult.mangaInfo, task.mangaTitle, task.mangaUrl, task.sourceId);
  } catch (e: any) {
    console.error(`[download]   Failed to fetch metadata: ${e?.message}`);
    // Continue without metadata - download can still proceed
  }

  // Process chapters with configurable parallelism
  const queuedChapters = task.chapters.filter((ch) => ch.status === "queued");
  const { parallelChapters } = config;

  for (let i = 0; i < queuedChapters.length; i += parallelChapters) {
    if ((task.status as DownloadStatus) === "cancelled") break;

    const batch = queuedChapters.slice(i, i + parallelChapters);
    await Promise.all(
      batch.map((chapter) => downloadChapter(task, script.path, script.rootUrl, seriesDir, chapter))
    );
  }
}

async function downloadChapter(
  task: DownloadTask,
  scriptPath: string,
  rootUrl: string,
  seriesDir: string,
  chapter: ChapterDownload
): Promise<void> {
  if ((task.status as DownloadStatus) === "cancelled") return;

  chapter.status = "downloading";
  touch(task);
  console.log(`[download]   Chapter: ${chapter.name}`);

  try {
    // Get page URLs using Lua script
    const result = await runModule(scriptPath, "GetPageNumber", {
      url: chapter.url,
      rootUrl,
    });

    const pageUrls = result.pages.pageLinks;
    chapter.pagesTotal = pageUrls.length;
    touch(task);

    if (pageUrls.length === 0) {
      throw new Error("No pages found");
    }

    // Stage into a hidden sibling directory. Pages used to be written straight
    // into the live chapter, so a download that failed half way left the
    // chapter as a mix of old and new pages -- and a re-pull from a source with
    // different filenames left BOTH sets side by side. Nothing touches the live
    // directory now until every page has arrived and validated.
    // The staging name is dot-prefixed so the scanner cannot read it as content.
    const chapterName = sanitizePath(chapter.name);
    const chapterDir = join(seriesDir, chapterName);
    const stagingDir = join(seriesDir, `.staging-${chapterName}`);
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });

    // Download pages with configurable parallelism
    const { parallelPages } = config;
    let downloaded = 0;

    for (let i = 0; i < pageUrls.length; i += parallelPages) {
      if ((task.status as DownloadStatus) === "cancelled") break;

      const pageBatch = pageUrls.slice(i, i + parallelPages);
      const results = await Promise.all(
        pageBatch.map((pageUrl, batchIdx) =>
          downloadPageWithRetry(pageUrl, chapter.url, stagingDir, i + batchIdx)
        )
      );

      for (const ok of results) {
        if (ok) downloaded++;
      }
      chapter.pagesDownloaded = downloaded;
      touch(task);
    }

    chapter.status = downloaded === chapter.pagesTotal ? "completed" : "failed";
    if (chapter.status === "failed") {
      // Throw the partial away. Whatever was on disk before is still there.
      await rm(stagingDir, { recursive: true, force: true });
      chapter.error = `Downloaded ${downloaded}/${chapter.pagesTotal} pages - existing copy kept`;
    } else {
      await commitChapter(seriesDir, chapterName, stagingDir, chapterDir);
      // Record where these pages came from. A library assembled from several
      // sources otherwise gives no way to tell which chapters came from a
      // source that later turns out to be wrong.
      await writeProvenance(seriesDir, sanitizePath(chapter.name), {
        module: task.sourceId,
        seriesUrl: task.mangaUrl,
        chapterUrl: chapter.url,
        fetchedAt: new Date().toISOString(),
      });
    }
  } catch (e: any) {
    chapter.status = "failed";
    chapter.error = e?.message || String(e);
    console.error(`[download]   Chapter failed: ${chapter.name}`, e);
    try {
      await rm(join(seriesDir, `.staging-${sanitizePath(chapter.name)}`), { recursive: true, force: true });
    } catch {}
  }
  touch(task);
}

/**
 * Swap a fully-downloaded chapter into place with a rename, so the live
 * directory is either the old chapter or the new one and never a blend of the
 * two. The outgoing copy is moved aside first and deleted only once the new
 * one is in place.
 */
export async function commitChapter(
  seriesDir: string,
  chapterName: string,
  stagingDir: string,
  chapterDir: string,
): Promise<void> {
  const outgoing = join(seriesDir, `.replaced-${chapterName}`);

  // Last line of defence before rename() and rm -rf. Every one of these must
  // sit directly inside the series directory; if a name ever derives a path
  // that climbs out, fail here rather than deleting whatever it landed on.
  assertDirectChild(seriesDir, chapterDir, "chapter directory");
  assertDirectChild(seriesDir, stagingDir, "staging directory");
  assertDirectChild(seriesDir, outgoing, "outgoing directory");

  await rm(outgoing, { recursive: true, force: true });
  let hadExisting = false;
  try {
    await readdir(chapterDir);
    await rename(chapterDir, outgoing);
    hadExisting = true;
  } catch {}
  try {
    await rename(stagingDir, chapterDir);
  } catch (e) {
    if (hadExisting) await rename(outgoing, chapterDir); // put the old one back
    throw e;
  }
  await rm(outgoing, { recursive: true, force: true });
}

/** Merge one chapter's provenance into the series metadata file. */
async function writeProvenance(
  seriesDir: string,
  chapterDirName: string,
  provenance: { module: string; seriesUrl?: string; chapterUrl?: string; fetchedAt: string },
): Promise<void> {
  try {
    const { meta } = await loadMeta(seriesDir);
    let entry: ChapterMeta | undefined = meta.chapters[chapterDirName];
    if (!entry) {
      // Derive the identity and the key rather than minting a random uid. A
      // random uid here is what made every chapter in the live library carry a
      // *pinned* id, which quietly falsifies the property the identity model is
      // built on: that deleting every sidecar leaves ids unchanged. It also left
      // the chapter keyless and at number 0 until the next full scan.
      const seriesName = basename(seriesDir);
      const k = deriveChapterKey(seriesName, chapterDirName);
      entry = {
        dir: chapterDirName,
        number: k.sortKey,
        label: k.label,
        sortKey: k.sortKey,
        sortKeyEnd: k.sortKeyEnd,
        sequence: k.sequence,
        mark: k.mark,
        pages: 0,
      };
      meta.chapters[chapterDirName] = entry;
    }
    recordProvenance(entry, provenance);
    if (provenance.module && !(meta.sources || []).includes(provenance.module)) {
      (meta.sources ||= []).push(provenance.module);
    }
    await saveMeta(seriesDir, meta);
  } catch (e) {
    console.error(`[download]   Could not record provenance for ${chapterDirName}`, e);
  }
}

// Detect real image bytes by magic number (JPEG/PNG/GIF/WebP/AVIF/BMP), so we
// never save an HTML block page as if it were a comic page.
function isImageBytes(buf: ArrayBuffer, contentType: string): boolean {
  if (contentType.startsWith("text/") || contentType.includes("html")) return false;
  const b = new Uint8Array(buf);
  if (b.length < 12) return false;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;                       // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;       // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;                        // GIF
  if (b[0] === 0x42 && b[1] === 0x4d) return true;                                         // BMP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true;      // RIFF....WEBP
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true;        // ....ftyp (AVIF/HEIC)
  // Fall back to the server's declared type if it clearly claims an image.
  return contentType.startsWith("image/");
}

async function downloadPageWithRetry(
  pageUrl: string,
  referer: string,
  chapterDir: string,
  pageIndex: number
): Promise<boolean> {
  const ext = getExtFromUrl(pageUrl);
  const filename = `${String(pageIndex + 1).padStart(3, "0")}${ext}`;
  const outPath = join(chapterDir, filename);
  const { retries, retryDelayMs } = config;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(pageUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          Referer: referer,
        },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const buffer = await resp.arrayBuffer();

      // Validate we actually got image bytes. Scraper sites (e.g. XoxoComics)
      // return a 200 HTML page — homepage / hotlink-block / soft-404 — instead
      // of the image when they don't like the request. Saving that as .jpg
      // yields "downloaded" chapters full of unreadable HTML, so reject it and
      // let the retry/fail path handle it.
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (!isImageBytes(buffer, ct)) {
        throw new Error(`not an image (content-type: ${ct || "?"}, ${buffer.byteLength} bytes)`);
      }

      await Bun.write(outPath, buffer);
      return true;
    } catch (e: any) {
      if (attempt < retries) {
        const delay = retryDelayMs * Math.pow(2, attempt);
        console.log(`[download]     Page ${pageIndex + 1} attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.error(`[download]     Page ${pageIndex + 1} failed after ${retries + 1} attempts: ${e?.message}`);
      }
    }
  }
  return false;
}

/**
 * Save full FMD2 metadata for a manga series: cover image, manga.json, and source-info.json.
 */
export interface SaveMetadataResult {
  coverSaved: boolean;
  coverError?: string;
}

export async function saveMetadata(
  seriesDir: string,
  info: MangaInfo,
  fallbackTitle: string,
  sourceUrl: string,
  sourceId?: string,
): Promise<SaveMetadataResult> {
  const result: SaveMetadataResult = { coverSaved: false };

  // Download cover image
  let coverFilename = "";
  if (info.coverLink) {
    try {
      const coverResp = await fetch(info.coverLink, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: sourceUrl,
        },
      });
      if (coverResp.ok) {
        const ext = getExtFromUrl(info.coverLink);
        coverFilename = `cover${ext}`;
        const buffer = await coverResp.arrayBuffer();
        await Bun.write(join(seriesDir, coverFilename), buffer);
        console.log(`[metadata]   Saved cover: ${coverFilename}`);
        result.coverSaved = true;
      } else {
        result.coverError = `HTTP ${coverResp.status}`;
      }
    } catch (e: any) {
      console.error(`[metadata]   Failed to download cover: ${e?.message}`);
      result.coverError = e?.message || "Download failed";
    }
  }

  // Save manga.json (library metadata)
  const meta: Record<string, any> = {
    title: info.title || fallbackTitle,
    author: info.authors || "",
    artist: info.artists || "",
    description: info.summary || "",
    link: info.link || sourceUrl || "",
    sourceId: sourceId || "",
    tags: info.genres ? info.genres.split(",").map((g: string) => g.trim()).filter(Boolean) : [],
    status: info.status || "",
    cover: coverFilename || info.coverLink || "",
  };
  await writeFile(join(seriesDir, "manga.json"), JSON.stringify(meta, null, 2));
  console.log(`[metadata]   Saved metadata for: ${meta.title}`);

  // Save source-info.json (full raw FMD2 output)
  const sourceInfo = {
    title: info.title,
    link: info.link,
    coverLink: info.coverLink,
    authors: info.authors,
    artists: info.artists,
    genres: info.genres,
    summary: info.summary,
    status: info.status,
    chapterNames: info.chapterNames,
    chapterLinks: info.chapterLinks,
  };
  await writeFile(join(seriesDir, "source-info.json"), JSON.stringify(sourceInfo, null, 2));
  console.log(`[metadata]   Saved source-info.json`);

  return result;
}

function sanitizePath(name: string): string {
  // Delegates to the shared guard, which rejects rather than returns the
  // pathological cases. `..` used to survive this function untouched and was
  // then joined onto the library root and passed to rename() and rm -rf.
  return safeSegment(name);
}

function getExtFromUrl(url: string): string {
  const match = url.match(/\.(jpe?g|png|webp|gif|avif|bmp)(\?|$)/i);
  return match?.[1] ? `.${match[1].toLowerCase()}` : ".jpg";
}
