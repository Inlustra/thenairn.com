/**
 * Build a synthetic library, to settle register entry R-02.
 *
 * R-02 says "quick scan is ~0.3 s at 24M files", which is arithmetic from a
 * readdir rate measured on a flat sweep - not from what the scanner actually
 * does. The scanner readdirs *every chapter directory* and stats each one, so
 * the dominant term is per-chapter, not per-file. This generator exists to
 * measure that instead of projecting it.
 *
 * Files are created empty on purpose. The quick tier never opens a page; it
 * reads directory entries and one mtime per chapter. Empty files reproduce the
 * entry count and the stat cost while consuming metadata only - which matters
 * because the array this has to run on is 96% full.
 *
 * Naming deliberately mirrors the real library's variety (padded, unpadded,
 * Episode, Issue #, spin-offs), so a scan over this fixture also exercises the
 * chapter-key derivation at a scale the real library cannot reach.
 *
 *   bun run bench/gen-tree.ts --root /mnt/user/Media/.paperbox-bench \
 *     --series 500 --chapters 140 --pages 8
 *   bun run bench/gen-tree.ts --root /mnt/user/Media/.paperbox-bench --clean
 */
import { mkdir, writeFile, rm, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";

interface Opts {
  root: string;
  series: number;
  chapters: number;
  pages: number;
  clean: boolean;
  concurrency: number;
  /** Refuse to start if the filesystem would drop below this many free bytes. */
  minFreeBytes: number;
}

function parseArgs(argv: string[]): Opts {
  const get = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  return {
    root: get("root") ?? "",
    series: Number(get("series", "100")),
    chapters: Number(get("chapters", "140")),
    pages: Number(get("pages", "8")),
    clean: argv.includes("--clean"),
    concurrency: Number(get("concurrency", "32")),
    minFreeBytes: Number(get("min-free", String(50 * 1024 ** 3))),
  };
}

/**
 * A synthetic tree is millions of files under a path this script also deletes,
 * so the guard is deliberately paranoid: it must be an absolute path, it must
 * be marked as scratch by name, and it must not sit inside a real library.
 */
function assertSafeRoot(root: string) {
  if (!root || !root.startsWith("/")) {
    throw new Error("--root must be an absolute path");
  }
  if (!/(^|\/)\.?paperbox-bench(\/|$)/.test(root)) {
    throw new Error(
      `refusing to use ${root}: the bench root must be named "paperbox-bench" or ".paperbox-bench", ` +
        `so that --clean can never be pointed at a real library`,
    );
  }
  if (root.includes("/Manga-new") || root.includes("/Manga/")) {
    throw new Error(`refusing to use ${root}: that is inside a real library`);
  }
}

/** Mirror the real library's naming variety, so the fixture is not artificially uniform. */
function chapterName(seriesTitle: string, style: number, n: number): string {
  switch (style) {
    case 0:
      return `Chapter ${String(n).padStart(3, "0")}`;
    case 1:
      return `Chapter ${n}`; // unpadded: sorts lexically wrong, on purpose
    case 2:
      return `Episode ${String(n).padStart(3, "0")}`;
    case 3:
      return `${seriesTitle} Issue #${n}`; // needs the series title stripped
    default:
      return `Chapter ${String(n).padStart(3, "0")}`;
  }
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

async function freeBytes(path: string): Promise<number> {
  try {
    const s = await statfs(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function main() {
  const opts = parseArgs(Bun.argv.slice(2));
  assertSafeRoot(opts.root);

  if (opts.clean) {
    const before = await readdir(opts.root).catch(() => []);
    await rm(opts.root, { recursive: true, force: true });
    console.log(`removed ${opts.root} (${before.length} series)`);
    return;
  }

  const dirs = opts.series * opts.chapters;
  const files = dirs * opts.pages;
  const free = await freeBytes(opts.root.replace(/\/[^/]+$/, ""));
  console.log(
    `generating ${opts.series} series x ${opts.chapters} chapters x ${opts.pages} pages\n` +
      `  = ${dirs.toLocaleString()} directories, ${files.toLocaleString()} files\n` +
      `  root: ${opts.root}\n` +
      `  free: ${(free / 1024 ** 3).toFixed(0)} GiB`,
  );
  if (free < opts.minFreeBytes) {
    throw new Error(
      `only ${(free / 1024 ** 3).toFixed(0)} GiB free, below the ${(opts.minFreeBytes / 1024 ** 3).toFixed(0)} GiB floor. ` +
        `Pass --min-free to override deliberately.`,
    );
  }

  const started = Date.now();
  let madeDirs = 0;
  const seriesList = Array.from({ length: opts.series }, (_, i) => i);

  await pool(seriesList, opts.concurrency, async (s) => {
    const style = s % 4;
    const title = `Bench Series ${String(s).padStart(5, "0")}`;
    const seriesDir = join(opts.root, title);
    await mkdir(seriesDir, { recursive: true });

    for (let c = 1; c <= opts.chapters; c++) {
      const dir = join(seriesDir, chapterName(title, style, c));
      await mkdir(dir, { recursive: true });
      for (let p = 1; p <= opts.pages; p++) {
        await writeFile(join(dir, `${String(p).padStart(3, "0")}.jpg`), "");
      }
      madeDirs++;
    }
    // Two series in every hundred carry a second sequence, so block keying by
    // (sequence, number) is exercised rather than assumed.
    if (s % 50 === 0) {
      for (let k = 1; k <= 2; k++) {
        const dir = join(seriesDir, `Spin-off #${String(k).padStart(3, "0")}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "001.jpg"), "");
        madeDirs++;
      }
    }
    if (s % 25 === 0) {
      const pct = ((s / opts.series) * 100).toFixed(0);
      console.log(`  ${pct}% - ${madeDirs.toLocaleString()} chapter dirs, ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  });

  const secs = (Date.now() - started) / 1000;
  console.log(
    `done in ${secs.toFixed(1)}s - ${madeDirs.toLocaleString()} chapter dirs, ` +
      `${(madeDirs * opts.pages).toLocaleString()} files ` +
      `(${Math.round((madeDirs * opts.pages) / secs).toLocaleString()} files/s)`,
  );
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
