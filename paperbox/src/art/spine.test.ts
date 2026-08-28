import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import { candidatePages, dominantOf, measureChroma, extractSpine, ensureSpine, spineKey, SPINE_W, SPINE_H } from "./spine";
import { has, artKey } from "./store";

let ROOT: string;
let DERIVED: string;
let prevDerived: string | undefined;

/**
 * A page with a known structure: a wide flat-white band across the top third
 * (a speech balloon, as far as the scorer can tell) and saturated artwork
 * below it. The crop must land below the band.
 */
async function makePage(path: string, opts: { balloonTop: boolean } = { balloonTop: true }) {
  const w = 400, h = 2400;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const inBalloon = opts.balloonTop ? y < h / 3 : y >= (2 * h) / 3;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (inBalloon) {
        buf[i] = 252; buf[i + 1] = 251; buf[i + 2] = 250;
      } else {
        // Saturated, and textured so the detail map is not flat.
        buf[i] = 210 + ((x + y) % 6);
        buf[i + 1] = 40 + ((x * 3) % 20);
        buf[i + 2] = 30;
      }
    }
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path);
}

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "paperbox-spine-"));
  DERIVED = await mkdtemp(join(tmpdir(), "paperbox-spine-derived-"));
  prevDerived = process.env.DERIVED_DIR;
  process.env.DERIVED_DIR = DERIVED;
  await mkdir(join(ROOT, "ch"), { recursive: true });
  for (const n of ["001", "002", "003", "004"]) {
    await makePage(join(ROOT, "ch", `${n}.png`));
  }
});

afterAll(async () => {
  if (prevDerived === undefined) delete process.env.DERIVED_DIR;
  else process.env.DERIVED_DIR = prevDerived;
  await rm(ROOT, { recursive: true, force: true });
  await rm(DERIVED, { recursive: true, force: true });
});

