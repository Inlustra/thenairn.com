import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { kindOf, MangaUpdatesProvider, nativeTitleOf, parseSeasonHints } from "./mangaupdates";
import { ComicVineProvider } from "./comicvine";
import { parseComicInfo, readComicInfo } from "./comicinfo";
import { Fetcher } from "./net";

describe("MangaUpdates — type vocabulary", () => {
  test("Novel is the contradiction; comics are comics; the rest stays unknown", () => {
    expect(kindOf("Novel")).toBe("prose");
    expect(kindOf("Manhwa")).toBe("comic");
    expect(kindOf("Manga")).toBe("comic");
    expect(kindOf("Doujinshi")).toBe("comic");
    // An unrecognised type must never be assumed into `comic`: an unknown kind
    // contradicts nothing, a wrongly-assumed one silently licenses a binding.
    expect(kindOf("Wibble")).toBe("unknown");
    expect(kindOf(undefined)).toBe("unknown");
  });
});

describe("MangaUpdates — season prose", () => {
  // Verbatim from the live API, 2026-08-29, series 114563652 (Nano Machine).
  const NANO = "326 Chapters (Ongoing)\n\n**S1** : 142 Chapters (1\\~142)                                       \n**S2** : 184 Chapters (Ongoing) (143\\~???)";
  // Verbatim, series 27180626786 (Yeokdaegeup Yeongji Seolgyesa) — a different
  // shape for the same thing, which is why this is parsed and not trusted.
  const ESTATE = "**Digital**    \n223 Chapters (Complete)\n\n**S1:** 104 Chapters (1-104) + 5 Special Chapters\n**S2:** 78 Chapters (105-182)";

  test("reads a boundary where the prose gives one", () => {
    expect(parseSeasonHints(NANO)).toEqual([
      { name: "Season 1", endAfterSortKey: 142, from: "MangaUpdates status text" },
    ]);
  });

  test("a season still running has no boundary and is skipped, not guessed", () => {
    // `(143~???)` — half a boundary would draw a divider in the wrong place
    // with the same confidence as a right one.
    expect(parseSeasonHints(NANO).some((s) => s.name === "Season 2")).toBe(false);
  });

  test("the other live shape parses too", () => {
    expect(parseSeasonHints(ESTATE).map((s) => s.endAfterSortKey)).toEqual([104, 182]);
  });

  test("nothing to read is no hints, never a throw", () => {
    expect(parseSeasonHints(undefined)).toEqual([]);
    expect(parseSeasonHints("Ongoing")).toEqual([]);
  });
});

describe("MangaUpdates — the native title", () => {
  test("picked by script, and absent when there is none", () => {
    expect(nativeTitleOf(["Nano Mashin", "나노마신", "ナノ魔神"])).toBe("나노마신");
    expect(nativeTitleOf(["Loco Frontera", "The Greatest Estate Designer"])).toBeUndefined();
  });
});

describe("MangaUpdates — a shallow card never claims a chapter count", () => {
  test("search results report latestChapter as null even if a field sneaks in", async () => {
    // provider.ts rule 2: null means "the registry keeps no records", and 0 is
    // a contradiction. A search record does not carry the field at all, so
    // letting its absence through as a *deep* null would make every candidate
    // look like a registry with no chapters — and discard it before we ever
    // fetched the card that would have proved it right.
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ results: [{ record: { series_id: 7, title: "Nano Machine", type: "Manhwa", latest_chapter: 327 } }] }),
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      const p = new MangaUpdatesProvider(new Fetcher(0));
      const [card] = await p.search("Nano Machine", 5);
      expect(card!.canonicalTitle).toBe("Nano Machine");
      expect(card!.latestChapter).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("Comic Vine — the slot", () => {
  const original = process.env.COMICVINE_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.COMICVINE_API_KEY;
    else process.env.COMICVINE_API_KEY = original;
  });

  test("unconfigured, and it says what is missing in a person's words", () => {
    delete process.env.COMICVINE_API_KEY;
    const cv = new ComicVineProvider();
    expect(cv.configured()).toBe(false);
    expect(cv.requirement()).toBe("Needs a free key from Comic Vine");
  });

  test("asking an unconnected provider throws rather than returning nothing", async () => {
    // An empty array would read as "it looked and found nothing", which is the
    // exact confusion the unconfigured state exists to prevent.
    delete process.env.COMICVINE_API_KEY;
    await expect(new ComicVineProvider().search()).rejects.toThrow("not connected");
  });
});

describe("ComicInfo.xml — identity that arrived with the files", () => {
  test("parses the flat elements and decodes entities", () => {
    const f = parseComicInfo(
      `<?xml version="1.0"?><ComicInfo><Series>Marneus Calgar &amp; Friends</Series><Year>2020</Year><Count>5</Count><Publisher>Marvel</Publisher><Manga>No</Manga></ComicInfo>`,
    );
    expect(f.series).toBe("Marneus Calgar & Friends");
    expect(f.year).toBe(2020);
    expect(f.publisher).toBe("Marvel");
  });

  test("it identifies, and it cannot tell you that you are behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperbox-ci-"));
    try {
      await writeFile(
        join(dir, "ComicInfo.xml"),
        `<ComicInfo><Series>Warhammer 40,000: Marneus Calgar</Series><Year>2020</Year><Count>5</Count></ComicInfo>`,
      );
      const card = await readComicInfo("uid-1", [dir]);
      expect(card!.canonicalTitle).toBe("Warhammer 40,000: Marneus Calgar");
      expect(card!.registryId).toBe("comicinfo:uid-1");
      // `Count` is right there and is deliberately not mapped: a denominator
      // frozen at whenever the file was written would render as a live gap
      // line for ever. No upstream, therefore no gap line at all.
      expect(card!.latestChapter).toBeNull();
      // The stamp is the file's date, not today's — the card is exactly as
      // fresh as the file is.
      expect(card!.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no file is null, not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperbox-ci-"));
    try {
      expect(await readComicInfo("uid-2", [dir])).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Fetcher — being a good guest", () => {
  test("serialises, and keeps a floor between calls", async () => {
    const f = new Fetcher(40);
    const starts: number[] = [];
    const run = async () => {
      starts.push(Date.now());
      return 1;
    };
    await Promise.all([f.json("a", 0, run), f.json("b", 0, run), f.json("c", 0, run)]);
    expect(starts.length).toBe(3);
    expect(starts[2]! - starts[0]!).toBeGreaterThanOrEqual(70);
  });

  test("a cached answer costs no request", async () => {
    const f = new Fetcher(0);
    await f.json("k", 60_000, async () => 1);
    await f.json("k", 60_000, async () => 2);
    expect(f.calls).toBe(1);
    expect(f.hits).toBe(1);
  });

  test("one failure does not wedge every later call behind it", async () => {
    const f = new Fetcher(0);
    await expect(f.json("bad", 0, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await f.json("good", 0, async () => 42)).toBe(42);
  });
});
