import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = await mkdtemp(join(tmpdir(), "paperbox-images-"));
process.env.MANGA_DIR = ROOT;
await import("../scanner");
const { imageRoutes } = await import("./images");

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// A space in the name, so the encoded and raw spellings both get exercised.
const SERIES = "Nano Machine";
const CHAPTER = "Chapter 001";

/** Sidecars that live beside the pages and are not anyone's business. */
const SIDECARS = ["paperbox.json", "manga.json", "source-info.json"];

function get(path: string) {
  return imageRoutes.handle(new Request(`http://localhost/api/images/${path}`));
}

beforeAll(async () => {
  await mkdir(join(ROOT, SERIES, CHAPTER), { recursive: true });
  await writeFile(join(ROOT, SERIES, "cover.png"), PIXEL);
  await writeFile(join(ROOT, SERIES, CHAPTER, "001.png"), PIXEL);
  for (const f of SIDECARS) {
    await writeFile(join(ROOT, SERIES, f), JSON.stringify({ uid: "psecret", apiId: 42 }));
  }
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("/api/images/* serves images and nothing else", () => {
  test("an image is served, cached", async () => {
    const res = await get(`${encodeURIComponent(SERIES)}/cover.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect((await res.arrayBuffer()).byteLength).toBe(PIXEL.byteLength);
  });

  test("a page inside a chapter is served", async () => {
    const res = await get(
      `${encodeURIComponent(SERIES)}/${encodeURIComponent(CHAPTER)}/001.png`,
    );
    expect(res.status).toBe(200);
  });

  test("the metadata sidecars are not", async () => {
    for (const f of SIDECARS) {
      // Containment kept the read inside the library but said nothing about
      // what was read, so paperbox.json -- uids, pinned api ids, per-chapter
      // provenance -- came back 200 with a day of public caching on it.
      const res = await get(`${encodeURIComponent(SERIES)}/${f}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).not.toBe("public, max-age=86400");
      expect(await res.text()).not.toContain("psecret");
    }
  });

  test("the extension check survives percent-encoding", async () => {
    // `.json` spelled `%2ejson` decodes to the same file; the check runs on the
    // decoded path for that reason.
    const res = await get(`${encodeURIComponent(SERIES)}/paperbox%2Ejson`);
    expect(res.status).toBe(404);
  });

  test("a path that escapes the library is still refused", async () => {
    const res = await get("..%2f..%2fetc%2fpasswd");
    expect(res.status).toBe(404);
  });
});
