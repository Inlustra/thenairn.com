import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { RegistryCard, RegistryProvider } from "./provider";

// MANGA_DIR is read at module load, so seed the library before importing.
const ROOT = await mkdtemp(join(tmpdir(), "paperbox-identity-"));
process.env.MANGA_DIR = ROOT;
const scanner = await import("../scanner");
const svc = await import("./index");
const { identityRoutes } = await import("../routes/identity");

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Two chapters is enough to be "a folder of page images". */
async function seed(series: string, chapters: number) {
  for (let c = 1; c <= chapters; c++) {
    const dir = join(ROOT, series, `Chapter ${String(c).padStart(3, "0")}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "001.png"), PIXEL);
  }
}

function card(over: Partial<RegistryCard> & { canonicalTitle: string; registryId: string }): RegistryCard {
  return {
    provider: "fake",
    providerName: "Fake Registry",
    altTitles: [],
    kind: "comic",
    typeLabel: null,
    status: "ongoing",
    latestChapter: null,
    cadenceDays: null,
    cadenceLabel: null,
    seasons: [],
    seasonHints: [],
    asOf: "2026-08-29",
    ...over,
  };
}

/** A provider that never opens a socket. Answers are set per test. */
class FakeProvider implements RegistryProvider {
  readonly id = "fake";
  readonly name = "Fake Registry";
  readonly domain = "manga" as const;
  readonly canRequery = true;
  cards: RegistryCard[] = [];
  searches = 0;
  fetches = 0;
  configured() {
    return true;
  }
  requirement() {
    return "";
  }
  async search(): Promise<RegistryCard[]> {
    this.searches++;
    // Shallow, exactly like a real search endpoint: type is present, the
    // chapter count is not.
    return this.cards.map((c) => ({ ...c, latestChapter: null, altTitles: [] }));
  }
  async fetch(registryId: string): Promise<RegistryCard | null> {
    this.fetches++;
    return this.cards.find((c) => c.registryId === registryId) ?? null;
  }
}

/** A slot nobody connected — the Comic Vine shape, without the network. */
class UnconnectedProvider implements RegistryProvider {
  readonly id = "unconnected";
  readonly name = "Some Other Registry";
  readonly domain = "western" as const;
  readonly canRequery = true;
  configured() {
    return false;
  }
  requirement() {
    return "Needs a free key";
  }
  async search(): Promise<RegistryCard[]> {
    throw new Error("not connected");
  }
  async fetch(): Promise<RegistryCard | null> {
    throw new Error("not connected");
  }
}

let fake: FakeProvider;

beforeAll(async () => {
  await seed("Doom Folder", 102);
  await seed("Warhammer 40,000", 5);
  await scanner.scan();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  fake = new FakeProvider();
  svc.setProviders([fake, new UnconnectedProvider()]);
  // Every test starts from "nobody has looked".
  for (const m of scanner.getMangaList()) await svc.clearBinding(m.id);
});

const sidecar = async (dir: string) =>
  JSON.parse(await readFile(join(ROOT, dir, "paperbox.json"), "utf-8"));

describe("reading is free", () => {
  test("no binding reads as unchecked, and writes nothing to disk", async () => {
    const b = svc.getBinding("doom-folder")!;
    expect(b.state).toBe("unchecked");
    expect((await sidecar("Doom Folder")).identity).toBeUndefined();
    // Reading a binding must never reach a provider.
    expect(fake.searches).toBe(0);
    expect(fake.fetches).toBe(0);
  });

  test("all() answers for every series without asking anybody", async () => {
    const all = svc.allBindings();
    expect(Object.keys(all).length).toBe(scanner.getMangaList().length);
    expect(fake.searches).toBe(0);
  });
});

describe("identify", () => {
  test("one exact alternative title binds, with no question", async () => {
    fake.cards = [
      card({
        registryId: "42",
        canonicalTitle: "Doom Breaker",
        altTitles: ["Doom Folder"],
        latestChapter: 110,
      }),
    ];
    const b = (await svc.identify("doom-folder"))!;
    expect(b.state).toBe("identified");
    expect(b.registry?.canonicalTitle).toBe("Doom Breaker");
    expect(b.registry?.latestChapter).toBe(110);
    expect(b.candidate).toBeUndefined();

    // Identity travels with the folder, so it lives in the sidecar.
    const meta = await sidecar("Doom Folder");
    expect(meta.identity.state).toBe("identified");
    expect(meta.identity.registryId).toBe("42");
    expect(meta.identity.decidedBy).toBe("auto");
  });

  test("a near miss asks, and carries its grounds", async () => {
    fake.cards = [card({ registryId: "43", canonicalTitle: "Doom Folders of Doom", latestChapter: 120 })];
    const b = (await svc.identify("doom-folder"))!;
    expect(b.state).toBe("guess");
    expect(b.candidate?.title).toBe("Doom Folders of Doom");
    // A candidate you cannot bind is not a candidate.
    expect(b.candidate?.registryId).toBe("43");
    expect(b.candidate?.evidence.length).toBeGreaterThan(0);
  });

  test("a disproven candidate is discarded silently — never a rejected option", async () => {
    // The exact shape of the real failure: an exact-named novel, and an
    // upstream count the held chapters make impossible.
    fake.cards = [
      card({ registryId: "44", canonicalTitle: "Doom Folder", altTitles: ["Doom Folder"], kind: "prose" }),
      card({ registryId: "45", canonicalTitle: "Doom Folder", altTitles: ["Doom Folder"], latestChapter: 0 }),
    ];
    const b = (await svc.identify("doom-folder"))!;
    expect(b.state).not.toBe("identified");
    expect(b.state).not.toBe("guess");
    expect(b.candidate).toBeUndefined();
    // And nothing anywhere on the wire mentions what was ruled out.
    expect(JSON.stringify(b)).not.toContain("Doom Folder");
  });

  test("nothing survives, and a slot is unconnected → unconfigured, named", async () => {
    fake.cards = [];
    const b = (await svc.identify("warhammer-40-000"))!;
    expect(b.state).toBe("unconfigured");
    expect(b.suggestedProvider).toBe("Some Other Registry");
  });

  test("nothing survives and everything is connected → no-match", async () => {
    svc.setProviders([fake]);
    fake.cards = [];
    const b = (await svc.identify("warhammer-40-000"))!;
    expect(b.state).toBe("no-match");
    expect(b.suggestedProvider).toBeUndefined();
  });

  test("a shallow novel is discarded before it costs a card read", async () => {
    fake.cards = [card({ registryId: "46", canonicalTitle: "Doom Folder", kind: "prose" })];
    await svc.identify("doom-folder");
    expect(fake.searches).toBe(1);
    expect(fake.fetches).toBe(0);
  });
});

describe("a human decision outranks the matcher", () => {
  test("confirm freezes the identity; a later identify refreshes only the facts", async () => {
    fake.cards = [
      card({ registryId: "50", canonicalTitle: "The One They Picked", latestChapter: 110 }),
      card({ registryId: "51", canonicalTitle: "Doom Folder", altTitles: ["Doom Folder"], latestChapter: 200 }),
    ];
    const bound = (await svc.confirm("doom-folder", "fake", "50"))!;
    expect(bound.state).toBe("identified");
    expect(bound.registry?.registryId).toBe("50");
    expect((await sidecar("Doom Folder")).identity.decidedBy).toBe("human");

    // The matcher would now pick 51 on its own. It must not.
    fake.cards[0] = { ...fake.cards[0]!, latestChapter: 115 };
    const after = (await svc.identify("doom-folder"))!;
    expect(after.registry?.registryId).toBe("50");
    expect(after.registry?.canonicalTitle).toBe("The One They Picked");
    expect(after.registry?.latestChapter).toBe(115);
    expect((await sidecar("Doom Folder")).identity.decidedBy).toBe("human");
  });

  test("'not this' lands on no-match, not back on never-looked", async () => {
    const b = (await svc.reject("doom-folder"))!;
    expect(b.state).toBe("no-match");
    expect((await sidecar("Doom Folder")).identity.decidedBy).toBe("human");
  });

  test("'don't look this up' survives a later identify", async () => {
    fake.cards = [card({ registryId: "60", canonicalTitle: "Doom Folder", altTitles: ["Doom Folder"], latestChapter: 110 })];
    await svc.filesOnly("doom-folder");
    const after = (await svc.identify("doom-folder"))!;
    expect(after.state).toBe("files-only");
    expect(fake.searches).toBe(0);
  });
});

describe("search — the user looks it up themselves", () => {
  test("survivors come back bindable; contradictions do not come back at all", async () => {
    fake.cards = [
      card({ registryId: "70", canonicalTitle: "Doom Folder", altTitles: ["Doom Folder"], latestChapter: 110 }),
      card({ registryId: "71", canonicalTitle: "Doom Folder Novel Edition", kind: "prose" }),
      card({ registryId: "72", canonicalTitle: "Doom Folder Zero", latestChapter: 0 }),
    ];
    const found = await svc.search("doom-folder", "Doom Folder");
    expect(found.map((c) => c.registryId)).toEqual(["70"]);
    // The bar belongs to the evidence, not to who asked.
    expect(found[0]!.evidence.some((e) => e.verdict === "contradict")).toBe(false);
  });

  test("and what comes back can actually be bound", async () => {
    fake.cards = [card({ registryId: "80", canonicalTitle: "Something Else Entirely", altTitles: ["Doom Folder"], latestChapter: 110 })];
    const [found] = await svc.search("doom-folder", "Doom Folder");
    const bound = (await svc.confirm("doom-folder", found!.provider, found!.registryId))!;
    expect(bound.state).toBe("identified");
    expect(bound.registry?.canonicalTitle).toBe("Something Else Entirely");
  });
});

describe("ComicInfo.xml outranks a search result", () => {
  test("identified from the file, with no way to say you are behind", async () => {
    const path = join(ROOT, "Doom Folder", "ComicInfo.xml");
    await writeFile(path, `<ComicInfo><Series>Doom, By The File</Series><Year>2019</Year><Count>200</Count></ComicInfo>`);
    try {
      fake.cards = [card({ registryId: "90", canonicalTitle: "Doom Folder", altTitles: ["Doom Folder"], latestChapter: 110 })];
      const b = (await svc.identify("doom-folder"))!;
      expect(b.state).toBe("identified");
      expect(b.registry?.canonicalTitle).toBe("Doom, By The File");
      expect(b.registry?.provider).toBe("ComicInfo.xml");
      // The whole point: matched, and it cannot tell you more exists.
      expect(b.registry?.latestChapter).toBeNull();
      // It is believed, so nothing was searched for.
      expect(fake.searches).toBe(0);
      expect((await sidecar("Doom Folder")).identity.decidedBy).toBe("file");
    } finally {
      await rm(path, { force: true });
    }
  });
});

describe("routes", () => {
  const app = identityRoutes;

  test("/api/identity/providers is a provider list, not a series lookup", async () => {
    const res = await app.handle(new Request("http://localhost/api/identity/providers"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: { id: string; configured: boolean }[] };
    expect(body.providers.map((p) => p.id).sort()).toEqual(["fake", "unconnected"]);
    expect(body.providers.find((p) => p.id === "unconnected")!.configured).toBe(false);
  });

  test("an unknown series is a 404, not an empty binding", async () => {
    const res = await app.handle(new Request("http://localhost/api/identity/no-such-series"));
    expect(res.status).toBe(404);
  });

  test("confirm binds through the route", async () => {
    fake.cards = [card({ registryId: "99", canonicalTitle: "Routed", latestChapter: 5 })];
    const res = await app.handle(
      new Request("http://localhost/api/identity/doom-folder/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "fake", registryId: "99" }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).registry.canonicalTitle).toBe("Routed");
  });
});
