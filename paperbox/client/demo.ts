// A device syncing, losing signal, recovering, filling up, and evicting.
//
//   bun run client/demo.ts
//
// Everything here is fake and deterministic: the clock is injected, the network
// is a switch, the library is an object in memory. Run it twice and you get the
// same words. That is the point -- this is the behaviour you would otherwise
// only see on a real phone in a real tunnel.

import { makeWorld, settle } from "./sim/harness";
import type { World } from "./sim/harness";
import { buildLibrary } from "./sim/server";
import type { Rule } from "./types";

const MB = 1_000_000;
const mb = (n: number) => `${(n / MB).toFixed(1)} MB`;
const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
const rpad = (s: string, n: number) => s.length >= n ? s : " ".repeat(n - s.length) + s;

let step = 0;
function scene(title: string) {
  step++;
  console.log(`\n${"─".repeat(72)}`);
  console.log(`  ${step}. ${title}`);
  console.log(`${"─".repeat(72)}`);
}
const say = (s = "") => console.log(`     ${s}`);

/**
 * The shelf, in the state language: ink is what survives unplugging, pencil is
 * intent. On a phone that distinction is the whole product, so the demo prints
 * it rather than printing a percentage.
 */
function shelf(w: World) {
  for (const series of w.lib.series) {
    const chapters = series.chapters.map((c) => `c:${c.uid}`);
    const wanted = w.engine.currentTarget.want;
    const marks = chapters.map((id) => (w.engine.isHeld(id) ? "█" : wanted.has(id) ? "▒" : "·")).join("");
    const held = chapters.filter((id) => w.engine.isHeld(id)).length;
    const want = chapters.filter((id) => wanted.has(id)).length;
    say(`${pad(series.title, 30)} ${pad(marks, 32)} ${rpad(`${held}/${want || chapters.length}`, 7)}`);
  }
  say(`${pad("", 30)} █ ink, on the device   ▒ pencil, wanted   · not asked for`);
}

function storage(w: World, capacity: number) {
  const used = [...w.engine.heldChapters().values()].reduce((n, h) => n + h.bytes, 0);
  const filled = Math.round((used / capacity) * 40);
  say(`storage   [${"█".repeat(filled)}${"·".repeat(Math.max(0, 40 - filled))}] ${mb(used)} of ${mb(capacity)}`);
}

const CAPACITY = 20 * MB;

const rules: Rule[] = [
  { id: "commute", label: "The next 6 unread of Nano Machine", priority: 30, lifetime: "standing",
    scope: { kind: "unreadWindow", seriesId: "s:nano", count: 6 }, retention: { kind: "keep" } },
  { id: "solo", label: "Everything of Solo Leveling", priority: 10, lifetime: "standing",
    scope: { kind: "series", seriesId: "s:solo" }, retention: { kind: "keep" } },
  { id: "pin", label: "Pin the Warhammer one-shot", priority: 5, lifetime: "standing",
    scope: { kind: "chapter", seriesId: "s:wh40k", chapterId: "c:wh40k-full" }, retention: { kind: "pin" } },
];

