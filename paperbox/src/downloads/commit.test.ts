import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { commitChapter } from "./manager";

const ROOT = await mkdtemp(join(tmpdir(), "paperbox-commit-"));
afterAll(async () => { await rm(ROOT, { recursive: true, force: true }); });

const CH = "Chapter 071";
const live = join(ROOT, CH);
const staging = join(ROOT, `.staging-${CH}`);

async function seed(dir: string, files: string[]) {
  await mkdir(dir, { recursive: true });
  for (const f of files) await writeFile(join(dir, f), f);
}

beforeEach(async () => {
  await rm(live, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
});

describe("commitChapter", () => {
  test("replaces the old chapter wholesale -- never blends two sources", async () => {
    // The real bug: old source wrote .png, new source writes .jpg, and the
    // chapter ended up holding both sets side by side.
    await seed(live, ["001.png", "002.png", "003.png"]);
    await seed(staging, ["001.jpg", "002.jpg"]);

    await commitChapter(ROOT, CH, staging, live);

    expect((await readdir(live)).sort()).toEqual(["001.jpg", "002.jpg"]);
  });

  test("works when the chapter is new", async () => {
    await seed(staging, ["001.jpg"]);
    await commitChapter(ROOT, CH, staging, live);
    expect(await readdir(live)).toEqual(["001.jpg"]);
  });

  test("leaves no staging or scratch directories behind", async () => {
    await seed(live, ["001.png"]);
    await seed(staging, ["001.jpg"]);
    await commitChapter(ROOT, CH, staging, live);
    const leftovers = (await readdir(ROOT)).filter((e) => e.startsWith("."));
    expect(leftovers).toEqual([]);
  });

  test("restores the previous chapter if the swap fails", async () => {
    await seed(live, ["001.png", "002.png"]);
    // No staging directory -> the rename throws mid-swap.
    await expect(commitChapter(ROOT, CH, staging, live)).rejects.toThrow();
    expect((await readdir(live)).sort()).toEqual(["001.png", "002.png"]);
  });
});
