/**
 * Measure how scan cost grows with library size - the experiment register entry
 * R-02 asks for.
 *
 * R-02 claims a quick scan is ~0.3 s at 24M files. That number is arithmetic
 * from a flat readdir sweep, but the scanner does one readdir *and* one stat per
 * chapter directory, so the dominant term is per-chapter. This walks a real
 * scan over progressively larger synthetic trees and reports the curve, so the
 * projection can be replaced with a fit to measured points.
 *
 * Two numbers per scale, and the difference matters:
 *
 *   cold - no sidecar exists, so every chapter is fingerprinted (stat per page)
 *   warm - sidecars exist and mtime is unchanged, so the gate skips the
 *          fingerprint. This is the "quick tier", and it is the R-02 number.
 *
 *   bun run bench/scan-curve.ts --root /mnt/user/Media/.paperbox-bench \
 *     --steps 50,100,250,500 --chapters 140 --pages 8
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const argv = Bun.argv.slice(2);
const get = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};

const ROOT = get("root") ?? "";
const STEPS = (get("steps", "50,100,250") ?? "").split(",").map(Number).filter(Boolean);
const CHAPTERS = Number(get("chapters", "140"));
const PAGES = Number(get("pages", "8"));

if (!ROOT) throw new Error("--root is required");

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
  });
}

interface Row {
  series: number;
  chapters: number;
  coldMs: number;
  warmMs: number;
}

const rows: Row[] = [];

for (const series of STEPS) {
  // Grow the tree to this scale. mkdir is recursive, so this only adds what is
  // missing - the curve is measured on one growing tree, not rebuilt each time.
  process.stdout.write(`\n=== ${series} series ===\n`);
  await run(process.execPath, [
    join(import.meta.dir, "gen-tree.ts"),
    "--root", ROOT,
    "--series", String(series),
    "--chapters", String(CHAPTERS),
    "--pages", String(PAGES),
    "--min-free", "20000000000",
  ]);

  // Fresh process per scale: the scanner keeps module-level caches, and a warm
  // in-process cache would flatter the cold number into meaninglessness.
  const out = await run(process.execPath, [join(import.meta.dir, "time-scan.ts"), "--root", ROOT]);
  process.stdout.write(out);
  const cold = Number(out.match(/cold=(\d+)/)?.[1] ?? 0);
  const warm = Number(out.match(/warm=(\d+)/)?.[1] ?? 0);
  const chaps = Number(out.match(/chapters=(\d+)/)?.[1] ?? 0);
  rows.push({ series, chapters: chaps, coldMs: cold, warmMs: warm });
}

console.log("\n\n  series   chapters     cold      warm    warm us/chapter");
console.log("  " + "-".repeat(56));
for (const r of rows) {
  const per = r.chapters ? ((r.warmMs * 1000) / r.chapters).toFixed(1) : "-";
  console.log(
    `  ${String(r.series).padStart(6)}  ${String(r.chapters).padStart(9)}  ` +
      `${(r.coldMs / 1000).toFixed(2).padStart(7)}s  ${(r.warmMs / 1000).toFixed(2).padStart(7)}s  ${per.padStart(12)}`,
  );
}

// Extrapolate on the measured per-chapter cost rather than on a readdir rate.
const last = rows.at(-1);
if (last?.chapters) {
  const perChapterUs = (last.warmMs * 1000) / last.chapters;
  const target = 710_000; // 5,000 series x ~142 chapters, the R-12 target
  console.log(
    `\n  At the measured warm cost of ${perChapterUs.toFixed(1)} us/chapter, ` +
      `${target.toLocaleString()} chapters projects to ${((perChapterUs * target) / 1e6).toFixed(1)} s.`,
  );
  console.log("  Compare register R-02's stated ~0.3 s.");
}
