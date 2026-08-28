import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = await mkdtemp(join(tmpdir(), "paperbox-sync-"));
process.env.MANGA_DIR = ROOT;
const scanner = await import("./scanner");
const { diff, buildTree } = await import("./hashes");

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SERIES = "SSS-Class Suicide Hunter";

async function makeChapter(chapter: string, pages = 3, pad = 0) {
  const dir = join(ROOT, SERIES, chapter);
  await mkdir(dir, { recursive: true });
  for (let i = 1; i <= pages; i++) {
    // `pad` changes byte size, which is what the fingerprint keys on.
    await writeFile(join(dir, `${String(i).padStart(3, "0")}.png`), Buffer.concat([PIXEL, Buffer.alloc(pad)]));
  }
}

/** Everything the client would hold after a full sync. */
async function haveEverything() {
  const out: Array<{ id: string; hash: string }> = [];
  const walk = (n: any) => { out.push({ id: n.id, hash: n.hash }); n.children.forEach(walk); };
  walk(buildTree());
  return out;
}

beforeAll(async () => {
  for (const n of [1, 2, 30, 71]) await makeChapter(`Chapter ${String(n).padStart(3, "0")}`);
  await scanner.scan();
});

afterAll(async () => { await rm(ROOT, { recursive: true, force: true }); });

describe("sync diff", () => {
  test("a client holding nothing gets every image -- the new-download path", async () => {
    const r = await diff([], { resolve: "pages" });
    expect(r.images.length).toBe(4 * 3);
    expect(r.truncated).toBe(false);
    // Same call, no special casing: this is what a fresh download consumes.
    expect(r.images[0]!.url.startsWith("/api/images/")).toBe(true);
  });

  test("a client holding everything gets nothing", async () => {
    const r = await diff(await haveEverything(), { resolve: "pages" });
    expect(r.images).toEqual([]);
    expect(r.changed).toEqual([]);
    expect(r.gone).toEqual([]);
  });

  test("a re-pulled chapter resolves to its pages", async () => {
    const have = await haveEverything();
    // How the real pipeline replaces a chapter: stage, then swap the directory.
    // That changes the directory mtime, which is the invalidator.
    await rm(join(ROOT, SERIES, "Chapter 071"), { recursive: true });
    await makeChapter("Chapter 071", 3, 64);
    await scanner.scan();

    const r = await diff(have, { resolve: "pages" });
    expect(r.images.length).toBe(3);
    expect(r.images.every((i) => i.chapterId.startsWith("c:"))).toBe(true);
  });

  test("KNOWN GAP: an in-place overwrite of the same size is not detected", async () => {
    // Overwriting a file's contents does not change its directory's mtime, so
    // the cheap invalidator cannot see it -- rsync's default has the identical
    // hole. Only an explicit digest pass closes it. Asserted so the limit is
    // recorded rather than discovered.
    const have = await haveEverything();
    const dir = join(ROOT, SERIES, "Chapter 071");
    await writeFile(join(dir, "001.png"), Buffer.concat([PIXEL, Buffer.alloc(64)]));
    await scanner.scan();

    const r = await diff(have, { resolve: "pages" });
    expect(r.images.length).toBe(0); // undetected, by design
  });

  test("inserting a chapter dirties one block, not every block after it", async () => {
    const have = await haveEverything();
    await makeChapter("Chapter 072");        // lands in block 51-75
    await scanner.scan();

    const r = await diff(have, { depth: 2 });
    const blocks = r.changed.filter((c) => c.kind === "block");
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.label).toBe("51-75");
    // Blocks 1-25 and 26-50 are untouched -- positional blocking would have
    // shifted membership and dirtied all of them.
  });

  test("child counts separate an added chapter from a modified one", async () => {
    const have = await haveEverything();
    await makeChapter("Chapter 073");
    await scanner.scan();

    const before = have.find((h) => h.id.startsWith("b:") && h.id.endsWith(":51"));
    const r = await diff(have, { depth: 2 });
    const block = r.changed.find((c) => c.id === before?.id);
    expect(block).toBeDefined();
    expect(block!.n).toBe(3); // 71, 72, 73 -- count grew, so this is an addition
  });

  test("depth limits how far the response descends", async () => {
    const shallow = await diff([], { depth: 1 });
    expect(shallow.changed.every((c) => c.kind === "root" || c.kind === "series")).toBe(true);
    expect(shallow.images).toEqual([]);

    const deep = await diff([], { depth: 3 });
    expect(deep.changed.some((c) => c.kind === "chapter")).toBe(true);
  });

  test("scope restricts planning to one subtree", async () => {
    const tree = buildTree();
    const series = tree.children[0]!;
    const r = await diff([], { resolve: "pages", scope: series.id });
    expect(r.images.length).toBeGreaterThan(0);
    expect(r.changed[0]!.id).toBe(series.id);
  });

  test("reports ids the client holds that no longer exist", async () => {
    const r = await diff([{ id: "c:vanished", hash: "deadbeefdeadbeef" }], { depth: 1 });
    expect(r.gone).toEqual(["c:vanished"]);
  });

  test("state is authoritative where a child count is not", async () => {
    // The case n cannot describe: one chapter added, one removed. The count is
    // unchanged, so a count-based guess reports "modified" and loses both facts.
    const have = await haveEverything();
    const blockBefore = have.find((h) => h.id.startsWith("b:") && h.id.endsWith(":51"))!;
    const removedId = (buildTree())
      .children[0]!.children.find((b) => b.id === blockBefore.id)!
      .children.find((c) => c.label === "Chapter 073")!.id;

    await makeChapter("Chapter 074");
    await rm(join(ROOT, SERIES, "Chapter 073"), { recursive: true });
    await scanner.scan();

    const r = await diff(have, { depth: 3 });
    const block = r.changed.find((c) => c.id === blockBefore.id)!;

    expect(block.n).toBe(3);               // 71, 72, 74 -- count did not move
    expect(block.state).toBe("modified");  // and says nothing about what happened

    // state and gone carry the actual facts:
    const added = r.changed.filter((c) => c.kind === "chapter" && c.state === "added");
    expect(added.map((c) => c.label)).toEqual(["Chapter 074"]);
    expect(r.gone).toContain(removedId);
  });

  test("a node the client never mentioned is added, not modified", async () => {
    const r = await diff([], { depth: 2 });
    expect(r.changed.every((c) => c.state === "added")).toBe(true);
  });

  test("a node the client holds at a stale hash is modified", async () => {
    const tree = buildTree();
    const r = await diff([{ id: tree.id, hash: "0000000000000000" }], { depth: 1 });
    expect(r.changed.find((c) => c.id === "root")!.state).toBe("modified");
  });
});
