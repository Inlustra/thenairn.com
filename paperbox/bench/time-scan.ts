/**
 * Time one cold scan and one warm scan of a library, in a fresh process.
 *
 * Run standalone by scan-curve.ts so the scanner's module-level caches start
 * empty each time - reusing a process would make the second scale's "cold"
 * number a warm one.
 *
 *   bun run bench/time-scan.ts --root /path/to/library
 */
const argv = Bun.argv.slice(2);
const i = argv.indexOf("--root");
const root = i >= 0 ? argv[i + 1] : undefined;
if (!root) throw new Error("--root is required");

// Must be set before the scanner is imported, and before any scan: the module
// reads it at call time, but the tree cache keys on scan generation, not path.
process.env.MANGA_DIR = root;

const scanner = await import("../src/scanner/index.ts");

// Cold: sidecars may not exist, so every chapter is fingerprinted.
const t0 = performance.now();
await scanner.scan();
const cold = Math.round(performance.now() - t0);

// Warm: sidecars now exist and no mtime has changed, so the gate should skip
// fingerprinting entirely. This is the quick tier.
const t1 = performance.now();
await scanner.scan();
const warm = Math.round(performance.now() - t1);

const list = scanner.getMangaList();
const series = list.length;
const chapters = list.reduce(
  (n: number, m: any) => n + (scanner.getManga(m.id)?.chapters.length ?? 0),
  0,
);

console.log(`  series=${series} chapters=${chapters} cold=${cold} warm=${warm}`);
