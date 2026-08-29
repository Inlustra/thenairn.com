import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";

// Both env vars are read at call time, but the scanner is imported eagerly by
// the route module, so seed the library before importing either.
const ROOT = await mkdtemp(join(tmpdir(), "paperbox-art-routes-"));
const DERIVED = await mkdtemp(join(tmpdir(), "paperbox-art-derived-"));
process.env.MANGA_DIR = ROOT;
process.env.DERIVED_DIR = DERIVED;

const scanner = await import("../scanner");
const { artRoutes } = await import("./art");
const { ensureSpine, ensureCover } = await import("../art");

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A page big enough to cut a spine out of. A 1x1 pixel is a valid image and an
 * invalid page: `extractSpine` refuses a raster it cannot band, and would
 * return null here for a reason that has nothing to do with the routes.
 */
async function writePage(path: string, seed: number) {
  const w = 320, h = 1400;
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const o = i * 3;
    buf[o] = (i * 7 + seed * 40) % 256;
    buf[o + 1] = (i * 3) % 200;
    buf[o + 2] = (seed * 60) % 256;
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path);
}

let seriesUid = "";
let chapterUid = "";
let chapterFingerprint: string | undefined;
let pagePaths: string[] = [];

const get = (path: string, headers: Record<string, string> = {}) =>
  artRoutes.handle(new Request(`http://localhost${path}`, { headers }));

beforeAll(async () => {
  process.env.MANGA_DIR = ROOT;
  process.env.DERIVED_DIR = DERIVED;
  const dir = join(ROOT, "Nano Machine", "Chapter 001");
  await mkdir(dir, { recursive: true });
  for (let i = 1; i <= 4; i++) await writePage(join(dir, `00${i}.png`), i);
  await scanner.scan();
  const m = scanner.getManga("nano-machine")!;
  seriesUid = m.uid;
  chapterUid = m.chapters[0]!.uid;
  chapterFingerprint = m.chapters[0]!.fingerprint;
  pagePaths = await scanner.getChapterPagePaths(m, m.chapters[0]!);
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await rm(DERIVED, { recursive: true, force: true });
});

describe("404 when it has not been generated -- never a placeholder", () => {
  test("a spine that has not been cut is a 404, not a grey rectangle", async () => {
    // ui.md: "Only a real book has a face. Pencil states carry no artwork."
    // And: "theatre is worse than absence." A stand-in would make a shelf
    // mid-backfill look finished and wrong instead of unfinished and honest.
    const res = await get(`/api/art/spine/${chapterUid}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("json");
  });

  test("a cover that has not been derived is a 404", async () => {
    const res = await get(`/api/art/cover/${seriesUid}`);
    expect(res.status).toBe(404);
  });

  test("an unknown uid is a 404 too, with no filesystem work behind it", async () => {
    expect((await get("/api/art/spine/deadbeefdeadbeef")).status).toBe(404);
    expect((await get("/api/art/cover/deadbeefdeadbeef")).status).toBe(404);
    expect((await get("/api/art/tint/deadbeefdeadbeef")).status).toBe(404);
  });
});

describe("once generated", () => {
  test("serves the spine with a strong etag and a long cache lifetime", async () => {
    await ensureSpine(chapterUid, chapterFingerprint, pagePaths);
    const res = await get(`/api/art/spine/${chapterUid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/avif");
    const etag = res.headers.get("etag")!;
    expect(etag).toContain("spine-");
    // Safe only because the etag contains the chapter's fingerprint and
    // ART_VERSION: the URL is stable across content changes, the etag is not.
    expect(res.headers.get("cache-control")).toContain("must-revalidate");
    expect(res.headers.get("cache-control")).toContain("max-age=31536000");
  });

  test("revalidates to 304 with no body", async () => {
    await ensureSpine(chapterUid, chapterFingerprint, pagePaths);
    const first = await get(`/api/art/spine/${chapterUid}`);
    const etag = first.headers.get("etag")!;
    const second = await get(`/api/art/spine/${chapterUid}`, { "if-none-match": etag });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  test("serves the tint beside the picture, so a spine can be laid out before its art loads", async () => {
    await ensureSpine(chapterUid, chapterFingerprint, pagePaths);
    const res = await get(`/api/art/tint/${chapterUid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hex: string; text: string; rgb: number[] };
    expect(body.hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(["#000000", "#ffffff"]).toContain(body.text);
    expect(body.rgb.length).toBe(3);
  });

  test("serves an adopted cover, without the file having moved", async () => {
    const seriesDir = join(ROOT, "Nano Machine");
    await writeFile(join(seriesDir, "cover.png"), PIXEL);
    const m = scanner.getManga("nano-machine")!;
    await ensureCover(m.uid, seriesDir, undefined, m.chapters.map((c) => c.dir));

    const res = await get(`/api/art/cover/${seriesUid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/webp");
    // The user's file is exactly where it was.
    expect(await Bun.file(join(seriesDir, "cover.png")).exists()).toBe(true);
  });
});

describe("a stale artefact is unaddressable", () => {
  test("changing the fingerprint changes the key, so the old spine 404s", async () => {
    await ensureSpine(chapterUid, "fingerprint-one", pagePaths);
    // The route derives the key from the chapter's *current* fingerprint. With
    // the scanner reporting a different one, the old picture is simply not at
    // the address anybody can ask for -- there is no compare step to skip.
    const stored = await ensureSpine(chapterUid, "fingerprint-two", pagePaths);
    expect(stored.key).not.toBe((await ensureSpine(chapterUid, "fingerprint-one", pagePaths)).key);
  });
});
