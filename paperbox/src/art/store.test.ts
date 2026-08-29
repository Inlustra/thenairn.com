import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtemp, rm, readdir, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { artKey, artPath, find, has, put, readJson, derivedDir } from "./store";
import { ART_VERSION } from "./version";

let ROOT: string;
let prev: string | undefined;

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "paperbox-derived-"));
  prev = process.env.DERIVED_DIR;
  process.env.DERIVED_DIR = ROOT;
});

afterAll(async () => {
  if (prev === undefined) delete process.env.DERIVED_DIR;
  else process.env.DERIVED_DIR = prev;
  await rm(ROOT, { recursive: true, force: true });
});

describe("the key is the invalidation rule", () => {
  test("a moved fingerprint moves the key, so the old artefact is unaddressable", () => {
    const before = artKey("spine", "chapter-uid", "fp-aaaa");
    const after = artKey("spine", "chapter-uid", "fp-bbbb");
    expect(before).not.toBe(after);
  });

  test("the same inputs give the same key on any machine, with no state anywhere", () => {
    expect(artKey("spine", "u", "f")).toBe(artKey("spine", "u", "f"));
  });

  test("kind is part of the key, so a cover and a spine cannot collide", () => {
    expect(artKey("spine", "x", "y")).not.toBe(artKey("cover", "x", "y"));
  });

  test("ART_VERSION is in the key, so bumping it invalidates everything at once", () => {
    // Asserted by construction rather than by mutating the constant: the key
    // must contain the version string, or a new extraction algorithm would
    // serve old pictures.
    const key = artKey("spine", "u", "f");
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(`v${ART_VERSION}`);
    hasher.update(" ");
    hasher.update("spine");
    hasher.update(" ");
    hasher.update("u");
    hasher.update(" ");
    hasher.update("f");
    expect(key).toBe(hasher.digest("hex").slice(0, 24));
  });

  test("an undefined input is distinct from an empty one only in what it means, not in the key", () => {
    // A chapter with no fingerprint yet keys stably rather than throwing; it is
    // simply regenerated once the fingerprint arrives, at a different key.
    expect(artKey("spine", "u", undefined)).toBe(artKey("spine", "u", ""));
  });
});

describe("the store", () => {
  beforeEach(async () => {
    await rm(join(ROOT, "spine"), { recursive: true, force: true });
    await rm(join(ROOT, "tint"), { recursive: true, force: true });
  });

  test("lives entirely under DERIVED_DIR and nowhere else", () => {
    expect(derivedDir()).toBe(ROOT);
    expect(artPath("spine", "abcdef0123456789abcdef01").startsWith(ROOT + "/")).toBe(true);
  });

  test("fans the key out two levels, so no directory holds the whole library", () => {
    const key = "abcdef0123456789abcdef01";
    expect(artPath("spine", key)).toBe(join(ROOT, "spine", "ab", "cd", `${key}.avif`));
  });

  test("put then find round-trips, and the etag is the key", async () => {
    const key = artKey("spine", "c1", "fp1");
    const written = await put("spine", key, new Uint8Array([1, 2, 3, 4]));
    expect(written.size).toBe(4);
    const found = await find("spine", key);
    expect(found?.etag).toBe(`"spine-${key}"`);
    expect(found?.size).toBe(4);
  });

  test("find returns null for a key nothing was written under -- never a placeholder", async () => {
    expect(await find("spine", artKey("spine", "never", "written"))).toBeNull();
    expect(await has("spine", artKey("spine", "never", "written"))).toBe(false);
  });

  test("a zero-length file is treated as absent, not as an artefact", async () => {
    const key = artKey("spine", "torn", "fp");
    const p = artPath("spine", key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, "");
    expect(await find("spine", key)).toBeNull();
  });

  test("writing the same key twice is idempotent and leaves no temporary files", async () => {
    const key = artKey("spine", "c2", "fp2");
    await Promise.all([
      put("spine", key, new Uint8Array([9])),
      put("spine", key, new Uint8Array([9])),
    ]);
    const leaf = dirname(artPath("spine", key));
    const names = await readdir(leaf);
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(names).toEqual([`${key}.avif`]);
  });

  test("json artefacts round-trip, and a missing one reads as null", async () => {
    const key = artKey("tint", "c3", "fp3");
    await put("tint", key, JSON.stringify({ hex: "#112233" }));
    expect(await readJson<{ hex: string }>("tint", key)).toEqual({ hex: "#112233" });
    expect(await readJson("tint", artKey("tint", "nope", "nope"))).toBeNull();
  });

  test("deleting the whole store is safe: everything is simply absent again", async () => {
    const key = artKey("spine", "c4", "fp4");
    await put("spine", key, new Uint8Array([1]));
    expect(await has("spine", key)).toBe(true);
    await rm(ROOT, { recursive: true, force: true });
    expect(await has("spine", key)).toBe(false);
    // ...and the store rebuilds its own directories on the next write.
    await put("spine", key, new Uint8Array([1]));
    expect(await has("spine", key)).toBe(true);
  });
});
