import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importLibrary, importSeries } from "./import";
import { pathUid } from "../ids";

const ROOT = await mkdtemp(join(tmpdir(), "paperbox-readstate-import-"));

/** The real library. Read-only, always: it is the user's comics. */
const REAL_LIBRARY = "/mnt/user/Media/Manga-new";

function sidecar(chapters: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ schemaVersion: 2, chapters, ...extra }, null, 2);
}

/**
 * Every file under `dir`, with the four things a write would disturb.
 *
 * `maxDepth` exists for the real library: a full walk there is ~57,000 stats
 * over FUSE, and the importer only ever opens files two levels down, so two
 * levels is what needs proving untouched.
 */
async function snapshot(dir: string, maxDepth = Infinity): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, prefix: string, depth: number) {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(p, `${prefix}${e.name}/`, depth + 1);
        else out.push(`${prefix}${e.name}/`);
      } else {
        const st = await stat(p);
        out.push(`${prefix}${e.name} ${st.size} ${st.mtimeMs} ${st.ino}`);
      }
    }
  }
  await walk(dir, "", 1);
  return out;
}

beforeAll(async () => {
  await mkdir(join(ROOT, "Nano Machine"), { recursive: true });
  await writeFile(
    join(ROOT, "Nano Machine", "paperbox.json"),
    sidecar(
      {
        "Chapter 001": { dir: "Chapter 001", number: 1, label: "Chapter 001", sortKey: 1, sequence: "main", pages: 40 },
        "Chapter 002": { dir: "Chapter 002", number: 2, label: "Chapter 002", sortKey: 2, sequence: "main", pages: 38, uid: "pinned-two" },
      },
      { title: "Nano Machine" },
    ),
  );

  // Pre-v2: no sortKey, only the legacy `number`.
  await mkdir(join(ROOT, "Legacy"), { recursive: true });
  await writeFile(
    join(ROOT, "Legacy", "paperbox.json"),
    sidecar({ "Ch 7": { dir: "Ch 7", number: 7, pages: 20 } }),
  );

  await mkdir(join(ROOT, "No Sidecar", "Chapter 001"), { recursive: true });
  await mkdir(join(ROOT, "Damaged"), { recursive: true });
  await writeFile(join(ROOT, "Damaged", "paperbox.json"), "{ this is not json");
  await mkdir(join(ROOT, ".hidden"), { recursive: true });
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("importLibrary", () => {
  test("enumerates chapters from paperbox.json alone", async () => {
    const { series } = await importLibrary(ROOT);
    const nano = series.find((s) => s.dir === "Nano Machine")!;
    expect(nano.uid).toBe(pathUid("Nano Machine"));
    expect(nano.chapters).toHaveLength(2);
    expect(nano.chapters.map((c) => c.uid).sort()).toEqual(
      [pathUid("Nano Machine", "Chapter 001"), "pinned-two"].sort(),
    );
  });

  test("a pre-v2 sidecar falls back to the legacy number rather than re-deriving a key", async () => {
    const legacy = (await importSeries(ROOT, "Legacy"))!;
    expect(legacy.chapters[0]!.sortKey).toBe(7);
    expect(legacy.chapters[0]!.sequence).toBe("main");
  });

  test("series without a readable sidecar are reported, not repaired", async () => {
    const { skipped } = await importLibrary(ROOT);
    expect(skipped.map((s) => s.dir).sort()).toEqual(["Damaged", "No Sidecar"]);
  });

  test("hidden directories are not series", async () => {
    const { series } = await importLibrary(ROOT);
    expect(series.map((s) => s.dir)).not.toContain(".hidden");
  });
});

describe("the importer never writes", () => {
  test("a full import leaves every file byte-identical, in place, untouched", async () => {
    const before = await snapshot(ROOT);
    await importLibrary(ROOT);
    await importLibrary(ROOT);
    expect(await snapshot(ROOT)).toEqual(before);
  });

  test("a damaged sidecar is left where it is, not set aside", async () => {
    // loadMeta() renames an unparseable sidecar to `.corrupt-<ts>`, which is
    // correct for the scanner and wrong for a reader that was asked to count
    // chapters. This is why the importer parses the file itself.
    await importLibrary(ROOT);
    const names = await readdir(join(ROOT, "Damaged"));
    expect(names).toEqual(["paperbox.json"]);
  });
});

describe("the real library is read-only", () => {
  const present = existsSync(REAL_LIBRARY);
  // Skipped anywhere the real library is not mounted, which is every machine
  // except this box. The assertion is worth having where it can run: this is
  // the user's comics, and a benchmark that reads them must leave no trace.
  test.if(present)(`${REAL_LIBRARY} is unchanged by an import`, async () => {
    const before = await snapshot(REAL_LIBRARY, 2).catch(() => null);
    if (!before) return;
    const { series } = await importLibrary(REAL_LIBRARY);
    expect(series.length).toBeGreaterThan(0);
    // Every sidecar still the same size, mtime and inode -- no rewrite, no
    // atomic-replace, no `.corrupt-` set-aside.
    expect(await snapshot(REAL_LIBRARY, 2)).toEqual(before);
  }, 30_000);
});
