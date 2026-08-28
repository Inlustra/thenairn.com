/**
 * One rule: "keep the N most recent unread chapters of series X".
 *
 * `rules.md` designs four dimensions and a dozen rule shapes. This evaluates
 * exactly one of them, because R-11 -- "a phone holds a useful subset" -- is
 * unevaluable while read state is discarded, and one rolling window is the
 * smallest thing that makes it evaluable at all.
 *
 * -------------------------------------------------------------------------
 * The window is chapter-level and has three states, not two
 * -------------------------------------------------------------------------
 * A chapter is unread, part-read or read. The N in the rule counts *unread*
 * chapters; a part-read chapter is held **outside the quota**. So "keep 10
 * unread" holds 10 chapters, or 11 while one is open. That off-by-one is the
 * design, not a rounding error, and it exists because both two-state collapses
 * have a bug you can watch happen:
 *
 *   Count part-read as unread. The chapter under your finger occupies a slot in
 *   its own window. Open one and the window's far edge retreats; close it and
 *   the edge advances again. The set churns in response to reading, which is
 *   the one activity it is supposed to be insulated from -- and every churn is
 *   a fetch or a delete on a phone.
 *
 *   Count part-read as read. The chapter you are halfway through is finished as
 *   far as the rule is concerned, so it is an eviction candidate immediately.
 *   Under storage pressure the file gets deleted while it is open.
 *
 * Three states costs one extra chapter of storage and removes both.
 *
 * -------------------------------------------------------------------------
 * `next`, not `latest`
 * -------------------------------------------------------------------------
 * Both are implemented; `next` is the default. Comics are read in order, so a
 * reader who is 60 chapters behind and asks to "keep 10 unread" wants the ten
 * they can read next, not the ten most recently published -- `latest` hands
 * them ten chapters they cannot open without spoiling sixty. For a caught-up
 * reader the unread set is smaller than the window and the two modes return
 * exactly the same chapters, so the difference only ever shows up in the case
 * where it matters.
 */
import type { Progress, ReadState } from "./store";
import { classify, DEFAULT_READER, type ReadStateStore } from "./store";

/**
 * What the resolver needs to know about a chapter. Deliberately not `Chapter`
 * from types.ts: the rule must be evaluable from anything that can enumerate a
 * series -- the scanner cache, the sidecar importer, or a synthetic catalogue.
 */
export interface ChapterRef {
  /** Identity of record. `paperbox.json` uid, else pathUid(series, chapter). */
  uid: string;
  dir: string;
  label: string;
  /** Ordering key. See docs/decisions.md -- stored, never re-derived. */
  sortKey: number;
  sortKeyEnd?: number;
  sequence: string;
  pages: number;
}

export type WindowMode = "next" | "latest";

export interface RuleInput {
  seriesUid: string;
  chapters: ChapterRef[];
  /** How many unread chapters to keep. */
  keep: number;
  reader?: string;
  /** Default "next". */
  mode?: WindowMode;
  /** Chapter uids the device currently holds. */
  held?: Iterable<string>;
}

export interface RuleResult {
  reader: string;
  seriesUid: string;
  mode: WindowMode;
  keep: number;
  /** The N unread chapters the rule selects. */
  window: ChapterRef[];
  /** Held because they are open. Outside the quota -- hence keep or keep+1. */
  partRead: ChapterRef[];
  /** window + partRead, in reading order. The target set. */
  target: ChapterRef[];
  /** In the target, not held. The fetch plan. */
  missing: ChapterRef[];
  /**
   * Held, not in the target.
   *
   * **A list, not an instruction.** `rules.md` records an unresolved
   * contradiction: "keep on this phone" was designed adds-only and never
   * deletes, while a rolling window implies dropping what has been read. Both
   * cannot be true, and it is not this function's place to pick. Naming these
   * "candidates" and returning them is what lets the caller implement either
   * policy -- or show the user the list and let them decide -- without the
   * resolver having quietly settled it.
   */
  evictCandidates: ChapterRef[];
  counts: { chapters: number; unread: number; partRead: number; read: number };
}

