import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// MANGA_DIR is read once at module load, so it must be set before the import.
const ROOT = await mkdtemp(join(tmpdir(), "paperbox-chapterkey-"));
process.env.MANGA_DIR = ROOT;
const scanner = await import("./index");

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

const sidecar = (series: string) => join(ROOT, series, "paperbox.json");
const readSidecar = async (series: string) =>
  JSON.parse(await readFile(sidecar(series), "utf-8"));

beforeAll(async () => {
  await makeChapter("The Greatest Estate Developer", "Episode 001");
  await makeChapter("The Greatest Estate Developer", "Spin-off #001");
  await makeChapter("Warhammer 40,000_ Exterminatus", "Warhammer 40,000_ Exterminatus Issue #1");
  await makeChapter("Warhammer 40,000_ Exterminatus", "Warhammer 40,000_ Exterminatus Issue #2");
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("chapter keys are stored, not derived on read", () => {
  test("a scan persists label, sortKey and sequence into the sidecar", async () => {
    await scanner.scan();
    const meta = await readSidecar("The Greatest Estate Developer");
    const ep = meta.chapters["Episode 001"];
    const spin = meta.chapters["Spin-off #001"];

    expect(ep.label).toBe("Episode 001");
    expect(ep.sortKey).toBe(1);
    expect(ep.sequence).toBe("main");
    expect(spin.sortKey).toBe(1);
    expect(spin.sequence).toBe("spin-off");
    expect(meta.schemaVersion).toBe(2);
  });

  test("the series title is stripped, so the issues do not all key to 40", async () => {
    await scanner.scan();
    const meta = await readSidecar("Warhammer 40,000_ Exterminatus");
    const keys = Object.values(meta.chapters as Record<string, any>)
      .map((c) => c.sortKey)
      .sort();
    expect(keys).toEqual([1, 2]);
  });

  test("a stored key is NOT re-derived on a later scan", async () => {
    // This is the property the whole schema exists for. Someone has corrected
    // this chapter's key by hand (or a future parser would derive it
    // differently); a rescan must leave it exactly as stored, because silently
    // re-keying invalidates every client's held state with no migration.
    await scanner.scan();
    const meta = await readSidecar("The Greatest Estate Developer");
    meta.chapters["Episode 001"].sortKey = 900;
    meta.chapters["Episode 001"].mark = "900";
    await writeFile(sidecar("The Greatest Estate Developer"), JSON.stringify(meta, null, 2));

    await scanner.scan();

    const after = await readSidecar("The Greatest Estate Developer");
    expect(after.chapters["Episode 001"].sortKey).toBe(900);
    expect(after.chapters["Episode 001"].mark).toBe("900");
  });

  test("a stored key survives the chapter's pages changing", async () => {
    await scanner.scan();
    const before = (await readSidecar("The Greatest Estate Developer")).chapters["Spin-off #001"];

    // Pages moving is not a reason to re-key a chapter.
    await writeFile(join(ROOT, "The Greatest Estate Developer", "Spin-off #001", "003.png"), PIXEL);
    await scanner.scan();

    const after = (await readSidecar("The Greatest Estate Developer")).chapters["Spin-off #001"];
    expect(after.sortKey).toBe(before.sortKey);
    expect(after.sequence).toBe(before.sequence);
    expect(after.pages).toBe(3); // the page count did update
  });

  test("migrating a v1 sidecar fills the new fields without changing identity", async () => {
    await scanner.scan();
    const meta = await readSidecar("Warhammer 40,000_ Exterminatus");
    const dir = "Warhammer 40,000_ Exterminatus Issue #1";
    const pinnedUid = meta.chapters[dir].uid;
    const pinnedApiId = meta.chapters[dir].apiId;

    // Rewind to a v1-shaped sidecar: no label/sortKey/sequence anywhere.
    meta.schemaVersion = 1;
    for (const c of Object.values(meta.chapters as Record<string, any>)) {
      delete c.label;
      delete c.sortKey;
      delete c.sortKeyEnd;
      delete c.sequence;
      delete c.mark;
    }
    await writeFile(sidecar("Warhammer 40,000_ Exterminatus"), JSON.stringify(meta, null, 2));

    await scanner.scan();

    const after = await readSidecar("Warhammer 40,000_ Exterminatus");
    expect(after.chapters[dir].sortKey).toBe(1);
    expect(after.chapters[dir].sequence).toBe("main");
    // Identity must not move during a schema migration.
    expect(after.chapters[dir].uid).toBe(pinnedUid);
    expect(after.chapters[dir].apiId).toBe(pinnedApiId);
    // The stored version must advance too. Without this the sidecar keeps its
    // old number forever and nothing can tell a migrated file from a stale one
    // -- which is exactly what the real library did on the first deploy.
    expect(after.schemaVersion).toBe(2);
  });
});
