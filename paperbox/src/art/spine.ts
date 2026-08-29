/**
 * Spine art: a narrow vertical sliver cut from inside a chapter, plus the
 * chapter's dominant colour.
 *
 * `ui.md` describes the shelf this feeds -- chapters render as book spines with
 * an **upright** numeral on a printed foot band in the chapter's own dominant
 * colour, text picked by luminance. The sliver is "chosen by saliency scoring
 * rather than a fixed position, with speech balloons actively penalised".
 *
 * That method is settled and is not re-derived here. In particular:
 *
 *   - the sliver comes from **inside** the chapter, never page 1 and never a
 *     fixed offset. Position is chosen.
 *   - the 45-degree skewed numeral was tried during design and **lost** against
 *     real artwork. Nothing in this module produces a skew, and the foot band
 *     it feeds is upright.
 *
 * -------------------------------------------------------------------------
 * Two resolutions, and why
 * -------------------------------------------------------------------------
 * Pages run to 46,564 px tall (R-04), so a sliver is a small fraction of a very
 * large image, and scoring the whole page at native resolution is the expensive
 * path. So:
 *
 *   **Score on a downscaled proxy. Cut from the original.**
 *
 * The proxy is what shrink-on-load is for -- `architecture.md` recorded that it
 * was unavailable, but that was the container's ImageMagick; `sharp` is libvips
 * and does have it. Measured (R-22): a proxy decode of the tallest page in this
 * library is 144 ms against 179 ms for a native decode of the same file, and on
 * WebP the ratio is 2.3x. The cut is then one `extract` at native resolution,
 * which is the only place full-quality pixels are read, and it is a sliver.
 *
 * PNG is the exception and it is worth stating rather than discovering: libvips
 * has no shrink-on-load for PNG, so the proxy costs a full decode *plus* a
 * reduction -- measured at 208 ms against 130 ms native, i.e. the proxy is
 * 1.6x **slower**. It is kept anyway, because the proxy also bounds memory: a
 * 1080x15122 page is 49 MB of raw pixels and there are eight workers.
 *
 * -------------------------------------------------------------------------
 * Saliency, in the shape smartcrop.js established
 * -------------------------------------------------------------------------
 * smartcrop was the reference during design: build cheap per-pixel importance
 * maps, then score every candidate crop as a weighted sum over them. This is
 * that, reduced to the two maps that mean anything on comic artwork (edge
 * detail and saturation) and specialised to a fixed-aspect vertical sliver
 * whose only free variable is its vertical position.
 *
 * The balloon penalty is a **separate rerank pass**, not a term folded into the
 * base score, and that is deliberate. Folded in, a very colourful panel
 * outvotes a large balloon sitting on top of it and the crop lands on the
 * balloon anyway -- which is the failure the design iteration was fixing. As a
 * rerank it is multiplicative and can veto: a band that is mostly balloon
 * cannot win no matter how good its artwork score was.
 *
 * It remains a *proxy*, not detection, and the limit is measured rather than
 * guessed. Dumping 24 real chapters (`bench/spine-cost.ts --dump`) and looking
 * at the first twelve:
 *
 *   - with a one-sided (near-white) mask, **2 of 12** crops landed on text --
 *     white lettering over a flat black caption plate, which scores high on edge
 *     energy and paid no penalty at all
 *   - making the mask two-sided fixed those, and did **not** prevent two others:
 *     text over a mid-green panel, and white text over a blue sky gradient
 *
 * So the honest statement is: the flat-region proxy catches text on flat
 * grounds, in either polarity, and cannot catch text on coloured grounds --
 * which is a real share of the failure the design iteration was fixing.
 * Closing that needs actual text detection (stroke-width transform, MSER), and
 * that is a design decision rather than a tweak. **R-09 stays open**, with this
 * as the named gap.
 *
 * -------------------------------------------------------------------------
 * The desaturation defect (R-09) -- mechanism found, and guarded against here
 * -------------------------------------------------------------------------
 * Early crops came back noticeably desaturated and it was never resolved.
 * `bench/spine-colour.ts` eliminated the two obvious explanations and found the
 * third:
 *
 *   - **not** colour management: 0 of 60 sampled pages carry an embedded ICC
 *     profile, and decoding with and without an explicit sRGB conversion agrees
 *     to four decimal places of chroma on every one of them
 *   - **not** the downscale: a sliver cut from a 200px proxy has the same mean
 *     chroma as the same sliver cut at native resolution, to three decimals
 *   - **it was the tint**: a mean colour over comic artwork is 3.4x less
 *     chromatic than the mode of the same pixels. A mean converges on mud, and
 *     a foot band painted in mud is exactly "noticeably desaturated"
 *
 * Hence `dominantOf` is a histogram mode with paper and ink excluded, not an
 * average. Two guards keep it that way:
 *
 *   1. Decode is still pinned to sRGB explicitly. It costs nothing, and it
 *      means a future page that *does* carry a profile, or arrives as 16-bit or
 *      CMYK, cannot reintroduce the question.
 *   2. `measureChroma` reports source and output chroma on every extraction and
 *      `bench/spine-cost.ts` prints the ratio -- 0.992 across 59 real chapters.
 *      A drop is visible as a number rather than as a vague impression.
 */
