/**
 * Test: Run AsuraScans Lua module against a real URL.
 *
 * Usage:
 *   bun test paperbox/src/lua/engine.test.ts
 *
 * These tests verify the Lua engine doesn't crash with
 * "TypeError: null is not an object (evaluating 'decoration.target.then')"
 * when wasmoon iterates JS-returned objects from Lua.
 *
 * The live URL tests require network access to asuracomic.net.
 * When running in a sandboxed environment, the unit tests still verify
 * the engine doesn't crash (even with empty HTTP responses).
 */
import { describe, it, expect } from "bun:test";
import { LuaFactory } from "wasmoon";
import { runModule } from "./engine";
import { join } from "path";

const SCRIPT_PATH = join(import.meta.dir, "../../test-scripts/AsuraScans.lua");
const TEST_URL = "https://asuracomic.net/series/sword-devouring-swordmaster-2fd445c0";

describe("wasmoon iterator null safety", () => {
  it("returning undefined from JS iterator does not crash wasmoon", async () => {
    const factory = new LuaFactory();
    const lua = await factory.createEngine();
    try {
      const collected: string[] = [];
      lua.global.set("ITEMS", { Add: (s: string) => collected.push(s) });
      lua.global.set("getIterator", () => {
        const items = ["a", "b", "c"];
        let idx = 0;
        return {
          Count: items.length,
          Get: () => {
            return () => {
              if (idx >= items.length) return undefined; // NOT null
              return { name: items[idx++] };
            };
          },
        };
      });

      await lua.doString(`
        local iter = getIterator()
        for v in iter.Get() do
          ITEMS.Add(v.name)
        end
      `);
      expect(collected).toEqual(["a", "b", "c"]);
    } finally {
      lua.global.close();
    }
  });

  it("returning null from JS iterator crashes wasmoon (regression check)", async () => {
    const factory = new LuaFactory();
    const lua = await factory.createEngine();
    try {
      lua.global.set("getIterator", () => {
        const items = ["a"];
        let idx = 0;
        return {
          Count: items.length,
          Get: () => {
            return () => {
              if (idx >= items.length) return null; // This causes the bug
              return { name: items[idx++] };
            };
          },
        };
      });

      await expect(
        lua.doString(`
          local iter = getIterator()
          for v in iter.Get() do end
        `)
      ).rejects.toThrow("decoration.target");
    } finally {
      lua.global.close();
    }
  });
});

describe("AsuraScans Lua module", () => {
  it("GetInfo - runs without crashing (decoration.target.then fix)", async () => {
    // This is the core regression test. Before the fix, this would crash with:
    // TypeError: null is not an object (evaluating 'decoration.target.then')
    const result = await runModule(SCRIPT_PATH, "GetInfo", {
      url: TEST_URL,
    });

    console.log("=== GetInfo Result ===");
    console.log("Title:", result.mangaInfo.title || "(empty - network may be blocked)");
    console.log("Status:", result.mangaInfo.status);
    console.log("Chapters:", result.mangaInfo.chapterNames.length);

    // The key assertion: no crash occurred. If we got here, the fix works.
    expect(result.mangaInfo).toBeDefined();
    expect(result.mangaInfo.chapterNames).toBeInstanceOf(Array);
    expect(result.mangaInfo.chapterLinks).toBeInstanceOf(Array);

    // If network is available, verify actual data
    if (result.mangaInfo.title) {
      console.log("First chapter:", result.mangaInfo.chapterNames[0]);
      console.log("Last chapter:", result.mangaInfo.chapterNames[result.mangaInfo.chapterNames.length - 1]);
      expect(result.mangaInfo.chapterNames.length).toBeGreaterThan(0);
      expect(result.mangaInfo.chapterLinks.length).toBe(result.mangaInfo.chapterNames.length);
    }
  }, 30_000);

  it("GetPageNumber - runs without crashing", async () => {
    const info = await runModule(SCRIPT_PATH, "GetInfo", {
      url: TEST_URL,
    });

    if (info.mangaInfo.chapterLinks.length === 0) {
      console.log("Skipping GetPageNumber - no chapters (network may be blocked)");
      return;
    }

    const firstChapterUrl = info.mangaInfo.chapterLinks[0]!;
    console.log("Chapter URL:", firstChapterUrl);

    const result = await runModule(SCRIPT_PATH, "GetPageNumber", {
      url: firstChapterUrl,
    });

    console.log("Pages found:", result.pages.pageLinks.length);
    expect(result.pages.pageLinks).toBeInstanceOf(Array);

    if (result.pages.pageLinks.length > 0) {
      console.log("First page:", result.pages.pageLinks[0]);
      expect(result.pages.pageLinks.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it("GetInfo - retry loop (runs 3 times to check stability)", async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`\n=== Attempt ${attempt}/3 ===`);
      const result = await runModule(SCRIPT_PATH, "GetInfo", {
        url: TEST_URL,
      });
      console.log(`  Title: ${result.mangaInfo.title || "(empty)"}`);
      console.log(`  Chapters: ${result.mangaInfo.chapterNames.length}`);
      expect(result.mangaInfo).toBeDefined();
    }
  }, 90_000);
});
