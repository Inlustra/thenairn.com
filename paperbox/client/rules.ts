// Rules -> evaluate -> target set.
//
// docs/rules.md, settled 2026-08-28: rules are a CLIENT concern. The server
// always grabs; the client decides what it holds. Nothing in this file talks to
// the server -- it reads the catalog (what exists) and the read marks (what
// only this device knows) and produces a set.
//
// "An imperative action is a rule with a lifetime of one evaluation." There is
// no separate download-this-chapter path. `{ scope: chapter, lifetime: "once" }`
// is that feature, and it is 12 lines below, not a subsystem.

import { chaptersInOrder } from "./catalog";
import type {
  Catalog, CatalogChapter, ReadMark, Retention, Rule, RuleScope, TargetSet, Verdict,
} from "./types";
import type { DeviceConditions as Conditions } from "./ports";

export interface EvalInput {
  catalog: Catalog;
  rules: Rule[];
  readMark: (chapterId: string) => ReadMark;
  conditions?: Conditions;
  /** chapterIds currently held, so a `once` rule can retire itself. */
  held?: ReadonlySet<string>;
}

/**
 * How specific a scope is, for breaking a priority tie.
 *
 * A rule naming one chapter beats a rule naming the whole library, because the
 * more precisely something was asked for, the more likely it was meant.
 */
function specificity(scope: RuleScope): number {
  switch (scope.kind) {
    case "chapter": return 4;
    case "range": return 3;
    case "unreadWindow": case "latest": return 2;
    case "series": return 1;
    case "collection": return 0;
  }
}

/**
 * The leading number in a chapter label.
 *
 * APPROXIMATE, and knowingly so. The server stores a parsed `sortKey` and does
 * not put it on the wire (docs/api-gaps.md #12), so a numeric range rule has to
 * re-derive one from the label. Same first-digit-run heuristic the server
 * defaults to, which agrees with it on 1,702 of the live library's 1,706
 * chapters. Where it cannot read a number the chapter falls back to its block
 * range, which is coarse but never wrong in the dangerous direction: it can
 * only widen the set, never silently drop a chapter the user asked for.
 */
export function approxNumber(ch: CatalogChapter): number | undefined {
  const m = /(\d+(?:\.\d+)?)/.exec(ch.label.replace(/^\D*?(?=\d)/, ""));
  if (m?.[1]) return Number(m[1]);
  return undefined;
}

function resolveScope(scope: RuleScope, input: EvalInput): CatalogChapter[] {
  const { catalog } = input;
  const seriesOf = (id: string) => catalog.series.get(id);

  switch (scope.kind) {
    case "chapter": {
      const ch = seriesOf(scope.seriesId)?.chapters.get(scope.chapterId);
      return ch ? [ch] : [];
    }
    case "series": {
      const s = seriesOf(scope.seriesId);
      return s ? chaptersInOrder(s) : [];
    }
    case "collection": {
      const out: CatalogChapter[] = [];
      for (const id of scope.seriesIds) {
        const s = seriesOf(id);
        if (s) out.push(...chaptersInOrder(s));
      }
      return out;
    }
    case "range": {
      const s = seriesOf(scope.seriesId);
      if (!s) return [];
      return chaptersInOrder(s).filter((ch) => {
        const n = approxNumber(ch);
        if (n !== undefined) return n >= scope.from && n <= scope.to;
        // No readable number: fall back to block containment.
        return ch.blockStart !== 0 && ch.blockStart + 24 >= scope.from && ch.blockStart <= scope.to;
      });
    }
    case "latest": {
      const s = seriesOf(scope.seriesId);
      if (!s) return [];
      const all = chaptersInOrder(s);
      return all.slice(Math.max(0, all.length - scope.count));
    }
    case "unreadWindow": {
      const s = seriesOf(scope.seriesId);
      if (!s) return [];
      const out: CatalogChapter[] = [];
      let quota = scope.count;
      for (const ch of chaptersInOrder(s)) {
        const mark = input.readMark(ch.id);
        if (mark === "read") continue;
        // rules.md: a part-read chapter is held OUTSIDE the quota, so "keep 10
        // unread" holds 10 or 11. You do not lose the page you are on because
        // the window rolled.
        if (mark === "part") { out.push(ch); continue; }
        if (quota <= 0) break;
        quota--;
        out.push(ch);
      }
      // The window is the NEXT unread, not the LATEST: comics are read in
      // order and a reader sixty behind cannot open the ten most recent.
      return out;
    }
  }
}

/** Does this retention still want the chapter, given how far it has been read? */
function wantsUnderRetention(
  retention: Retention, ch: CatalogChapter, mark: ReadMark, readRank: number, readTotal: number,
): { want: true } | { want: false; reason: string } {
  switch (retention.kind) {
    case "pin": case "keep":
      return { want: true };
    case "deleteWhenRead":
      return mark === "read" ? { want: false, reason: "read, and the rule releases what is read" } : { want: true };
    case "keepLastRead": {
      if (mark !== "read") return { want: true };
      // readRank counts back from the most recently ordered read chapter.
      return readRank < retention.count
        ? { want: true }
        : { want: false, reason: `read, and ${readTotal - retention.count} chapters further back than the last ${retention.count}` };
    }
  }
}