import sharp from "sharp";
import { artKey, put, has, type StoredArt } from "./store";

/**
 * Output geometry. Changing any of these means bumping ART_VERSION.
 *
 * The slot is always 124 CSS px tall and 21-44 px wide -- width carries reading
 * length. `object-fit: cover` then crops whatever does not fit, so the stored
 * aspect decides WHICH art survives.
 *
 * 132x372 is 3x of the WIDEST slot (44x124). Matching the widest means a thick
 * spine is never cropped vertically and is still sharp on a 3x display; thin
 * spines lose art from the sides, which is right, because a spine is a texture
 * and its edges carry nothing.
 *
 * The previous 120x560 was a guess at neither: at 9.7 KB it shipped roughly
 * twice the pixels a phone can use, and its taller aspect meant a thick spine
 * lost about 40% of its height to the crop -- paying for pixels and then
 * throwing them away.
 */
export const SPINE_W = 132;
export const SPINE_H = 372;
/**
 * Sliver width as a fraction of the page. Page widths are effectively
 * standardised (800/940/1200 -- architecture.md), so a fraction is portable
 * across series in a way that a pixel count is not.
 */
const SLIVER_FRACTION = 0.22;
/**
 * Proxy width. Small enough that a 46,564px page is a 12 MP raster rather than
 * a 37 MP one; large enough that a balloon is still tens of pixels across and
 * the edge map is not just noise.
 */
const PROXY_W = 200;
/** How many pages inside the chapter are considered. See `candidatePages`. */
const CANDIDATES = 3;

export interface Tint {
  /** Dominant colour of the chosen sliver, at full quality. */
  rgb: [number, number, number];
  hex: string;
  /** Foot-band text colour, picked by luminance. See ui.md. */
  text: "#000000" | "#ffffff";
}

export interface SpineDiagnostics {
  /** Which page the sliver came from. */
  page: string;
  /** Top of the sliver as a fraction of page height. */
  at: number;
  /** Saliency score before the balloon rerank, and after. */
  score: number;
  reranked: number;
  /** Fraction of the winning band that read as balloon/blank. */
  balloon: number;
  /** Mean chroma of the source sliver and of the encoded output. See R-09. */
  sourceChroma: number;
  outputChroma: number;
}

export interface SpineResult {
  /** The encoded picture. Codec-neutral by name: it was WebP until v2. */
  image: Uint8Array;
  tint: Tint;
  diag: SpineDiagnostics;
}

/**
 * Which pages inside the chapter are considered.
 *
 * Page 1 is a title plate, a scanlator banner or a credits card far more often
 * than it is artwork, and the shelf's whole point is that a spine shows the
 * chapter rather than its packaging -- so it is skipped whenever skipping it
 * still leaves a choice. The last page is kept: end-of-chapter splash panels
 * are some of the best artwork in a volume.
 *
 * Exported because it is the one pure part of the algorithm, and the part most
 * likely to move when R-09 is finally looked at.
 */
export function candidatePages(pages: string[], n = CANDIDATES): string[] {
  if (pages.length === 0) return [];
  const pool = pages.length > 3 ? pages.slice(1) : pages;
  if (pool.length <= n) return pool;
  const step = pool.length / n;
  return Array.from({ length: n }, (_, i) => pool[Math.floor(i * step + step / 2)]!);
}

