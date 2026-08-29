import { describe, expect, test } from "bun:test";
import { bestName, conclude, countImpossible, judge, nameScore, squash, tokens, type Judgement } from "./match";
import type { RegistryCard } from "./provider";

function card(over: Partial<RegistryCard> & { canonicalTitle: string }): RegistryCard {
  return {
    provider: "test",
    providerName: "Test",
    registryId: "1",
    altTitles: [],
    kind: "comic",
    typeLabel: null,
    status: "unknown",
    latestChapter: null,
    cadenceDays: null,
    cadenceLabel: null,
    seasons: [],
    seasonHints: [],
    asOf: "2026-08-29",
    ...over,
  };
}

describe("normalisation", () => {
  test("punctuation is removed, not turned into a separator", () => {
    // Real: the folder is `Trash of the Counts Family`, upstream is
    // `Trash of the Count's Family`. Under a token-preserving normalisation
    // those are `counts` vs `count` + `s` and never match.
    expect(squash("Trash of the Counts Family")).toBe(squash("Trash of the Count's Family"));
    // Real: the folder carries a curly apostrophe.
    expect(squash("Omniscient Reader’s Viewpoint")).toBe(squash("Omniscient Reader's Viewpoint"));
  });

  test("a digit group is one token, not three", () => {
    // Regression. `40,000` split into `40` and `000`, so "Warhammer 40,000"
    // shared the token `000` with "10,000 Bon no Gomu" and "50,000節" and both
    // scored 0.4 against a folder MangaUpdates has never heard of.
    expect([...tokens("Warhammer 40,000")].sort()).toEqual(["40000", "warhammer"]);
    expect(nameScore("Warhammer 40,000", "10,000 Bon no Gomu")).toBe(0);
    expect(nameScore("Warhammer 40,000", "50,000節")).toBe(0);
  });

  test("an exact squash is 1 regardless of spacing or case", () => {
    expect(nameScore("SSS-Class Suicide Hunter", "sss class suicide hunter")).toBe(1);
  });
});

describe("bestName searches alternative titles", () => {
  // The whole lesson of the 2026-08-29 measurement: every correct binding in
  // this library is exact on an *alternative* title of a record whose canonical
  // title looks nothing like the folder.
  test("an exact alternative title beats a mediocre canonical one", () => {
    const c = card({
      canonicalTitle: "Doom Breaker",
      altTitles: ["A Battle God's Second Chance", "Reincarnation of the Suicidal Battle God"],
    });
    const best = bestName(c, "Reincarnation of the Suicidal Battle God");
    expect(best.exact).toBe(true);
    expect(best.via).toBe("Reincarnation of the Suicidal Battle God");
    expect(best.score).toBe(1);
  });
});

describe("countImpossible", () => {
  test("a registry lagging by one is not a contradiction", () => {
    // Doom Breaker lists 101; we hold 102. Normal.
    expect(countImpossible(102, 101)).toBe(false);
  });
  test("no records at all against a held library is decisive", () => {
    expect(countImpossible(219, 0)).toBe(true);
  });
  test("a count the held chapters make impossible is decisive", () => {
    expect(countImpossible(201, 42)).toBe(true);
  });
  test("an absent count contradicts nothing", () => {
    // null and 0 are opposite verdicts, and this is where that matters.
    expect(countImpossible(165, null)).toBe(false);
  });
});

describe("judge — a contradiction removes a candidate", () => {
  test("a novel against a folder of page images", () => {
    const j = judge(card({ canonicalTitle: "Solo Leveling", kind: "prose" }), "Solo Leveling", 201);
    expect(j.contradicted).toBe(true);
  });

  test("a surfaced candidate carries only agree and unknown rows", () => {
    const j = judge(
      card({ canonicalTitle: "Lout of Count's Family", altTitles: ["Trash of the Count's Family"], latestChapter: 185 }),
      "Trash of the Counts Family",
      176,
    );
    expect(j.contradicted).toBe(false);
    expect(j.evidence.map((e) => e.verdict)).not.toContain("contradict");
    expect(j.evidence.some((e) => e.verdict === "agree" && e.fact.includes("176"))).toBe(true);
  });
});

describe("conclude", () => {
  const exact = (title: string, latest: number | null): Judgement =>
    judge(card({ canonicalTitle: title, altTitles: [title], latestChapter: latest }), title, 10);

  test("one exact survivor binds without a question", () => {
    const o = conclude([exact("Nano Machine", 327)]);
    expect(o.kind).toBe("identified");
  });

  test("two exact survivors is genuine uncertainty, so it asks", () => {
    const o = conclude([exact("Nano Machine", 327), exact("Nano Machine", 300)]);
    expect(o.kind).toBe("guess");
  });

  test("a close-but-not-exact survivor asks", () => {
    const near = judge(card({ canonicalTitle: "The Greatest Estate Designer", latestChapter: 222 }), "The Greatest Estate Developer", 219);
    expect(conclude([near]).kind).toBe("guess");
  });

  test("everything contradicted resolves to none, with nothing to show", () => {
    const novel = judge(card({ canonicalTitle: "Nano Machine", kind: "prose" }), "Nano Machine", 313);
    const o = conclude([novel]);
    expect(o.kind).toBe("none");
    // The point of the rule: a disproven candidate does not survive as a
    // "rejected option" anywhere a client could render it.
    expect("winner" in o).toBe(false);
  });

  test("a name score alone never binds", () => {
    // Two of twelve matched wrong at "high" confidence. Similarity gets a
    // question; only an exact curated title gets a binding.
    const near = judge(card({ canonicalTitle: "Reincarnation of the Martial God", latestChapter: 300 }), "Reincarnation of the Suicidal Battle God", 102);
    expect(near.score).toBeGreaterThan(0.6);
    expect(conclude([near]).kind).toBe("guess");
  });
});