describe("candidate pages", () => {
  test("skips page 1, which is a title plate far more often than it is artwork", () => {
    const pages = ["001.jpg", "002.jpg", "003.jpg", "004.jpg", "005.jpg"];
    expect(candidatePages(pages)).not.toContain("001.jpg");
  });

  test("keeps page 1 when skipping it would leave nothing to choose between", () => {
    expect(candidatePages(["001.jpg"])).toEqual(["001.jpg"]);
    expect(candidatePages(["001.jpg", "002.jpg"])).toEqual(["001.jpg", "002.jpg"]);
  });

  test("looks inside the chapter, not only at its front", () => {
    const pages = Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(3, "0")}.jpg`);
    const picked = candidatePages(pages);
    expect(picked.length).toBe(3);
    // Spread across the body of the chapter rather than clustered at one end.
    const indices = picked.map((p) => pages.indexOf(p));
    expect(Math.max(...indices) - Math.min(...indices)).toBeGreaterThan(10);
  });

  test("is deterministic, so the same chapter always yields the same spine", () => {
    const pages = Array.from({ length: 17 }, (_, i) => `p${i}`);
    expect(candidatePages(pages)).toEqual(candidatePages(pages));
  });

  test("an empty chapter has no candidates rather than throwing", () => {
    expect(candidatePages([])).toEqual([]);
  });
});

describe("dominant colour -- the R-09 desaturation defect", () => {
  /**
   * The mechanism, isolated. `bench/spine-colour.ts` measures this on real
   * artwork and finds a mean-derived tint is 3.4x less chromatic than a
   * mode-derived one; this is the same fact as a unit test, so a future
   * refactor back to an average is caught here rather than by someone noticing
   * the shelf looks washed out.
   */
  test("a mode is far more chromatic than a mean over the same pixels", () => {
    // Half vivid red, half vivid green: the mean is a dull olive that appears
    // nowhere in the image; the mode is one of the two real colours.
    const n = 2000;
    const px = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      if (i % 2 === 0) { px[o] = 220; px[o + 1] = 30; px[o + 2] = 30; }
      else { px[o] = 30; px[o + 1] = 200; px[o + 2] = 40; }
    }
    const tint = dominantOf(px);
    const tintChroma = (Math.max(...tint.rgb) - Math.min(...tint.rgb)) / 255;

    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < n; i++) { sr += px[i * 3]!; sg += px[i * 3 + 1]!; sb += px[i * 3 + 2]!; }
    const mean = [sr / n, sg / n, sb / n];
    const meanChroma = (Math.max(...mean) - Math.min(...mean)) / 255;

    expect(tintChroma).toBeGreaterThan(meanChroma * 2);
  });

  test("ignores paper and ink, which are in every panel and are nobody's colour", () => {
    // 90% white, 10% blue. The blue is the chapter's colour.
    const n = 1000;
    const px = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      if (i % 10 === 0) { px[o] = 20; px[o + 1] = 60; px[o + 2] = 200; }
      else { px[o] = 250; px[o + 1] = 250; px[o + 2] = 250; }
    }
    expect(dominantOf(px).rgb[2]).toBeGreaterThan(dominantOf(px).rgb[0]);
  });

  test("falls back to a mean only when the sliver really is monochrome", () => {
    const px = new Uint8Array(300).fill(128);
    expect(dominantOf(px).rgb).toEqual([128, 128, 128]);
  });

  test("picks the numeral's colour by luminance, per ui.md", () => {
    const dark = new Uint8Array([10, 20, 90, 10, 20, 90, 10, 20, 90]);
    const light = new Uint8Array([250, 240, 90, 250, 240, 90, 250, 240, 90]);
    expect(dominantOf(dark).text).toBe("#ffffff");
    expect(dominantOf(light).text).toBe("#000000");
  });
});

describe("extraction", () => {
  test("cuts a spine of the declared geometry", async () => {
    const out = await extractSpine([
      join(ROOT, "ch", "001.png"),
      join(ROOT, "ch", "002.png"),
      join(ROOT, "ch", "003.png"),
      join(ROOT, "ch", "004.png"),
    ]);
    expect(out).not.toBeNull();
    const meta = await sharp(Buffer.from(out!.webp)).metadata();
    expect(meta.width).toBe(SPINE_W);
    expect(meta.height).toBe(SPINE_H);
    expect(meta.format).toBe("webp");
  });

  test("saliency pushes the crop off the balloon band", async () => {
    // The flat-white band occupies the top third. A fixed-position cut would
    // land in it; a scored one must not.
    const out = await extractSpine([join(ROOT, "ch", "002.png")]);
    expect(out).not.toBeNull();
    expect(out!.diag.at).toBeGreaterThan(0.3);
    expect(out!.diag.balloon).toBeLessThan(0.2);
  });

  test("the crop is not desaturated relative to its source", async () => {
    // R-09's open defect, asserted rather than hoped for. Anything materially
    // below 1.0 here is the defect returning.
    const out = await extractSpine([join(ROOT, "ch", "002.png")]);
    expect(out!.diag.sourceChroma).toBeGreaterThan(0.1);
    expect(out!.diag.outputChroma / out!.diag.sourceChroma).toBeGreaterThan(0.9);
  });

  test("returns null rather than inventing artwork when nothing decodes", async () => {
    // The library really does contain HTML error pages saved as `.jpg`.
    const bad = join(ROOT, "broken");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, "001.jpg"), "<!DOCTYPE html><html>429 Too Many Requests</html>");
    expect(await extractSpine([join(bad, "001.jpg")])).toBeNull();
  });

  test("is deterministic: the same chapter twice gives identical bytes", async () => {
    const pages = [join(ROOT, "ch", "002.png"), join(ROOT, "ch", "003.png")];
    const a = await extractSpine(pages);
    const b = await extractSpine(pages);
    expect(Buffer.from(a!.webp).equals(Buffer.from(b!.webp))).toBe(true);
  });
});

describe("ensureSpine", () => {
  test("writes the picture and its tint under the same key", async () => {
    const pages = [join(ROOT, "ch", "002.png")];
    const r = await ensureSpine("uid-1", "fp-1", pages);
    expect(r.cached).toBe(false);
    expect(r.key).toBe(spineKey("uid-1", "fp-1"));
    expect(await has("spine", r.key)).toBe(true);
    expect(await has("tint", r.key)).toBe(true);
  });

  test("is a no-op the second time -- the key already answers the question", async () => {
    const pages = [join(ROOT, "ch", "002.png")];
    await ensureSpine("uid-2", "fp-2", pages);
    const again = await ensureSpine("uid-2", "fp-2", pages);
    expect(again.cached).toBe(true);
  });

  test("a changed fingerprint is a different key, so the old spine cannot be served", async () => {
    const pages = [join(ROOT, "ch", "002.png")];
    const first = await ensureSpine("uid-3", "fp-a", pages);
    const stale = spineKey("uid-3", "fp-b");
    expect(await has("spine", stale)).toBe(false);
    expect(stale).not.toBe(first.key);
    // The old one is still on disk -- it is simply unreachable, which is the
    // property. Nothing has to remember to delete it for correctness.
    expect(await has("spine", first.key)).toBe(true);
  });

  test("a chapter with no decodable page stores nothing at all", async () => {
    const bad = join(ROOT, "broken2");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, "001.jpg"), "not an image");
    const r = await ensureSpine("uid-4", "fp-4", [join(bad, "001.jpg")]);
    expect(r.art).toBeNull();
    expect(await has("spine", artKey("spine", "uid-4", "fp-4"))).toBe(false);
  });
});

describe("measureChroma", () => {
  test("is zero for grey and high for a saturated colour", () => {
    expect(measureChroma(new Uint8Array([100, 100, 100]))).toBe(0);
    expect(measureChroma(new Uint8Array([255, 0, 0]))).toBe(1);
  });
});
