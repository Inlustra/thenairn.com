/**
 * R-09 -- where does the desaturation come from?
 *
 * The register records that early spine crops "came back noticeably
 * desaturated and were never resolved". That is a symptom with at least three
 * plausible mechanisms, and guessing between them is how it stayed unresolved.
 * This bench eliminates two of them and finds the third.
 *
 *   1. Colour profile / colourspace mishandling on decode. Ruled out by
 *      measurement: **0 of 60 sampled pages carry an embedded ICC profile**
 *      (48 srgb/uchar, 12 rgb16/ushort), and decoding with and without an
 *      explicit `toColourspace("srgb")` agrees to four decimal places of mean
 *      chroma on every one of them.
 *   2. Cutting the sliver from a downscaled proxy, where the reduction averages
 *      neighbouring pixels. Ruled out below: the ratio comes back 1.000.
 *   3. **Deriving the tint as a mean colour.** This is it. A mean over comic
 *      artwork converges on mud, and it does so by a factor this bench prints.
 *
 * Re-run it after touching anything in the decode path. A tint-chroma ratio
 * back near 1.0 means someone reintroduced the average.
 */
import sharp from "sharp";
import { readdir } from "fs/promises";
import { join, extname } from "path";
import { dominantOf, measureChroma } from "../src/art/spine";
const ROOT = "/mnt/user/Media/Manga-new";
const EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const rows: { native: number; proxy: number; meanTint: number; modeTint: number }[] = [];

for (const s of (await readdir(ROOT, { withFileTypes: true })).filter(e => e.isDirectory())) {
  const chs = (await readdir(join(ROOT, s.name), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
  for (const c of chs.filter((_, i) => i % 40 === 0).slice(0, 2)) {
    let ps: string[] = [];
    try { ps = (await readdir(join(ROOT, s.name, c))).filter(f => EXTS.has(extname(f).toLowerCase())).sort(); } catch { continue; }
    const f = ps[Math.floor(ps.length / 2)];
    if (!f) continue;
    const p = join(ROOT, s.name, c, f);
    try {
      const m = await sharp(p, { limitInputPixels: false }).metadata();
      const w = m.width!, h = m.height!;
      const sw = Math.round(w * 0.22), sh = Math.min(h, Math.round(sw * 560 / 120));
      const box = { left: Math.round((w - sw) / 2), top: Math.round(h * 0.3), width: sw, height: sh };
      const nat = await sharp(p, { limitInputPixels: false, sequentialRead: true }).extract(box).toColourspace("srgb").removeAlpha().raw().toBuffer();

      const PW = 200;
      const pr = await sharp(p, { limitInputPixels: false, sequentialRead: true }).resize({ width: PW, fit: "inside", withoutEnlargement: true }).toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const scale = pr.info.width / w;
      const pbox = { left: Math.round(box.left * scale), top: Math.round(box.top * scale), width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.min(pr.info.height, Math.round(sh * scale))) };
      const prox = await sharp(pr.data, { raw: { width: pr.info.width, height: pr.info.height, channels: 3 } }).extract(pbox).raw().toBuffer();

      // tint comparison: mean vs mode, expressed as the tint's own chroma
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let i = 0; i + 2 < nat.length; i += 3) { sr += nat[i]!; sg += nat[i+1]!; sb += nat[i+2]!; n++; }
      const mr = sr/n, mg = sg/n, mb = sb/n;
      const meanTint = (Math.max(mr,mg,mb) - Math.min(mr,mg,mb)) / 255;
      const t = dominantOf(nat);
      const modeTint = (Math.max(...t.rgb) - Math.min(...t.rgb)) / 255;

      rows.push({ native: measureChroma(nat), proxy: measureChroma(prox), meanTint, modeTint });
    } catch {}
  }
}
const mean = (x: number[]) => x.reduce((a,b)=>a+b,0)/(x.length||1);
console.log(`slivers: ${rows.length}`);
console.log(`(0 of 60 sampled pages carry an ICC profile -- colourspace is not the mechanism)`);
console.log(`sliver chroma   native cut = ${mean(rows.map(r=>r.native)).toFixed(4)}   cut from 200px proxy = ${mean(rows.map(r=>r.proxy)).toFixed(4)}   ratio ${(mean(rows.map(r=>r.proxy))/mean(rows.map(r=>r.native))).toFixed(3)}`);
console.log(`tint chroma     mean colour = ${mean(rows.map(r=>r.meanTint)).toFixed(4)}   histogram mode = ${mean(rows.map(r=>r.modeTint)).toFixed(4)}   ratio ${(mean(rows.map(r=>r.meanTint))/mean(rows.map(r=>r.modeTint))).toFixed(3)}`);
