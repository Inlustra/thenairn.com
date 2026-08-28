/**
 * The download path must not write a cover into the user's library.
 *
 * `saveMetadata` used to `Bun.write(join(seriesDir, "cover.webp"), ...)`, which
 * put a generated file in a directory `ui.md` promises is never written to:
 * *"The files belong to the user. Never moved, never renamed, never rewritten,
 * never auto-deleted."*
 *
 * Both assertions below were seen to FAIL against the previous implementation
 * (`cover.jpg` present in the series directory, nothing in the derived store)
 * before the fix was written.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, readdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { saveMetadata } from "./manager";
import { coverKey, artPath } from "../art";
import { pathUid } from "../ids";

let library: string;
let derived: string;
let prevManga: string | undefined;
let prevDerived: string | undefined;
const realFetch = globalThis.fetch;

/** A 1x1 PNG, so `sharp` has something real to normalise. */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeEach(async () => {
  library = await mkdtemp(join(tmpdir(), "pb-lib-"));
  derived = await mkdtemp(join(tmpdir(), "pb-derived-"));
  prevManga = process.env.MANGA_DIR;
  prevDerived = process.env.DERIVED_DIR;
  process.env.MANGA_DIR = library;
  process.env.DERIVED_DIR = derived;
  globalThis.fetch = (async () =>
    new Response(PNG_1x1, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (prevManga === undefined) delete process.env.MANGA_DIR;
  else process.env.MANGA_DIR = prevManga;
  if (prevDerived === undefined) delete process.env.DERIVED_DIR;
  else process.env.DERIVED_DIR = prevDerived;
  await rm(library, { recursive: true, force: true });
  await rm(derived, { recursive: true, force: true });
});

describe("saveMetadata and the ownership promise", () => {
  it("writes no cover file into the series directory", async () => {
    const dir = join(library, "Some Series");
    await mkdir(dir, { recursive: true });

    await saveMetadata(dir, { coverLink: "https://example.invalid/cover.png" } as never, "Some Series", "https://example.invalid/series");

    const names = await readdir(dir);
    const covers = names.filter((n) => /^cover\./i.test(n));
    expect(covers).toEqual([]);
  });

  it("puts the cover in the derived store instead, keyed on the source url", async () => {
    const dir = join(library, "Some Series");
    await mkdir(dir, { recursive: true });
    const url = "https://example.invalid/cover.png";

    const result = await saveMetadata(dir, { coverLink: url } as never, "Some Series", "https://example.invalid/series");

    expect(result.coverSaved).toBe(true);
    const uid = pathUid("Some Series");
    const stored = Bun.file(artPath("cover", coverKey(uid, `url:${url}`)));
    expect(await stored.exists()).toBe(true);
  });

  it("leaves a cover the user already had byte-for-byte untouched", async () => {
    // Adoption, not migration: an existing cover is input to the pipeline and
    // is never moved, rewritten or deleted. Whether the old files should
    // eventually be removed is the owner's call -- see docs/decisions.md.
    //
    // This is the sharper half of the bug. The old code derived the filename
    // from the *remote* url's extension, so fetching a new `.png` cover wrote
    // straight over a `cover.png` the user had put there themselves -- not a
    // stray generated file beside theirs, but their file replaced, silently,
    // with no backup and no record. Byte equality is the assertion that says so.
    const dir = join(library, "Adopted");
    await mkdir(dir, { recursive: true });
    const mine = Buffer.concat([PNG_1x1, Buffer.from("USER-OWNED")]);
    await writeFile(join(dir, "cover.png"), mine);

    await saveMetadata(dir, { coverLink: "https://example.invalid/new.png" } as never, "Adopted", "https://example.invalid/s");

    const after = Buffer.from(await Bun.file(join(dir, "cover.png")).arrayBuffer());
    expect(after.equals(mine)).toBe(true);
  });
});
