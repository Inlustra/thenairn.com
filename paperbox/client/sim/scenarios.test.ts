// Scenario tests: the behaviour that is otherwise only observable on a real
// phone on a real train.
//
// Every one of these is deterministic. The clock is injected, the PRNG is
// seeded, and the library is mutated by hand -- so a failure here is a failure,
// not weather.

import { describe, expect, test } from "bun:test";
import { makeWorld, settle } from "./harness";
import type { Rule } from "../types";

const keepSeries = (seriesId: string, priority = 10): Rule => ({
  id: `keep-${seriesId}`, label: `Keep all of ${seriesId}`,
  scope: { kind: "series", seriesId }, retention: { kind: "keep" },
  priority, lifetime: "standing",
});

describe("baseline", () => {
  test("a device with one rule ends up holding exactly that series, once", async () => {
    const w = makeWorld();
    await w.engine.setRules([keepSeries("s:nano")]);
    await settle(w);

    expect(w.engine.state).toBe("idle");
    expect(w.engine.heldChapters().size).toBe(30);
    expect(w.net.refetched()).toEqual([]);
    // Nothing outside the rule was touched.
    expect([...w.engine.heldChapters().keys()].every((id) => id.startsWith("c:nano-"))).toBe(true);
  });

  test("a second run transfers nothing at all", async () => {
    const w = makeWorld();
    await w.engine.setRules([keepSeries("s:nano")]);
    await settle(w);
    const after = w.net.stats.bytesDelivered;

    await settle(w);
    expect(w.net.stats.bytesDelivered).toBe(after);
    expect(w.engine.state).toBe("idle");
  });

  test("the have set collapses held blocks, so a steady-state diff is small", async () => {
    const w = makeWorld();
    await w.engine.setRules([keepSeries("s:nano")]);
    await settle(w);

    const have = w.engine.buildHaveSet();
    // 30 chapters of Nano Machine collapse to one series claim, not 30 entries.
    expect(have.find((h) => h.id === "s:nano")).toBeDefined();
    expect(have.filter((h) => h.id.startsWith("c:nano-")).length).toBe(0);
  });

  test("an imperative fetch is a rule with a lifetime of one evaluation", async () => {
    const w = makeWorld();
    await w.engine.setRules([{
      id: "get-one", label: "Get chapter 5",
      scope: { kind: "chapter", seriesId: "s:solo", chapterId: "c:solo-5" },
      retention: { kind: "keep" }, priority: 50, lifetime: "once",
    }]);
    await settle(w);

    expect(w.engine.isHeld("c:solo-5")).toBe(true);
    // Satisfied, and gone. It does not linger as standing configuration.
    expect(w.engine.rulesNow().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 1. Go offline mid-sync, come back
// ---------------------------------------------------------------------------

describe("1 — offline mid-sync, then back", () => {
  test("resumes without re-fetching a single page it already holds", async () => {
    const w = makeWorld();
    await w.engine.setRules([keepSeries("s:nano")]);

    // The server stops answering after 40 image bodies -- roughly five of the
    // thirty chapters in.
    w.net.set({ dieAfterImages: 40 });
    await settle(w, 4);
    expect(w.engine.state).toBe("offline");
    const partway = w.engine.heldChapters().size;
    expect(partway).toBeGreaterThan(0);
    expect(partway).toBeLessThan(30);

    w.net.revive();
    await settle(w);

    expect(w.engine.state).toBe("idle");
    expect(w.engine.heldChapters().size).toBe(30);
    // The assertion the whole scenario exists for.
    expect(w.net.refetched()).toEqual([]);
  });

  test("the backoff walks the injected clock, never the wall clock", async () => {
    const w = makeWorld({ backoff: [1_000, 2_000, 4_000] });
    await w.engine.setRules([keepSeries("s:solo")]);
    w.net.goOffline();

    const t0 = w.clock.now();
    const a = await w.engine.run();
    expect(a.state).toBe("offline");
    expect(a.waitMs).toBe(1_000);
    // Nothing moved on its own.
    expect(w.clock.now()).toBe(t0);

    w.clock.advance(1_000);
    const b = await w.engine.run();
    expect(b.waitMs).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// 2. The server changes underneath a plan already in flight
// ---------------------------------------------------------------------------

describe("2 — the world moves under an in-flight plan", () => {
  test("a chapter deleted mid-plan is skipped, not fatal, and forces a re-plan", async () => {
    const w = makeWorld();
    await w.engine.setRules([keepSeries("s:nano")]);

    while (w.engine.heldChapters().size < 5) await w.engine.tick();
    const plan = w.engine.currentPlan!;
    const victim = plan.fetch[plan.fetch.length - 1]!.chapterId;
    expect(w.engine.isHeld(victim)).toBe(false);

    w.lib.removeChapter(victim.slice(2));
    w.lib.addChapter("nano", { uid: "nano-31", sortKey: 31, pages: [{ file: "001.jpg", size: 111_000 }] });

    await settle(w);

    expect(w.engine.state).toBe("idle");
    expect(w.engine.isHeld(victim)).toBe(false);
    // The chapter that appeared mid-plan is picked up by the re-plan the
    // staleness forced, not left until the next poll.
    expect(w.engine.isHeld("c:nano-31")).toBe(true);
    expect(w.net.refetched()).toEqual([]);
  });

  test("a chapter re-paged mid-plan is committed at the hash the server now serves", async () => {
    const w = makeWorld();
    await w.engine.setRules([keepSeries("s:solo")]);
    while (w.engine.heldChapters().size < 3) await w.engine.tick();

    const plan = w.engine.currentPlan!;
    const target = plan.fetch[plan.fetch.length - 1]!.chapterId;
    w.lib.repage(target.slice(2), "002.jpg", 999_999);

    await settle(w);

    const held = w.engine.heldChapters().get(target)!;
    const live = w.lib.diff({ scope: target, resolve: "nodes" }).changed[0]!;
    // If these ever disagree the client is holding content under a hash the
    // server does not recognise, and every future diff re-offers it for ever.
    expect(held.hash).toBe(live.hash);
    expect(held.pages.find((p) => p.file === "002.jpg")!.size).toBe(999_999);
  });
});

// ---------------------------------------------------------------------------
// 3. Storage fills during a fetch
// ---------------------------------------------------------------------------

describe("3 — the device fills up", () => {
  test("housekeeping frees what no rule wants, and the fetch completes", async () => {
    const w = makeWorld({ capacityBytes: 32_000_000 });
    await w.engine.setRules([keepSeries("s:solo")]);
    await settle(w);
    const soloHeld = w.engine.heldChapters().size;
    expect(soloHeld).toBe(13);

    // The user changes their mind. Nothing wants Solo Leveling any more.
    await w.engine.setRules([keepSeries("s:nano")]);
    await settle(w);

    expect(w.engine.state).toBe("idle");
    expect(w.engine.heldChapters().size).toBe(30);
    expect([...w.engine.heldChapters().keys()].some((id) => id.startsWith("c:solo-"))).toBe(false);
    expect(w.log.of("evict").length).toBe(soloHeld);
  });

  test("a device that cannot fit the target set blocks, and says how short it is", async () => {
    const w = makeWorld({ capacityBytes: 3_000_000 });
    await w.engine.setRules([keepSeries("s:nano")]);
    await settle(w);

    expect(w.engine.state).toBe("blocked");
    expect(w.engine.blockedReason).toMatch(/bytes short/);
    // Partial work is kept, not thrown away, and nothing was fetched twice.
    expect(w.engine.heldChapters().size).toBeGreaterThan(0);
    expect(w.net.refetched()).toEqual([]);
  });

  test("under `rolling`, high priority displaces low — and never the reverse", async () => {
    const w = makeWorld({ capacityBytes: 12_000_000, policy: "rolling" });
    await w.engine.setRules([keepSeries("s:solo", 1)]);
    await settle(w);
    expect(w.engine.heldChapters().size).toBe(13);

    await w.engine.setRules([keepSeries("s:solo", 1), keepSeries("s:nano", 90)]);
    await settle(w);

    const held = [...w.engine.heldChapters().keys()];
    const nano = held.filter((id) => id.startsWith("c:nano-")).length;
    const solo = held.filter((id) => id.startsWith("c:solo-")).length;
    expect(nano).toBeGreaterThan(0);
    // Solo gave way to Nano; Nano never gave way to Solo. Whatever the device
    // could not hold, it did not churn over: no page was fetched twice.
    expect(solo).toBeLessThan(13);
    expect(w.net.refetched()).toEqual([]);
  });

  test("a pinned chapter is never a candidate, at any pressure", async () => {
    const w = makeWorld({ capacityBytes: 4_000_000, policy: "rolling" });
    await w.engine.setRules([{
      id: "pin-one", label: "Pinned", priority: 1, lifetime: "standing",
      scope: { kind: "chapter", seriesId: "s:solo", chapterId: "c:solo-0" },
      retention: { kind: "pin" },
    }]);
    await settle(w);
    expect(w.engine.isHeld("c:solo-0")).toBe(true);

    await w.engine.setRules([
      { id: "pin-one", label: "Pinned", priority: 1, lifetime: "standing",
        scope: { kind: "chapter", seriesId: "s:solo", chapterId: "c:solo-0" },
        retention: { kind: "pin" } },
      keepSeries("s:nano", 99),
    ]);
    await settle(w);

    expect(w.engine.isHeld("c:solo-0")).toBe(true);
    expect(w.engine.state).toBe("blocked");
    expect(w.engine.blockedReason).toMatch(/pinned/);
  });
});

// ---------------------------------------------------------------------------
// 4. A chapter is re-sourced: the hash moves, the bytes do not
// ---------------------------------------------------------------------------

describe("4 — re-sourced chapter, identical bytes", () => {
  test("costs one round trip and zero bytes", async () => {
    const w = makeWorld();
    await w.engine.setRules([keepSeries("s:nano")]);
    await settle(w);

    const before = { bytes: w.net.stats.bytesDelivered, images: w.net.stats.imageCalls };
    const oldHash = w.engine.heldChapters().get("c:nano-3")!.hash;

    // Same pages, same sizes, different provenance. docs/sync.md: this moves
    // the chapter hash and not one page hash.
    w.lib.resource("nano-3", "mangadex:9f2");
    w.log.clear();
    await settle(w);

    expect(w.engine.state).toBe("idle");
    expect(w.net.stats.bytesDelivered).toBe(before.bytes);
    expect(w.net.stats.imageCalls).toBe(before.images);
    // It resolved the chapter and the server had nothing to send.
    const resolves = w.log.of("resolve").filter((e) => e.chapterId === "c:nano-3");
    expect(resolves.length).toBe(1);
    expect(resolves[0]!.images).toBe(0);
    // And it took the new hash, so the next diff prunes the subtree instead of
    // re-offering it for ever.
    const now = w.engine.heldChapters().get("c:nano-3")!;
    expect(now.hash).not.toBe(oldHash);
    expect(now.pages.length).toBe(8);

    w.log.clear();
    await settle(w);
    expect(w.log.of("resolve").length).toBe(0);
  });

  test("a chapter that genuinely loses a page is re-resolved in full, not merged short", async () => {
    const w = makeWorld();
    await w.engine.setRules([keepSeries("s:solo")]);
    await settle(w);
    expect(w.engine.heldChapters().get("c:solo-4")!.pages.length).toBe(6);

    // A page-level `have` diff cannot express a deletion: `gone` filters `p:`
    // ids out entirely, so the reply comes back short and silent.
    w.lib.dropPage("solo-4", "003.jpg");
    await settle(w);

    const held = w.engine.heldChapters().get("c:solo-4")!;
    expect(held.pages.length).toBe(5);
    expect(held.pages.find((p) => p.file === "003.jpg")).toBeUndefined();
    expect(w.log.of("note").some((n) => n.text.includes("not reconstructable"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. treeVersion bumps
// ---------------------------------------------------------------------------

describe("5 — treeVersion bump", () => {
  test("drops the have set, deletes nothing, and transfers nothing", async () => {
    const w = makeWorld();
    await w.engine.setRules([keepSeries("s:nano")]);
    await settle(w);
    const bytes = w.net.stats.bytesDelivered;
    const heldBefore = [...w.engine.heldChapters().keys()].sort();

    // Every block id the client holds is about to appear in `gone`, and not one
    // byte moved on the server.
    w.lib.bumpTreeVersion();
    w.log.clear();
    await settle(w);

    expect(w.log.of("treeVersionChanged").length).toBeGreaterThan(0);
    expect(w.engine.state).toBe("idle");
    // The whole contract, in two assertions.
    expect([...w.engine.heldChapters().keys()].sort()).toEqual(heldBefore);
    expect(w.net.stats.bytesDelivered).toBe(bytes);
    // And the have set is rebuilt, so the NEXT diff is cheap again.
    expect(w.engine.buildHaveSet().find((h) => h.id === "s:nano")).toBeDefined();
  });

  test("`gone` under a version change is never read as a delete instruction", async () => {
    const w = makeWorld();
    await w.engine.setRules([keepSeries("s:nano")]);
    await settle(w);
    w.lib.bumpTreeVersion();
    await settle(w);
    expect(w.log.of("evict").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Two rules that disagree about the same chapter
// ---------------------------------------------------------------------------

describe("6 — rules that disagree", () => {
  const deleteWhenRead = (seriesId: string, priority: number): Rule => ({
    id: `dwr-${seriesId}`, label: `Delete ${seriesId} once read`,
    scope: { kind: "series", seriesId }, retention: { kind: "deleteWhenRead" },
    priority, lifetime: "standing",
  });

  test("a tie resolves towards holding the file, and is marked contested", async () => {
    const w = makeWorld();
    await w.engine.setRules([keepSeries("s:solo", 10), deleteWhenRead("s:solo", 10)]);
    await settle(w);
    await w.engine.markRead("c:solo-3", 6, 6);
    await settle(w);

    expect(w.engine.isHeld("c:solo-3")).toBe(true);
    const verdict = w.engine.currentTarget.want.get("c:solo-3")!;
    expect(verdict.contested).toBe(true);
    expect(verdict.contributors.length).toBe(2);
    expect(verdict.decidedBy).toBe("keep-s:solo");
  });

  test("an explicit priority wins outright, and the space comes back", async () => {
    const w = makeWorld();
    await w.engine.setRules([keepSeries("s:solo", 10), deleteWhenRead("s:solo", 20)]);
    await settle(w);
    await w.engine.markRead("c:solo-3", 6, 6);
    await settle(w);

    expect(w.engine.isHeld("c:solo-3")).toBe(false);
    expect(w.log.of("evict").some((e) => e.chapterId === "c:solo-3")).toBe(true);
    // Everything else it did not read is still there.
    expect(w.engine.heldChapters().size).toBe(12);
  });

  test("the more specific rule wins a priority tie", async () => {
    const w = makeWorld();
    await w.engine.setRules([
      deleteWhenRead("s:solo", 10),
      { id: "pin-3", label: "Pin chapter 3", priority: 10, lifetime: "standing",
        scope: { kind: "chapter", seriesId: "s:solo", chapterId: "c:solo-3" },
        retention: { kind: "pin" } },
    ]);
    await settle(w);
    await w.engine.markRead("c:solo-3", 6, 6);
    await settle(w);

    expect(w.engine.isHeld("c:solo-3")).toBe(true);
    expect(w.engine.currentTarget.want.get("c:solo-3")!.decidedBy).toBe("pin-3");
  });

  test("a rolling unread window holds a part-read chapter outside the quota", async () => {
    const w = makeWorld();
    await w.engine.setRules([{
      id: "window", label: "Keep 3 unread", priority: 10, lifetime: "standing",
      scope: { kind: "unreadWindow", seriesId: "s:solo", count: 3 },
      retention: { kind: "keep" },
    }]);
    await settle(w);
    expect(w.engine.heldChapters().size).toBe(3);

    // Start chapter 0 without finishing it. The window rolls past nothing.
    await w.engine.markRead("c:solo-0", 2, 6);
    await settle(w);
    expect(w.engine.isHeld("c:solo-0")).toBe(true);
    expect(w.engine.heldChapters().size).toBe(4); // 3 unread + 1 part-read

    // Finish it and the window moves on by exactly one.
    await w.engine.markRead("c:solo-0", 6, 6);
    await settle(w);
    expect(w.engine.isHeld("c:solo-0")).toBe(false);
    expect(w.engine.heldChapters().size).toBe(3);
  });

  test("a rule waiting on wifi is skipped with a reason, never silently", async () => {
    const w = makeWorld({ wifi: false });
    await w.engine.setRules([{
      ...keepSeries("s:nano"), conditions: { requiresUnmetered: true },
    }]);
    await settle(w);

    expect(w.engine.heldChapters().size).toBe(0);
    expect(w.engine.currentTarget.skipped[0]!.reason).toMatch(/unmetered/);

    w.conditions.wifi = true;
    await w.engine.setRules(w.engine.rulesNow());
    await settle(w);
    expect(w.engine.heldChapters().size).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 7. Interrupted mid-chapter
// ---------------------------------------------------------------------------

describe("7 — interrupted mid-chapter", () => {
  test("a partial page set is never presented as held, and survives a restart", async () => {
    const w = makeWorld();
    await w.engine.setRules([keepSeries("s:nano")]);
    w.net.set({ dieAfterImages: 3 });
    await settle(w, 3);

    // Three pages of an eight-page chapter are on the device.
    expect(w.engine.heldChapters().size).toBe(0);
    expect(await w.content.listHeld()).toEqual([]);
    const stagedChapters = await w.content.stagedChapters();
    expect(stagedChapters.length).toBe(1);
    expect(w.content.stagedCount(stagedChapters[0]!)).toBe(3);

    // The app is killed. Durable state comes back; the engine object does not.
    const revived = w.restart();
    await revived.load();
    expect(revived.isHeld(stagedChapters[0]!)).toBe(false);
    expect(revived.heldChapters().size).toBe(0);

    w.net.revive();
    await settle(w);

    expect(w.engine.heldChapters().size).toBe(30);
    // The three staged pages were not fetched again.
    expect(w.net.refetched()).toEqual([]);
    const first = w.engine.heldChapters().get(stagedChapters[0]!)!;
    expect(first.pages.length).toBe(8);
    expect(await w.content.stagedChapters()).toEqual([]);
  });

  test("a body that dies halfway is not stored, and is retried whole", async () => {
    const w = makeWorld();
    await w.engine.setRules([{
      id: "one", label: "One chapter", priority: 5, lifetime: "once",
      scope: { kind: "chapter", seriesId: "s:solo", chapterId: "c:solo-1" },
      retention: { kind: "keep" },
    }]);
    w.net.set({ truncateImages: true });
    await settle(w, 3);

    expect(w.engine.heldChapters().size).toBe(0);
    // Half a page was delivered and none of it kept.
    expect(w.net.stats.bytesDelivered).toBeGreaterThan(0);
    expect(w.content.bytesFor("c:solo-1")).toBe(0);

    w.net.revive();
    await settle(w);

    const held = w.engine.heldChapters().get("c:solo-1")!;
    expect(held.pages.length).toBe(6);
    expect(held.bytes).toBe(held.pages.reduce((n, p) => n + p.size, 0));
  });

  test("a flaky connection completes, eventually, and repeats no work", async () => {
    const w = makeWorld({ network: { failureRate: 0.3, seed: 42 }, backoff: [10, 10, 10] });
    await w.engine.setRules([keepSeries("s:solo")]);
    await settle(w, 200);

    expect(w.engine.state).toBe("idle");
    expect(w.engine.heldChapters().size).toBe(13);
    expect(w.net.stats.failures).toBeGreaterThan(0);
    expect(w.net.refetched()).toEqual([]);
  });
});