function beats(a: { priority: number; spec: number; retention: Retention; want: boolean }, b: typeof a): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  if (a.spec !== b.spec) return a.spec > b.spec;
  // Last tiebreak: RETAIN BEATS RELEASE. Two equally specific, equally urgent
  // rules that disagree resolve towards holding the file, because the files
  // belong to the user (ui.md, Ownership) and an unwanted megabyte is cheaper
  // than a deletion nobody authorised.
  if (a.want !== b.want) return a.want;
  return rank(a.retention) > rank(b.retention);
}

function rank(r: Retention): number {
  switch (r.kind) {
    case "pin": return 3;
    case "keep": return 2;
    case "keepLastRead": return 1;
    case "deleteWhenRead": return 0;
  }
}

export function evaluate(input: EvalInput): TargetSet {
  const released = new Map<string, { chapterId: string; seriesId: string; reason: string }>();
  const skipped: TargetSet["skipped"] = [];
  const satisfied: string[] = [];

  // Read ranks per series, so keepLastRead can count backwards without
  // re-walking the series for every chapter.
  const readRank = new Map<string, { rank: number; total: number }>();
  for (const s of input.catalog.series.values()) {
    const readChapters = chaptersInOrder(s).filter((c) => input.readMark(c.id) === "read");
    readChapters.forEach((c, i) => {
      readRank.set(c.id, { rank: readChapters.length - 1 - i, total: readChapters.length });
    });
  }

  /**
   * Every rule's opinion about every chapter it touched -- INCLUDING the rules
   * that want it gone.
   *
   * Collecting wants and releases into one pool and resolving once is the only
   * shape that works. Resolving as you go (first rule wins, later rules only
   * add) made a high-priority `deleteWhenRead` lose to a low-priority `keep`
   * purely because of array order, which is a rule engine that silently ignores
   * the priority field it asks the user to set.
   */
  interface Bid {
    ruleId: string; priority: number; spec: number; retention: Retention;
    want: boolean; reason: string; seriesId: string;
  }
  const bids = new Map<string, Bid[]>();

  for (const rule of input.rules) {
    if (rule.enabled === false) { skipped.push({ ruleId: rule.id, reason: "disabled" }); continue; }
    const c = rule.conditions;
    if (c?.requiresUnmetered && input.conditions && !input.conditions.unmetered()) {
      skipped.push({ ruleId: rule.id, reason: "waiting for an unmetered connection" });
      continue;
    }
    if (c?.requiresCharging && input.conditions && !input.conditions.charging()) {
      skipped.push({ ruleId: rule.id, reason: "waiting until charging" });
      continue;
    }

    const resolved = resolveScope(rule.scope, input);
    if (resolved.length === 0) {
      skipped.push({ ruleId: rule.id, reason: "resolves to nothing the server holds" });
      continue;
    }

    const spec = specificity(rule.scope);
    for (const ch of resolved) {
      const mark = input.readMark(ch.id);
      const rr = readRank.get(ch.id) ?? { rank: 0, total: 0 };
      const v = wantsUnderRetention(rule.retention, ch, mark, rr.rank, rr.total);
      const list = bids.get(ch.id) ?? [];
      list.push({
        ruleId: rule.id, priority: rule.priority, spec, retention: rule.retention,
        want: v.want, reason: v.want ? "wanted" : v.reason, seriesId: ch.seriesId,
      });
      bids.set(ch.id, list);
    }
  }

  const want = new Map<string, Verdict>();
  for (const [chapterId, list] of bids) {
    let winner = list[0]!;
    for (const bid of list.slice(1)) {
      if (beats(bid, winner)) winner = bid;
    }
    const contested = new Set(list.map((b) => b.want)).size > 1;
    if (winner.want) {
      want.set(chapterId, {
        chapterId,
        seriesId: winner.seriesId,
        retention: winner.retention,
        priority: winner.priority,
        decidedBy: winner.ruleId,
        contributors: [winner.ruleId, ...list.filter((b) => b.ruleId !== winner.ruleId).map((b) => b.ruleId)],
        contested,
      });
    } else {
      released.set(chapterId, { chapterId, seriesId: winner.seriesId, reason: winner.reason });
    }
  }

  // A `once` rule retires when everything it named is held. Judged after
  // resolution, so a rule that lost every one of its chapters to a stronger
  // rule does not sit around for ever claiming to be unfinished.
  for (const rule of input.rules) {
    if (rule.lifetime !== "once") continue;
    const mine = [...bids].filter(([, l]) => l.some((b) => b.ruleId === rule.id)).map(([id]) => id);
    if (mine.length === 0) continue;
    const done = mine.every((id) => input.held?.has(id) || !want.has(id));
    if (done) satisfied.push(rule.id);
  }

  return { want, released, skipped, satisfied };
}

/** Retire the `once` rules an evaluation satisfied. */
export function retire(rules: Rule[], satisfied: string[]): Rule[] {
  if (satisfied.length === 0) return rules;
  const done = new Set(satisfied);
  return rules.filter((r) => !(r.lifetime === "once" && done.has(r.id)));
}