async function main() {
  const lib = buildLibrary();
  const w = makeWorld({
    library: lib, capacityBytes: CAPACITY, policy: "rolling",
    network: { latencyMs: 120 }, backoff: [60_000, 120_000],
  });

  console.log("\n  PAPERBOX — the client sync engine, on a fake phone");
  console.log("  No network, no wall clock, no filesystem. Deterministic end to end.");

  scene("What the server has, and what this phone was told to keep");
  for (const s of lib.series) {
    const pages = s.chapters.reduce((n, c) => n + c.pages.length, 0);
    const bytes = s.chapters.reduce((n, c) => n + c.pages.reduce((m, p) => m + p.size, 0), 0);
    say(`${pad(s.title, 34)} ${rpad(String(s.chapters.length), 3)} chapters  ${rpad(String(pages), 4)} pages  ${rpad(mb(bytes), 8)}`);
  }
  say();
  say(`device storage   ${mb(CAPACITY)}      eviction policy   rolling`);
  say();
  for (const r of rules) say(`rule  ${pad(r.label, 40)} priority ${r.priority}`);

  await w.engine.setRules(rules);

  scene("The first sync starts on a train, and the train enters a tunnel");
  // The server stops answering 63 image bodies in -- partway through a chapter.
  w.net.set({ dieAfterImages: 63 });
  await settle(w, 3);

  say(`the rules resolve to ${w.engine.currentTarget.want.size} chapters — that is what "keep 6 unread" means today`);
  say(`state          ${w.engine.state}, retrying in ${(60_000 / 1000).toFixed(0)}s`);
  say(`held           ${w.engine.heldChapters().size} chapters`);
  for (const id of await w.content.stagedChapters()) {
    say(`staged         ${id} — ${w.content.stagedCount(id)} pages on disk and NOT in the library`);
  }
  say();
  say("a half-fetched chapter is never shown as held. Its pages are kept, because");
  say("throwing them away is the only way to make the tunnel cost twice.");
  say();
  shelf(w);

  scene("Out of the tunnel");
  const before = w.net.stats.bytesDelivered;
  const callsBefore = w.net.stats.imageCalls;
  w.net.revive();
  // A new chapter landed while we were underground.
  lib.addChapter("nano", { uid: "nano-31", sortKey: 31, pages: Array.from({ length: 8 }, (_, i) => ({ file: `${String(i + 1).padStart(3, "0")}.jpg`, size: 118_000 })) });
  await settle(w);

  say(`resumed and finished: ${w.net.stats.imageCalls - callsBefore} more pages, ${mb(w.net.stats.bytesDelivered - before)}`);
  say(`pages fetched twice across the whole run: ${w.net.refetched().length}`);
  say();
  say("the resume asks page by page, not chapter by chapter, so the pages already");
  say("staged are the ones the server is told not to send.");
  say();
  say("chapter 31 of Nano Machine also landed while we were underground. The rule");
  say("asks for the next six UNREAD, not the six most recent, so it stays pencil:");
  say("a reader twenty-five chapters behind cannot open it.");
  say();
  shelf(w);
  say();
  storage(w, CAPACITY);

  scene("The server re-sources a chapter — same bytes, new provenance");
  const bytesBefore = w.net.stats.bytesDelivered;
  const hashBefore = w.engine.heldChapters().get("c:solo-4")!.hash;
  lib.resource("solo-4", "mangadex:9f2");
  await settle(w);
  say(`chapter hash   ${hashBefore}  ->  ${w.engine.heldChapters().get("c:solo-4")!.hash}`);
  say(`bytes moved    ${w.net.stats.bytesDelivered - bytesBefore}`);
  say();
  say("the chapter hash is a CHANGE SIGNAL; the page hashes are the CHANGE SET.");
  say("provenance lives under the chapter, so re-sourcing moves the first and not");
  say("the second. Asking page by page costs one round trip and no bytes at all.");

  scene("The reader finishes four chapters, and the window rolls");
  for (const n of [1, 2, 3, 4]) {
    const ch = lib.chapter(`nano-${n}`);
    if (ch) await w.engine.markRead(`c:nano-${n}`, ch.pages.length, ch.pages.length);
  }
  await settle(w);
  say(`the unread window moved on by four. Nothing was asked of the server to`);
  say(`work that out — read state is the one thing the phone owns outright.`);
  say();
  shelf(w);
  say();
  storage(w, CAPACITY);

  scene("A big series arrives, and the device is full");
  await w.engine.setRules([
    ...rules,
    { id: "orv", label: "Everything of Omniscient Reader's Viewpoint", priority: 40, lifetime: "standing",
      scope: { kind: "series", seriesId: "s:orv" }, retention: { kind: "keep" } },
  ]);
  await settle(w);
  const evicted = w.log.of("evict");
  say(`state          ${w.engine.state}`);
  if (w.engine.blockedReason) say(`because        ${w.engine.blockedReason}`);
  say(`evicted        ${evicted.length} chapters, ${mb(evicted.reduce((n, e) => n + e.bytes, 0))}`);
  for (const e of evicted.slice(-4)) say(`               ${pad(e.chapterId, 16)} ${e.reason}`);
  say();
  say(`the pinned one-shot is still here: ${w.engine.isHeld("c:wh40k-full")}`);
  say("a pin is never a candidate, at any pressure. Being full is a thing to say");
  say("out loud, not a reason to delete what someone asked you to keep.");
  say();
  shelf(w);
  say();
  storage(w, CAPACITY);

  scene("The server renames every block id — treeVersion 2 becomes 3");
  const heldBefore = w.engine.heldChapters().size;
  const bytes2 = w.net.stats.bytesDelivered;
  lib.bumpTreeVersion();
  await settle(w);
  say(`every block id this phone held is now in the server's \`gone\` list.`);
  say();
  say(`chapters held  ${heldBefore}  ->  ${w.engine.heldChapters().size}`);
  say(`bytes moved    ${w.net.stats.bytesDelivered - bytes2}`);
  say(`chapters deleted ${w.log.of("evict").length - evicted.length}`);
  say();
  say("a treeVersion change means DROP YOUR HAVE SET AND RE-DIFF. It never means");
  say("delete content. Nothing on disk moved -- only the names of the nodes did.");

  scene("The ledger");
  say(`tree calls     ${w.net.stats.treeCalls}`);
  say(`diff calls     ${w.net.stats.diffCalls}`);
  say(`image calls    ${w.net.stats.imageCalls}`);
  say(`delivered      ${mb(w.net.stats.bytesDelivered)}`);
  say(`failures       ${w.net.stats.failures}`);
  say(`fetched twice  ${w.net.refetched().length}`);
  say();
  say(`simulated time ${((w.clock.now() - 1_700_000_000_000) / 60_000).toFixed(1)} minutes, none of it real`);
  console.log();
}

await main();
