import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, rename } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = await mkdtemp(join(tmpdir(), "paperbox-durability-"));
process.env.MANGA_DIR = ROOT;
const scanner = await import("./index");
const { loadMeta, saveMeta, withSeriesLock, CorruptMetaError } = await import("../metadata");

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function makeChapter(series: string, chapter: string, pages = 2) {
  const dir = join(ROOT, series, chapter);
  await mkdir(dir, { recursive: true });
  for (let i = 1; i <= pages; i++) {
    await writeFile(join(dir, `${String(i).padStart(3, "0")}.png`), PIXEL);
  }
}

const sidecar = (s: string) => join(ROOT, s, "paperbox.json");
const read = async (s: string) => JSON.parse(await readFile(sidecar(s), "utf-8"));

beforeAll(async () => {
  await makeChapter("Durable", "Chapter 001");
  await makeChapter("Durable", "Chapter 002");
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("a damaged sidecar is never silently rebuilt", () => {
  test("a truncated sidecar is set aside, not overwritten with re-derived identity", async () => {
    await scanner.scan();
    const before = await read("Durable");
    const pinnedUid = before.chapters["Chapter 001"].uid ?? "derived";
    const pinnedApiId = before.chapters["Chapter 001"].apiId;

    // Truncate it, the way a crash mid-write would.
    const raw = await readFile(sidecar("Durable"), "utf-8");
    await writeFile(sidecar("Durable"), raw.slice(0, raw.length - 30));

    // A damaged file used to be indistinguishable from an absent one: the scan
    // treated the series as new, re-derived every id, and saved over the only
    // copy. It must refuse instead.
    await expect(loadMeta(join(ROOT, "Durable"))).rejects.toThrow(CorruptMetaError);

    // ...and the damaged bytes are preserved for recovery, under a new name.
    const aside = (await readdir(join(ROOT, "Durable"))).filter((f) => f.includes(".corrupt-"));
    expect(aside.length).toBe(1);

    // Restore so later tests have a sidecar again.
    await rename(join(ROOT, "Durable", aside[0]!), sidecar("Durable"));
    await writeFile(sidecar("Durable"), raw);
    const after = await read("Durable");
    expect(after.chapters["Chapter 001"].apiId).toBe(pinnedApiId);
    expect(after.chapters["Chapter 001"].uid ?? "derived").toBe(pinnedUid);
  });

  test("a missing sidecar is still the ordinary case and starts fresh", async () => {
    const { existed } = await loadMeta(join(ROOT, "does-not-exist"));
    expect(existed).toBe(false);
  });
});

describe("identity survives a scan landing mid-commit", () => {
  test("a chapter being swapped in is not deleted as a ghost", async () => {
    await scanner.scan();
    const meta = await read("Durable");
    meta.chapters["Chapter 002"].sortKey = 900;
    meta.chapters["Chapter 002"].uid = "PINNED-MIDCOMMIT";
    meta.chapters["Chapter 002"].apiId = 424242;
    await writeFile(sidecar("Durable"), JSON.stringify(meta, null, 2));

    // Reproduce commitChapter's window: the live directory is renamed aside to a
    // dot-prefixed name, which is invisible to the scanner. A scan here used to
    // delete the metadata entry outright, destroying uid, apiId and sortKey --
    // and processQueue drives a scan after every download.
    const live = join(ROOT, "Durable", "Chapter 002");
    const aside = join(ROOT, "Durable", ".replaced-Chapter 002");
    await rename(live, aside);
    try {
      await scanner.scan();
      const during = await read("Durable");
      expect(during.chapters["Chapter 002"]).toBeDefined();
      expect(during.chapters["Chapter 002"].uid).toBe("PINNED-MIDCOMMIT");
      expect(during.chapters["Chapter 002"].apiId).toBe(424242);
      expect(during.chapters["Chapter 002"].sortKey).toBe(900);
    } finally {
      await rename(aside, live);
    }
  });

  test("a genuinely removed chapter is still cleaned up", async () => {
    await makeChapter("Durable", "Chapter 003");
    await scanner.scan();
    expect((await read("Durable")).chapters["Chapter 003"]).toBeDefined();

    await rm(join(ROOT, "Durable", "Chapter 003"), { recursive: true, force: true });
    await scanner.scan();
    expect((await read("Durable")).chapters["Chapter 003"]).toBeUndefined();
  });
});

describe("concurrent writers do not lose each other's work", () => {
  test("three concurrent read-modify-write cycles all land", async () => {
    const dir = join(ROOT, "Durable");
    await scanner.scan();

    // Unserialised, each writer saves a whole sidecar it read before the others
    // wrote, so the last one wins and the rest vanish silently.
    await Promise.all(
      ["a", "b", "c"].map((tag) =>
        withSeriesLock(dir, async () => {
          const { meta } = await loadMeta(dir);
          (meta as any).tags = [...((meta as any).tags ?? []), tag];
          await saveMeta(dir, meta);
        }),
      ),
    );

    const after = await read("Durable");
    expect([...after.tags].sort()).toEqual(["a", "b", "c"]);
  });

  test("saveMeta does not collide on a shared temp filename", async () => {
    const dir = join(ROOT, "Durable");
    const { meta } = await loadMeta(dir);
    // A fixed `${target}.tmp` made the loser's rename fail with ENOENT after the
    // winner had already moved it.
    await Promise.all(Array.from({ length: 5 }, () => saveMeta(dir, meta)));
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
