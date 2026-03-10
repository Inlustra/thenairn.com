import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { runModule } from "../lua/engine";
import { getScript, getScriptByName } from "../lua/scripts";
import { getMangaDir } from "../scanner";

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

  for (const chapter of task.chapters) {
    if (task.status === "cancelled") break;
    if (chapter.status !== "queued") continue;

    chapter.status = "downloading";
    task.updatedAt = Date.now();
    console.log(`[download]   Chapter: ${chapter.name}`);

    try {
      // Get page URLs using Lua script
      const result = await runModule(script.path, "GetPageNumber", {
        url: chapter.url,
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

      // Download each page
      for (let i = 0; i < pageUrls.length; i++) {
        if (task.status === "cancelled") break;

        const pageUrl = pageUrls[i];
        const ext = getExtFromUrl(pageUrl);
        const filename = `${String(i + 1).padStart(3, "0")}${ext}`;
        const outPath = join(chapterDir, filename);

        try {
          const resp = await fetch(pageUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              Referer: chapter.url,
            },
          });

          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

          const buffer = await resp.arrayBuffer();
          await Bun.write(outPath, buffer);
          chapter.pagesDownloaded = i + 1;
          task.updatedAt = Date.now();
        } catch (e: any) {
          console.error(`[download]     Page ${i + 1} failed: ${e?.message}`);
          // Continue with remaining pages
        }
      }

      chapter.status = chapter.pagesDownloaded === chapter.pagesTotal ? "completed" : "failed";
      if (chapter.status === "failed") {
        chapter.error = `Downloaded ${chapter.pagesDownloaded}/${chapter.pagesTotal} pages`;
      }
    } catch (e: any) {
      chapter.status = "failed";
      chapter.error = e?.message || String(e);
      console.error(`[download]   Chapter failed: ${chapter.name}`, e);
    }
    task.updatedAt = Date.now();
  }
}

function sanitizePath(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "_").trim();
}

function getExtFromUrl(url: string): string {
  const match = url.match(/\.(jpe?g|png|webp|gif|avif|bmp)(\?|$)/i);
  return match ? `.${match[1].toLowerCase()}` : ".jpg";
}
