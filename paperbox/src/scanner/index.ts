import { readdir, stat, readFile } from "fs/promises";
import { join, extname } from "path";
import type { Manga, MangaDetail, MangaMeta, Chapter, Page } from "../types";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"]);
const MANGA_DIR = process.env.MANGA_DIR || "/manga";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseChapterNumber(name: string): number {
  const match = name.match(/(\d+(?:\.\d+)?)/);
  return match?.[1] ? parseFloat(match[1]) : 0;
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readMeta(mangaPath: string): Promise<MangaMeta> {
  try {
    const raw = await readFile(join(mangaPath, "manga.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function findCover(mangaPath: string, chapters: string[]): Promise<string | null> {
  // Check for explicit cover file
  for (const ext of IMAGE_EXTS) {
    try {
      await stat(join(mangaPath, `cover${ext}`));
      return `cover${ext}`;
    } catch {}
  }
  // Fall back to first page of first chapter
  if (chapters.length > 0) {
    const firstChapter = chapters[0]!;
    const pages = await getPageFiles(join(mangaPath, firstChapter));
    if (pages.length > 0) return `${firstChapter}/${pages[0]}`;
  }
  return null;
}

async function getPageFiles(chapterPath: string): Promise<string[]> {
  try {
    const entries = await readdir(chapterPath);
    return entries
      .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
      .sort(naturalSort);
  } catch {
    return [];
  }
}

// In-memory cache
let mangaCache: Map<string, MangaDetail> = new Map();
let lastScan = 0;

export async function scan(): Promise<void> {
  const newCache = new Map<string, MangaDetail>();

  let entries: string[];
  try {
    entries = await readdir(MANGA_DIR);
  } catch (e) {
    console.error(`Failed to read manga directory: ${MANGA_DIR}`, e);
    return;
  }

  for (const entry of entries) {
    const mangaPath = join(MANGA_DIR, entry);
    if (!(await isDirectory(mangaPath))) continue;

    const id = slugify(entry);
    const meta = await readMeta(mangaPath);

    // Find chapter directories
    const subEntries = await readdir(mangaPath);
    const chapterDirs: string[] = [];
    for (const sub of subEntries) {
      if (await isDirectory(join(mangaPath, sub))) {
        chapterDirs.push(sub);
      }
    }
    chapterDirs.sort(naturalSort);

    // Resolve cover: local file > remote URL from meta > fallback to first chapter page
    let coverUrl: string | null = null;
    let localCover: string | null = null;
    if (meta.cover && !meta.cover.startsWith("http")) {
      try {
        await stat(join(mangaPath, meta.cover));
        localCover = meta.cover;
      } catch {}
    }
    if (localCover) {
      coverUrl = `/api/images/${entry}/${localCover}`;
    } else if (meta.cover && meta.cover.startsWith("http")) {
      coverUrl = meta.cover;
    } else {
      const fallback = await findCover(mangaPath, chapterDirs);
      if (fallback) coverUrl = `/api/images/${entry}/${fallback}`;
    }

    const chapters: Chapter[] = [];
    for (const dir of chapterDirs) {
      const pages = await getPageFiles(join(mangaPath, dir));
      chapters.push({
        id: `${id}--${slugify(dir)}`,
        mangaId: id,
        title: dir,
        number: parseChapterNumber(dir),
        pageCount: pages.length,
      });
    }

    newCache.set(id, {
      id,
      title: meta.title || entry,
      coverUrl,
      chapterCount: chapters.length,
      meta,
      chapters,
    });
  }

  mangaCache = newCache;
  lastScan = Date.now();
  console.log(`Scanned ${mangaCache.size} manga series`);
}

export function getMangaList(): Manga[] {
  return Array.from(mangaCache.values()).map(({ chapters, ...manga }) => manga);
}

export function getManga(id: string): MangaDetail | undefined {
  return mangaCache.get(id);
}

export async function getPages(mangaId: string, chapterId: string): Promise<Page[]> {
  const manga = mangaCache.get(mangaId);
  if (!manga) return [];

  const chapter = manga.chapters.find((c) => c.id === chapterId);
  if (!chapter) return [];

  // Find original folder name from manga cache
  const mangaEntry = await findOriginalName(mangaId);
  if (!mangaEntry) return [];

  const chapterPath = join(MANGA_DIR, mangaEntry, chapter.title);
  const files = await getPageFiles(chapterPath);

  return files.map((filename, index) => ({
    index,
    filename,
    url: `/api/images/${mangaEntry}/${chapter.title}/${filename}`,
  }));
}

async function findOriginalName(mangaId: string): Promise<string | null> {
  try {
    const entries = await readdir(MANGA_DIR);
    return entries.find((e) => slugify(e) === mangaId) || null;
  } catch {
    return null;
  }
}

export function getLastScan(): number {
  return lastScan;
}

export function getMangaDir(): string {
  return MANGA_DIR;
}