interface Raster {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Decode to the scoring proxy.
 *
 * `toColourspace("srgb")` is not decoration: it is half of the guard against
 * the R-09 desaturation defect. Without it a CMYK or 16-bit page reaches the
 * raw buffer in its own space and every downstream number -- saturation,
 * chroma, the dominant colour -- is computed in the wrong one.
 */
async function proxy(path: string): Promise<Raster | null> {
  try {
    const { data, info } = await sharp(path, { limitInputPixels: false, sequentialRead: true })
      .resize({ width: PROXY_W, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3 || info.width < 8 || info.height < 8) return null;
    return { data, width: info.width, height: info.height };
  } catch {
    // Undecodable pages are real and not rare. This library holds `.jpg` files
    // that are HTML error pages a download wrote as artwork -- 19 of them found
    // while measuring R-22. A spine is not worth failing a job over: the caller
    // moves to the next candidate, and a chapter with no decodable page simply
    // has no spine, which the shelf already draws as pencil.
    return null;
  }
}

/**
 * Per-pixel importance maps, computed once per proxy.
 *
 * `detail` is a cheap Sobel-ish gradient magnitude on luma; `sat` is chroma;
 * `blank` marks flat near-white pixels. smartcrop builds the same kind of maps
 * and then integrates them over candidate crops, which is what `bandScores`
 * does below.
 */
interface Maps {
  detail: Float32Array;
  sat: Float32Array;
  blank: Uint8Array;
  width: number;
  height: number;
}

function buildMaps(r: Raster): Maps {
  const { width: w, height: h, data } = r;
  const detail = new Float32Array(w * h);
  const sat = new Float32Array(w * h);
  const blank = new Uint8Array(w * h);
  const luma = new Float32Array(w * h);
  for (let i = 0, p = 0; p < w * h; p++, i += 3) {
    const rr = data[i]!, gg = data[i + 1]!, bb = data[i + 2]!;
    luma[p] = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
    const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
    sat[p] = (mx - mn) / 255;
    // Flat and extreme, in either direction. A balloon interior, a gutter and a
    // blank margin are flat and pale; a caption box and a title plate are flat
    // and near-black. Only penalising the pale side let white-on-black text
    // panels win outright -- they score high on edge energy and paid no penalty
    // at all. Measured on 24 real chapters: two of the first twelve crops
    // landed on caption text before this was two-sided.
    if (mx - mn < 14 && (mx > 232 || mx < 40)) blank[p] = 1;
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const gx = luma[p + 1]! - luma[p - 1]!;
      const gy = luma[p + w]! - luma[p - w]!;
      detail[p] = Math.min(1, Math.sqrt(gx * gx + gy * gy) / 255);
    }
  }
  return { detail, sat, blank, width: w, height: h };
}

/** Weights. A judgement, not a measurement; the first thing to move on R-09. */
const W_DETAIL = 1.0;
const W_SAT = 0.9;
/** How hard the rerank punishes blank area. 3 means a half-blank band keeps
 *  an eighth of its score, so it can only win against near-nothing. */
const BALLOON_EXPONENT = 3;

interface BandScore {
  top: number;
  score: number;
  reranked: number;
  balloon: number;
}

/**
 * Score every candidate vertical position, then rerank.
 *
 * Two passes, kept separate on purpose -- see the module header. `score` is
 * what the artwork is worth; `reranked` is what it is worth after the balloons
 * on top of it are accounted for, and it is `reranked` that decides.
 */
export function bandScores(m: Maps, bandH: number, step: number): BandScore[] {
  const out: BandScore[] = [];
  const left = Math.max(0, Math.round((m.width - m.width * SLIVER_FRACTION) / 2));
  const right = Math.min(m.width, left + Math.max(1, Math.round(m.width * SLIVER_FRACTION)));
  for (let top = 0; top === 0 || top + bandH <= m.height; top += step) {
    const bottom = Math.min(m.height, top + bandH);
    let detail = 0, sat = 0, blank = 0, n = 0;
    for (let y = top; y < bottom; y++) {
      const row = y * m.width;
      for (let x = left; x < right; x++) {
        const p = row + x;
        detail += m.detail[p]!;
        sat += m.sat[p]!;
        blank += m.blank[p]!;
        n++;
      }
    }
    if (n === 0) break;
    const score = (W_DETAIL * detail + W_SAT * sat) / n;
    const balloon = blank / n;
    // Multiplicative, so it can veto. Folded into `score` as a subtraction it
    // could not: a saturated panel behind a large balloon would still win.
    out.push({ top, score, reranked: score * Math.pow(1 - balloon, BALLOON_EXPONENT), balloon });
    if (bottom >= m.height) break;
  }
  return out;
}

/**
 * Dominant colour by coarse histogram mode, not by mean.
 *
 * A mean over artwork converges on mud: every sliver comes back the same
 * desaturated grey-brown, which is very close to the complaint recorded in
 * R-09, and a mean would make that defect unfixable by construction. The mode
 * of a 5-bit-per-channel histogram returns a colour that is actually *in* the
 * picture. Near-white, near-black and near-grey are excluded because paper and
 * ink are in every panel and neither is the chapter's colour; if nothing
 * survives the exclusion the sliver really is monochrome, and the mean is then
 * the honest answer.
 *
 * Computed from the **full-quality** sliver, not the proxy: the proxy has been
 * through a reduction that averages neighbouring pixels, which is itself a
 * desaturating operation.
 */
export function dominantOf(rgb3: Uint8Array | Buffer): Tint {
  const bins = new Map<number, number>();
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i + 2 < rgb3.length; i += 3) {
    const rr = rgb3[i]!, gg = rgb3[i + 1]!, bb = rgb3[i + 2]!;
    sr += rr; sg += gg; sb += bb; n++;
    const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
    if (mx > 240 || mx < 24 || mx - mn < 18) continue;
    bins.set(((rr >> 3) << 10) | ((gg >> 3) << 5) | (bb >> 3), (bins.get(((rr >> 3) << 10) | ((gg >> 3) << 5) | (bb >> 3)) ?? 0) + 1);
  }
  let rgb: [number, number, number];
  if (bins.size > 0) {
    let best = -1, bestBin = 0;
    for (const [bin, count] of bins) if (count > best) { best = count; bestBin = bin; }
    // Bin centres, not bin floors: the floor is systematically darker than the
    // colour it stands for, which reads as -- again -- desaturation.
    rgb = [(((bestBin >> 10) & 31) << 3) | 4, (((bestBin >> 5) & 31) << 3) | 4, ((bestBin & 31) << 3) | 4];
  } else if (n > 0) {
    rgb = [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
  } else {
    rgb = [128, 128, 128];
  }
  const hex = "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
  // Rec. 709 relative luminance, thresholded at 0.55 rather than 0.5: a foot
  // band is small type on a saturated ground, where black-on-mid reads better.
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return { rgb, hex, text: lum > 0.55 ? "#000000" : "#ffffff" };
}

/** Mean chroma, 0..1. The R-09 regression detector. */
export function measureChroma(rgb3: Uint8Array | Buffer): number {
  let sum = 0, n = 0;
  for (let i = 0; i + 2 < rgb3.length; i += 3) {
    const mx = Math.max(rgb3[i]!, rgb3[i + 1]!, rgb3[i + 2]!);
    const mn = Math.min(rgb3[i]!, rgb3[i + 1]!, rgb3[i + 2]!);
    sum += (mx - mn) / 255;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

interface Region { left: number; top: number; width: number; height: number }

/** The sliver's box in a raster's own pixels, centred horizontally. */
function sliverBox(width: number, height: number, top: number): Region {
  const w = Math.max(1, Math.min(width, Math.round(width * SLIVER_FRACTION)));
  const h = Math.max(1, Math.min(height, Math.round(w * (SPINE_H / SPINE_W))));
  return {
    left: Math.max(0, Math.round((width - w) / 2)),
    top: Math.max(0, Math.min(height - h, Math.round(top))),
    width: w,
    height: h,
  };
}

/**
 * Cut a spine from a chapter's pages.
 *
 * Returns null when nothing in the chapter could be decoded. That is a real
 * outcome, not an error: `ui.md` says pencil states carry no artwork, so a
 * chapter with no usable page is drawn without a face and nothing is invented
 * to fill the gap.
 */
export async function extractSpine(pagePaths: string[]): Promise<SpineResult | null> {
  let best: { page: string; atFraction: number; band: BandScore } | null = null;

  // --- pass 1: saliency, on the downscaled proxy
  for (const page of candidatePages(pagePaths)) {
    const p = await proxy(page);
    if (!p) continue;
    const maps = buildMaps(p);
    const bandH = Math.max(
      1,
      Math.min(p.height, Math.round(p.width * SLIVER_FRACTION * (SPINE_H / SPINE_W))),
    );
    // Half-band steps, so a good crop straddling a boundary is still findable.
    // The pixels are already in cache, so the second pass is nearly free.
    for (const band of bandScores(maps, bandH, Math.max(1, Math.round(bandH / 2)))) {
      if (!best || band.reranked > best.band.reranked) {
        best = { page, atFraction: band.top / p.height, band };
      }
    }
  }
  if (!best) return null;

  // --- pass 2: cut from the original, at full resolution
  try {
    const src = sharp(best.page, { limitInputPixels: false, sequentialRead: true });
    const meta = await src.metadata();
    const w = meta.width ?? 0, h = meta.height ?? 0;
    if (w < 4 || h < 4) return null;
    const box = sliverBox(w, h, best.atFraction * h);

    // One native decode of the sliver, reused for both artefacts: the tint is
    // measured from these pixels and the WebP is encoded from them.
    const { data: sliver, info } = await sharp(best.page, { limitInputPixels: false, sequentialRead: true })
      .extract(box)
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const tint = dominantOf(sliver);
    const sourceChroma = measureChroma(sliver);

    // AVIF at effort 0, quality 35. Measured on 25 real spines at this
    // geometry: 2.73 KB in 27 ms, against WebP q72's 4.55 KB in 23 ms. Effort 2
    // takes another 13% off for double the CPU and is deliberately not taken on
    // a box that also serves pages. Quality 35 rather than 45 because the art
    // lands at 44 px wide at most -- detail below that is spent on nobody.
    // Support is universal on anything that can run the client (Safari 16.4+,
    // Chrome 85+, Firefox 93+).
    const encoded = await sharp(sliver, {
      raw: { width: info.width, height: info.height, channels: 3 },
    })
      .resize({ width: SPINE_W, height: SPINE_H, fit: "cover" })
      .avif({ quality: 35, effort: 0 })
      .toBuffer();

    // Decode what we are about to store and compare chroma against the source.
    // R-09's desaturation defect was never resolved, so the pipeline measures
    // itself rather than trusting that this time the defaults were right.
    const back = await sharp(encoded).toColourspace("srgb").removeAlpha().raw().toBuffer();
    const outputChroma = measureChroma(back);

    return {
      image: new Uint8Array(encoded),
      tint,
      diag: {
        page: best.page,
        at: best.atFraction,
        score: best.band.score,
        reranked: best.band.reranked,
        balloon: best.band.balloon,
        sourceChroma,
        outputChroma,
      },
    };
  } catch {
    return null;
  }
}

/**
 * The key a spine is stored and served under.
 *
 * `fingerprint` is the chapter's own content hash from `paperbox.json`, so a
 * re-pull that replaces every page moves the key and the old sliver becomes
 * unreachable in the same instant. A chapter with no fingerprint yet keys on
 * the empty string, which is stable and simply means its spine is regenerated
 * once the fingerprint arrives.
 */
export function spineKey(chapterUid: string, fingerprint: string | undefined): string {
  return artKey("spine", chapterUid, fingerprint);
}

export interface SpineWriteResult {
  key: string;
  art: StoredArt | null;
  tint: Tint | null;
  diag: SpineDiagnostics | null;
  /** True when the store already held it and nothing was decoded. */
  cached: boolean;
  /** Extraction was attempted and produced nothing. Recorded; see `miss`. */
  missed?: boolean;
}

/** Generate and store one chapter's spine, unless the store already has it. */
export async function ensureSpine(
  chapterUid: string,
  fingerprint: string | undefined,
  pagePaths: string[],
): Promise<SpineWriteResult> {
  const key = spineKey(chapterUid, fingerprint);
  if (await has("spine", key)) {
    return { key, art: null, tint: null, diag: null, cached: true };
  }
  const out = await extractSpine(pagePaths);
  if (!out) {
    // Record the absence, so the scan's discovery pass stops asking for a
    // chapter that cannot produce one. See `ArtKind` in `store.ts`: this is
    // read by discovery only, so the attempt above still happens on every art
    // job and a transient decode failure is not a permanent verdict.
    await put("miss", key, JSON.stringify({ at: new Date().toISOString(), pages: pagePaths.length }));
    return { key, art: null, tint: null, diag: null, cached: false, missed: true };
  }
  const art = await put("spine", key, out.image);
  // The tint is written *after* the picture. If the process dies between the
  // two, the next request finds a spine with no tint, regenerates, and writes
  // both -- whereas the other order would leave a tint pointing at artwork that
  // was never produced.
  await put("tint", key, JSON.stringify(out.tint));
  return { key, art, tint: out.tint, diag: out.diag, cached: false };
}
