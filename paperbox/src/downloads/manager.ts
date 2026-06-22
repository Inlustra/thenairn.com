import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { runModule, type MangaInfo } from "../lua/engine";
import { getScript, getScriptByName } from "../lua/scripts";
import { getMangaDir, scan } from "../scanner";

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
  task.updatedAt = Date.now();
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
  task.updatedAt = Date.now();
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
      task.updatedAt = Date.now();
      console.log(`[download] Starting: ${task.mangaTitle}`);

      try {
        await processTask(task);
        const allDone = task.chapters.every(
          (ch) => ch.status === "completed" || ch.status === "cancelled"
        );
        const anyFailed = task.chapters.some((ch) => ch.status === "failed");
        task.status = anyFailed ? "failed" : allDone ? "completed" : "failed";
        // Rescan manga directory so new downloads appear in the library
        await scan();
      } catch (e: any) {
        task.status = "failed";
        task.error = e?.message || String(e);
        console.error(`[download] Task failed: ${task.mangaTitle}`, e);
      }
      task.updatedAt = Date.now();
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
  task.updatedAt = Date.now();
  console.log(`[download]   Chapter: ${chapter.name}`);

  try {
    // Get page URLs using Lua script
    const result = await runModule(scriptPath, "GetPageNumber", {
      url: chapter.url,
      rootUrl,
    });

    const pageUrls = result.pages.pageLinks;
    chapter.pagesTotal = pageUrls.length;
    task.updatedAt = Date.now();

    if (pageUrls.length === 0) {
      throw new Error("No pages found");
    }

    // Create chapter directory
    const chapterDir = join(seriesDir, sanitizePath(chapter.name));
    await mkdir(chapterDir, { recursive: true });

    // Download pages with configurable parallelism
    const { parallelPages } = config;
    let downloaded = 0;

    for (let i = 0; i < pageUrls.length; i += parallelPages) {
      if ((task.status as DownloadStatus) === "cancelled") break;

      const pageBatch = pageUrls.slice(i, i + parallelPages);
      const results = await Promise.all(
        pageBatch.map((pageUrl, batchIdx) =>
          downloadPageWithRetry(pageUrl, chapter.url, chapterDir, i + batchIdx)
        )
      );

      for (const ok of results) {
        if (ok) downloaded++;
      }
      chapter.pagesDownloaded = downloaded;
      task.updatedAt = Date.now();
    }

    chapter.status = downloaded === chapter.pagesTotal ? "completed" : "failed";
    if (chapter.status === "failed") {
      chapter.error = `Downloaded ${downloaded}/${chapter.pagesTotal} pages`;
    }
  } catch (e: any) {
    chapter.status = "failed";
    chapter.error = e?.message || String(e);
    console.error(`[download]   Chapter failed: ${chapter.name}`, e);
  }
  task.updatedAt = Date.now();
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
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: referer,
        },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const buffer = await resp.arrayBuffer();
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
  return name.replace(/[<>:"/\\|?*]/g, "_").trim();
}

function getExtFromUrl(url: string): string {
  const match = url.match(/\.(jpe?g|png|webp|gif|avif|bmp)(\?|$)/i);
  return match?.[1] ? `.${match[1].toLowerCase()}` : ".jpg";
}
