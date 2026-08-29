/**
 * R-22 -- what does a spine actually cost, and R-09 -- is it still desaturated?
 *
 * `architecture.md` recorded that shrink-on-load is unavailable, so "full
 * decode is the floor" and 710k chapters meant 710k full decodes. That was
 * measured against the container's **ImageMagick**. `sharp` is libvips, it was
 * already a dependency and unused, and libvips does have shrink-on-load. This
 * bench prices the settled method rather than inheriting the claim.
 *
 * It benches `src/art/spine.ts` itself -- not a proxy for it -- so the number
 * it reports is the number the workers pay.
 *
 * It also prints, per chapter, the chroma of the source sliver against the
 * chroma of the encoded output. R-09 records that early crops came back
 * noticeably desaturated and that it was never resolved; a ratio materially
 * below 1.0 here is that defect, visible as a number.
 *
 *   bun run bench/spine-cost.ts [--chapters 100] [--dump out/]
 *
 * `--dump` writes the spines out as `<series>--<chapter>.image` so R-09 can be
 * settled the only way it can be settled: by looking at 100 real crops.
 */
import { readdir, mkdir, writeFile } from "fs/promises";
import { join, extname } from "path";
import { extractSpine } from "../src/art/spine";

const ROOT = process.env.MANGA_DIR || "/mnt/user/Media/Manga-new";
const EXTS = new Set([".jpg", ".jpeg", ".png", ".image", ".gif", ".bmp", ".avif"]);
const args = process.argv.slice(2);
const N = Number(args[args.indexOf("--chapters") + 1]) || 100;
const DUMP = args.includes("--dump") ? args[args.indexOf("--dump") + 1] : null;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
}

/** Deterministic spread, so two runs sample the same chapters. */
function sample<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)]!);
}

async function listChapters() {
  const out: { series: string; chapter: string; dir: string }[] = [];
  for (const s of (await readdir(ROOT, { withFileTypes: true })).filter((e) => e.isDirectory())) {
    for (const c of (await readdir(join(ROOT, s.name), { withFileTypes: true })).filter((e) => e.isDirectory())) {
      out.push({ series: s.name, chapter: c.name, dir: join(ROOT, s.name, c.name) });
    }
  }
  out.sort((a, b) => (a.series + a.chapter).localeCompare(b.series + b.chapter));
  return out;
}

if (DUMP) await mkdir(DUMP, { recursive: true });

const chapters = sample(await listChapters(), N);
const ms: number[] = [];
const chromaRatio: number[] = [];
const balloon: number[] = [];
const bytes: number[] = [];
const at: number[] = [];
let ok = 0, none = 0;

for (const ch of chapters) {
  let pages: string[];
  try {
    pages = (await readdir(ch.dir))
      .filter((f) => EXTS.has(extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  } catch {
    continue;
  }
  if (pages.length === 0) continue;

  const t = performance.now();
  const out = await extractSpine(pages.map((p) => join(ch.dir, p)));
  const took = performance.now() - t;
  if (!out) {
    none++;
    continue;
  }

  ms.push(took);
  bytes.push(out.image.byteLength);
  balloon.push(out.diag.balloon);
  at.push(out.diag.at);
  chromaRatio.push(out.diag.sourceChroma > 0.001 ? out.diag.outputChroma / out.diag.sourceChroma : 1);
  ok++;
  if (DUMP) {
    const name = `${ch.series}--${ch.chapter}`.replace(/[^A-Za-z0-9._-]+/g, "_");
    await writeFile(join(DUMP, `${name}.image`), out.image);
    await writeFile(join(DUMP, `${name}.json`), JSON.stringify({ tint: out.tint, ...out.diag }, null, 2));
  }
  if (ok % 20 === 0) process.stdout.write(`  ${ok}/${chapters.length}\r`);
}

const m = mean(ms);
console.log(`\nchapters: ${ok} extracted, ${none} with no decodable page`);
console.log(`\nper-chapter extraction (settled method: proxy saliency + native-resolution cut)`);
console.log(
  `  mean ${m.toFixed(1)} ms   p50 ${pct(ms, 0.5).toFixed(1)}   p90 ${pct(ms, 0.9).toFixed(1)}   p99 ${pct(ms, 0.99).toFixed(1)}   max ${Math.max(...ms).toFixed(1)}`,
);
console.log(`  real library (1,706 chapters):  ${((m * 1706) / 1000 / 60).toFixed(1)} min of one core`);
console.log(`  R-12 target (710,000 chapters): ${((m * 710_000) / 1000 / 3600).toFixed(1)} core-hours`);
console.log(`\noutput`);
console.log(`  spine bytes: mean ${(mean(bytes) / 1024).toFixed(1)} KB, p90 ${(pct(bytes, 0.9) / 1024).toFixed(1)} KB`);
console.log(`  store at target: ${((mean(bytes) * 710_000) / 1e9).toFixed(1)} GB of spines`);
console.log(
  `  cut position (fraction down the page): p10 ${pct(at, 0.1).toFixed(2)} p50 ${pct(at, 0.5).toFixed(2)} p90 ${pct(at, 0.9).toFixed(2)}`,
);
console.log(`  balloon fraction of the winning band: mean ${mean(balloon).toFixed(3)}, p90 ${pct(balloon, 0.9).toFixed(3)}`);
console.log(`\nR-09 chroma check -- output chroma / source chroma, 1.0 is faithful`);
console.log(
  `  mean ${mean(chromaRatio).toFixed(3)}   p10 ${pct(chromaRatio, 0.1).toFixed(3)}   p50 ${pct(chromaRatio, 0.5).toFixed(3)}   p90 ${pct(chromaRatio, 0.9).toFixed(3)}`,
);
if (DUMP) console.log(`\nspines written to ${DUMP} -- R-09 needs a person to look at them`);
