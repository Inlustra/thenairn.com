// target set + what is held -> fetch plan + evict plan.
//
// The second half of the pipeline in docs/rules.md. It is deliberately pure:
// no network, no clock, no storage. Given the same three inputs it produces the
// same two lists, which is what makes the scenario tests worth writing.

import type { Catalog, EvictCandidate, FetchItem, HeldChapter, Plan, ReadMark, TargetSet } from "./types";

export interface PlanInput {
  catalog: Catalog;
  target: TargetSet;
  held: Map<string, HeldChapter>;
  root: string;
  treeVersion: number;
  readMark?: (chapterId: string) => ReadMark;
  now?: number;
}

/** Bytes per page, when nothing better is known. Live library measures ~330 KB. */
const FALLBACK_PAGE_BYTES = 330_000;

/**
 * Estimate from what this device has actually seen, not from a constant.
 *
 * A plan's byte estimate is what eviction is sized against, so a device that
 * has been running for a while should stop guessing. One series of dense colour
 * webtoon pages and one of scanned black-and-white differ by 5x.
 */
export function estimatePageBytes(held: Iterable<HeldChapter>): number {
  let bytes = 0, pages = 0;
  for (const h of held) { bytes += h.bytes; pages += h.pages.length; }
  return pages > 0 ? Math.round(bytes / pages) : FALLBACK_PAGE_BYTES;
}

export function buildPlan(input: PlanInput): Plan {
  const perPage = estimatePageBytes(input.held.values());
  const fetch: FetchItem[] = [];

  for (const [chapterId, verdict] of input.target.want) {
    const series = input.catalog.series.get(verdict.seriesId);
    const ch = series?.chapters.get(chapterId);
    if (!ch) continue;
    const have = input.held.get(chapterId);

    if (have && have.hash === ch.hash) continue; // in step

    fetch.push({
      chapterId,
      seriesId: verdict.seriesId,
      hash: ch.hash,
      priority: verdict.priority,
      // A repair may transfer nothing at all -- see the resolve step, which
      // sends page-level `have`. Estimating it at full size would evict content
      // to make room for bytes that never arrive, so a repair estimates zero
      // and the fetcher checks free space again once it knows the real list.
      estimatedBytes: have ? 0 : ch.pageCount * perPage,
      pageCount: ch.pageCount,
      reason: have ? "repair" : "missing",
    });
  }

  // Highest priority first, then the smallest chapter, so a constrained device
  // gets something readable rather than one enormous chapter half-fetched.
  fetch.sort((a, b) => (b.priority - a.priority) || (a.estimatedBytes - b.estimatedBytes) || a.chapterId.localeCompare(b.chapterId));

  const readMark = input.readMark ?? (() => "unread" as ReadMark);
  const scored: Array<EvictCandidate & { tier: number; sub: number }> = [];

  for (const held of input.held.values()) {
    const verdict = input.target.want.get(held.chapterId);
    if (verdict?.retention.kind === "pin") continue; // never a candidate, at any pressure

    let tier: number, reason: string;
    if (!verdict && !input.target.released.has(held.chapterId)) {
      tier = 0;
      reason = "no rule mentions it";
    } else if (!verdict) {
      tier = 1;
      reason = input.target.released.get(held.chapterId)!.reason;
    } else {
      tier = 2;
      reason = `wanted by ${held.chapterId === verdict.chapterId ? verdict.decidedBy : "a rule"} at priority ${verdict.priority}`;
    }

    // Within a tier: lowest rule priority first, then read before unread, then
    // the oldest arrival. "Read" going first is the only place read state gets
    // to influence eviction, and it is the right place -- a chapter you have
    // finished is the cheapest thing on the device to lose.
    const sub = (verdict?.priority ?? -1) * 1_000_000
      + (readMark(held.chapterId) === "read" ? 0 : 500_000)
      + Math.min(499_999, Math.floor(held.completedAt / 1000) % 500_000);

    scored.push({ chapterId: held.chapterId, seriesId: held.seriesId, bytes: held.bytes, rank: 0, reason, tier, sub });
  }

  scored.sort((a, b) => (a.tier - b.tier) || (a.sub - b.sub) || a.chapterId.localeCompare(b.chapterId));
  const evictCandidates: EvictCandidate[] = scored.map((c, i) => ({
    chapterId: c.chapterId, seriesId: c.seriesId, bytes: c.bytes, rank: i, reason: c.reason,
  }));

  return {
    builtAgainstRoot: input.root,
    treeVersion: input.treeVersion,
    fetch,
    evictCandidates,
    netBytes: fetch.reduce((n, f) => n + f.estimatedBytes, 0),
  };
}

/**
 * How much can be freed without touching content a rule still wants.
 *
 * The split matters: freeing tier 0 and 1 is housekeeping, and freeing tier 2
 * is the rolling-window policy that rules.md leaves unsettled. The engine is
 * given both numbers and a policy flag, and never quietly picks.
 */
export function freeable(plan: Plan, target: TargetSet): { unwanted: number; wanted: number } {
  let unwanted = 0, wanted = 0;
  for (const c of plan.evictCandidates) {
    if (target.want.has(c.chapterId)) wanted += c.bytes;
    else unwanted += c.bytes;
  }
  return { unwanted, wanted };
}
