import { describe, expect, test } from "bun:test";
import { deriveChapterKey, keyEnd, keySpan } from "./chapters";

describe("deriveChapterKey", () => {
  test("strips the series title, which is what saves the western comics", () => {
    // Without the strip, every issue parses to 40 from "Warhammer 40,000" and
    // all five collide into one chapter number and one block.
    const s = "Warhammer 40,000_ Exterminatus";
    const keys = [1, 2, 3, 4, 5].map(
      (n) => deriveChapterKey(s, `${s} Issue #${n}`).sortKey
    );
    expect(keys).toEqual([1, 2, 3, 4, 5]);
  });

  test("keeps the ordinary cases exactly right", () => {
    expect(deriveChapterKey("Nano Machine", "Chapter 216").sortKey).toBe(216);
    expect(deriveChapterKey("Solo Leveling", "Chapter 0").sortKey).toBe(0);
    expect(deriveChapterKey("X", "Chapter 50.5").sortKey).toBe(50.5);
    expect(deriveChapterKey("X", "Episode 038").sortKey).toBe(38);
  });

  test("takes the chapter number, not a number from the title text", () => {
    // The title after the number contains more digits; the first run still wins.
    const k = deriveChapterKey("Omniscient Reader's Viewpoint", "Chapter 200 33. Rereading (7)");
    expect(k.sortKey).toBe(200);
  });

  test("is not fooled by a trailing suffix that looks like a range", () => {
    // "-S4 END-" must not read as a range: the character after the dash is not a digit.
    const k = deriveChapterKey("SSS-Class Suicide Hunter", "Chapter 151 -S4 END-");
    expect(k.sortKey).toBe(151);
    expect(k.sortKeyEnd).toBeUndefined();
  });

  describe("sequences", () => {
    test("a spin-off is a different run, so #001 does not collide with Episode 001", () => {
      const main = deriveChapterKey("The Greatest Estate Developer", "Episode 001");
      const spin = deriveChapterKey("The Greatest Estate Developer", "Spin-off #001");
      expect(main.sortKey).toBe(1);
      expect(spin.sortKey).toBe(1);
      // Same number, different run - which is exactly why sequence exists.
      expect(main.sequence).toBe("main");
      expect(spin.sequence).toBe("spin-off");
      expect(`${main.sequence}#${main.sortKey}`).not.toBe(`${spin.sequence}#${spin.sortKey}`);
    });

    test("a prologue belongs to the main run, not a sequence of its own", () => {
      expect(deriveChapterKey("X", "Chapter 000 Prologue").sequence).toBe("main");
    });

    test("recognises the other common run names", () => {
      expect(deriveChapterKey("X", "Side Story 3").sequence).toBe("side-story");
      expect(deriveChapterKey("X", "Extra 2").sequence).toBe("extra");
      expect(deriveChapterKey("X", "Omake 1").sequence).toBe("omake");
    });
  });

  describe("ranges", () => {
    test("one directory covering several chapters spans them", () => {
      const k = deriveChapterKey("X", "Chapter 14-19");
      expect(k.sortKey).toBe(14);
      expect(k.sortKeyEnd).toBe(19);
      expect(keyEnd(k)).toBe(19);
      // Six chapters in one directory: the hold line must count six, and gap
      // arithmetic must span 15-18 or an omnibus opens a false hole.
      expect(keySpan(k)).toBe(6);
      expect(k.mark).toBe("14–19");
    });

    test("a decimal range still spans", () => {
      const k = deriveChapterKey("X", "14.5-15");
      expect(k.sortKey).toBe(14.5);
      expect(k.sortKeyEnd).toBe(15);
    });

    test("a descending pair is not a range", () => {
      expect(deriveChapterKey("X", "Chapter 19-14").sortKeyEnd).toBeUndefined();
    });
  });

  describe("unnumbered chapters", () => {
    test("invents no mark", () => {
      // The shelf shows the label instead of a fabricated number.
      const k = deriveChapterKey("Warhammer 40,000", "Warhammer 40,000 Full");
      expect(k.sortKey).toBe(0);
      expect(k.mark).toBe("");
      expect(k.label).toBe("Warhammer 40,000 Full");
    });

    test("a oneshot is unnumbered, not chapter zero with a mark", () => {
      expect(deriveChapterKey("X", "Oneshot").mark).toBe("");
    });

    test("a chapter named exactly after its series keeps its name", () => {
      // Stripping would leave nothing, so the strip is refused.
      const k = deriveChapterKey("Solo Leveling", "Solo Leveling");
      expect(k.label).toBe("Solo Leveling");
    });
  });

  test("the label is always the verbatim directory name", () => {
    for (const dir of ["Chapter 001", "Spin-off #002", "Oneshot", "Chapter 151 -S4 END-"]) {
      expect(deriveChapterKey("X", dir).label).toBe(dir);
    }
  });

  test("keySpan counts a plain chapter as one", () => {
    expect(keySpan(deriveChapterKey("X", "Chapter 7"))).toBe(1);
  });

  describe("cases an adversarial review broke (2026-08-28)", () => {
    test("a volume or season prefix does not win over the chapter number", () => {
      // First-digit-run keyed all of these to the volume. Because keys are
      // stored on first sight, a later parser fix cannot repair a library that
      // adopted them -- so this had to be right before the schema shipped.
      expect(deriveChapterKey("X", "Vol. 2 Ch. 5").sortKey).toBe(5);
      expect(deriveChapterKey("X", "Season 2 Chapter 1").sortKey).toBe(1);
      expect(deriveChapterKey("X", "S2 Chapter 1").sortKey).toBe(1);
      expect(deriveChapterKey("X", "v02 c010").sortKey).toBe(10);
    });

    test("a hyphenated pair elsewhere in the name is not a range", () => {
      // The range search used to be unanchored, so it beat the real chapter
      // number at the front of the name.
      const part = deriveChapterKey("X", "Chapter 1 - Part 2-3");
      expect(part.sortKey).toBe(1);
      expect(part.sortKeyEnd).toBeUndefined();

      const year = deriveChapterKey("X", "Chapter 1 (2020-2021)");
      expect(year.sortKey).toBe(1);
      expect(year.sortKeyEnd).toBeUndefined();
    });

    test("an absurd number is refused rather than stored", () => {
      const k = deriveChapterKey("X", "Chapter 999999999999999999999");
      expect(k.sortKey).toBe(0);
      expect(k.mark).toBe("");
    });

    test("a sequence word must be followed by a number, not just look like one", () => {
      // "Special Delivery" and "Bonus Round 4" were being filed into separate
      // block and ordering namespaces permanently.
      expect(deriveChapterKey("X", "Special Delivery").sequence).toBe("main");
      expect(deriveChapterKey("X", "Bonus Round 4").sequence).toBe("main");
      expect(deriveChapterKey("X", "Extraction 12").sequence).toBe("main");
      // ...while real sequences still resolve.
      expect(deriveChapterKey("X", "Spin-off #002").sequence).toBe("spin-off");
      expect(deriveChapterKey("X", "Extra 2").sequence).toBe("extra");
    });

    test("every key on the real library is unchanged by the hardening", () => {
      // Verified against all 1,706 live chapters: 0 differ. Kept as a guard so a
      // future parser change cannot silently re-key an existing library.
      const live: Array<[string, string, number]> = [
        ["Nano Machine", "Chapter 216", 216],
        ["SSS-Class Suicide Hunter", "Chapter 151 -S4 END-", 151],
        ["Omniscient Reader's Viewpoint", "Chapter 200 33. Rereading (7)", 200],
        ["The Greatest Estate Developer", "Episode 038", 38],
        ["Warhammer 40,000_ Exterminatus", "Warhammer 40,000_ Exterminatus Issue #3", 3],
      ];
      for (const [series, dir, want] of live) {
        expect(deriveChapterKey(series, dir).sortKey).toBe(want);
      }
    });
  });
});