/**
 * Reading order: sequence, then key, then label.
 *
 * `sequence` sorts first because `Episode 001` and `Spin-off #001` are both
 * legitimately chapter 1 (R-28) and interleaving them by number alone produces
 * a reading order nobody has. `label` breaks the remaining ties so the order is
 * total and therefore stable across runs -- an unstable order would make the
 * window's edge chapter change identity for no reason.
 */
export function compareChapters(a: ChapterRef, b: ChapterRef): number {
  if (a.sequence !== b.sequence) return a.sequence < b.sequence ? -1 : 1;
  if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/** Reading order with the main sequence first, whatever it sorts as. */
function readingOrder(chapters: ChapterRef[]): ChapterRef[] {
  return [...chapters].sort((a, b) => {
    if (a.sequence !== b.sequence) {
      if (a.sequence === "main") return -1;
      if (b.sequence === "main") return 1;
    }
    return compareChapters(a, b);
  });
}

export interface ResolveDeps {
  /** Anything that can answer "what does this reader's row say". */
  progressFor(seriesUid: string, reader: string): Map<string, Progress>;
}

/** A store is the normal source; the bench and tests can supply a map directly. */
export function fromStore(store: ReadStateStore): ResolveDeps {
  return { progressFor: (seriesUid, reader) => store.forSeries(seriesUid, reader) };
}

export function fromMap(map: Map<string, Progress>): ResolveDeps {
  return { progressFor: () => map };
}

/**
 * Evaluate the rule.
 *
 * Cost is O(series), not O(catalogue): one indexed read of this series' rows,
 * one sort of this series' chapters. Nothing here touches another series, and
 * the query plan is asserted in readstate.scale.test.ts so it stays that way.
 */
export function resolveWindow(deps: ResolveDeps, input: RuleInput): RuleResult {
  const reader = input.reader ?? DEFAULT_READER;
  const mode: WindowMode = input.mode ?? "next";
  const keep = Math.max(0, Math.trunc(input.keep));
  const progress = deps.progressFor(input.seriesUid, reader);
  const ordered = readingOrder(input.chapters);

  const states = new Map<string, ReadState>();
  const unread: ChapterRef[] = [];
  const partRead: ChapterRef[] = [];
  let readCount = 0;
  for (const ch of ordered) {
    const state = classify(progress.get(ch.uid));
    states.set(ch.uid, state);
    if (state === "unread") unread.push(ch);
    else if (state === "part-read") partRead.push(ch);
    else readCount++;
  }

  // `next` takes the first N in reading order -- the ones immediately ahead of
  // wherever the reader is. `latest` takes the last N. They coincide exactly
  // when unread.length <= keep, which is what "caught up" means.
  const window = mode === "latest" ? unread.slice(Math.max(0, unread.length - keep)) : unread.slice(0, keep);

  const targetIds = new Set<string>([...window, ...partRead].map((c) => c.uid));
  const target = ordered.filter((c) => targetIds.has(c.uid));

  const held = new Set(input.held ?? []);
  const missing = target.filter((c) => !held.has(c.uid));
  // Only chapters we can see. A held id that is not in this series' chapter
  // list is not evidence that it should be deleted -- it is much more likely
  // evidence of a scan that has not run, and deleting on that basis is how a
  // transient failure turns into data loss.
  const evictCandidates = ordered.filter((c) => held.has(c.uid) && !targetIds.has(c.uid));

  return {
    reader,
    seriesUid: input.seriesUid,
    mode,
    keep,
    window,
    partRead,
    target,
    missing,
    evictCandidates,
    counts: {
      chapters: ordered.length,
      unread: unread.length,
      partRead: partRead.length,
      read: readCount,
    },
  };
}

/**
 * The sentence `rules.md` says a rule must be able to show: "right now this
 * means ch. 297-306". Byte totals are not available (R-24); chapter labels are.
 */
export function ruleSentence(r: RuleResult): string {
  if (r.target.length === 0) return `keep ${r.keep} unread — nothing to hold`;
  const first = r.target[0]!.label;
  const last = r.target[r.target.length - 1]!.label;
  const span = r.target.length === 1 ? first : `${first} … ${last}`;
  const open = r.partRead.length ? `, ${r.partRead.length} open` : "";
  return `keep ${r.keep} unread (${r.mode}) — ${r.target.length} chapters: ${span}${open}`;
}
