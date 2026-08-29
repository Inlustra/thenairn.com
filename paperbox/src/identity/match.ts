/**
 * The matcher — the one place a candidate is judged, and the only place a bar
 * is set.
 *
 * Two rules govern everything here, and both are settled elsewhere:
 *
 * **The bar for surfacing a candidate is "this might be correct."** A single
 * contradicting fact removes it entirely, silently, before it reaches a client.
 * A surfaced candidate therefore only ever carries `agree` and `unknown` rows —
 * there is no such thing as a rejected option on screen (docs/ui.md,
 * "Conclusions, not deliberation").
 *
 * **Confidence alone cannot gate silence.** Two of twelve real series matched
 * *wrong* at "high" confidence, so a name score may never, on its own, bind
 * anything. What binds is an **exact** match against a title the registry
 * itself curates — its canonical title or one of its alternative titles — with
 * no contradiction and no rival. Similarity gets you a question, never an
 * answer.
 *
 * Measured against the real library on 2026-08-29, this is not a theory:
 *
 * | folder | what the old harvest bound | what this binds |
 * |---|---|---|
 * | Omniscient Reader's Viewpoint | ORV (Novel), 42 ch — WRONG | "Omniscient Reader", 308 ch, exact alt title |
 * | Reincarnation of the Suicidal Battle God | Reincarnation of the Martial God — WRONG | "Doom Breaker", 101 ch, exact alt title |
 * | The Greatest Estate Developer | The Greatest Estate Developer (Novel), 0 ch — WRONG | "Yeokdaegeup Yeongji Seolgyesa", 222 ch, exact alt title |
 * | Warhammer 40,000 ×3 | nothing | nothing, and says a registry we have not connected could know it |
 *
 * All three wrong bindings were exact or near-exact on the *canonical* title.
 * All three right ones are exact on an *alternative* title of a record whose
 * canonical title looks nothing like the folder. That is the entire lesson.
 */

import type { EvidenceRow } from "./types";
import type { RegistryCard } from "./provider";

/**
 * Squash a title to its letters and digits.
 *
 * Not a space-separated normalisation: the real library contains
 * `Trash of the Counts Family` on disk against `Trash of the Count's Family`
 * upstream, and `Omniscient Reader's Viewpoint` with a curly apostrophe. Under
 * a token normalisation those are `counts` vs `count s` and do not match; with
 * punctuation removed outright they do. Diacritics are folded for the same
 * reason.
 */
export function squash(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function tokens(title: string): Set<string> {
  return new Set(
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      // Digit-group separators, before splitting: "Warhammer 40,000" must be
      // two tokens, not three. Left as three it shares the token "000" with
      // "10,000 Bon no Gomu" and "50,000節", which is how an unrelated record
      // clears a similarity floor.
      .replace(/(\d)[,\u066c\u2009 ](?=\d{3}\b)/g, "$1")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

/**
 * Dice coefficient over word sets, with an exact squash short-circuit.
 *
 * Deliberately crude. It has exactly one job: keep obviously-unrelated records
 * out of the candidate set, so that "we found nothing that even resembles this"
 * stays distinguishable from "we found things and disproved them". It never
 * decides an identity — see the header.
 */
export function nameScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (squash(a) === squash(b)) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/** Best score across the canonical title and every alternative title. */
export function bestName(card: RegistryCard, folderTitle: string): { score: number; via: string; exact: boolean } {
  let best = { score: 0, via: card.canonicalTitle, exact: false };
  const target = squash(folderTitle);
  for (const t of [card.canonicalTitle, ...card.altTitles]) {
    const exact = squash(t) === target && target.length > 0;
    const score = exact ? 1 : nameScore(t, folderTitle);
    if (score > best.score || (exact && !best.exact)) best = { score, via: t, exact };
    if (exact) break;
  }
  return best;
}

/**
 * A candidate has to at least resemble the name to be worth surfacing as a
 * question. Below this we did not find it — we found something else.
 *
 * **It is a floor on questions, not a signal about databases.** That was tried
 * and measured: the first design used "did anything resemble the name?" to tell
 * *we asked the wrong sort of registry* apart from *the right registry has no
 * record*. It does not survive contact with a fuzzy search. Asked for
 * "Warhammer 40,000", MangaUpdates returns "Versus Earth - War Hammer", whose
 * alternative titles include the bare word "Warhammer" — 0.5, comfortably over
 * any floor worth having, from a database that has never heard of Warhammer
 * 40,000. Whether an unconnected registry might know a series is answered by
 * *which slots are unconnected*, not by how junk scores.
 */
export const NAME_FLOOR = 0.4;

/**
 * How far past the registry's count we may hold before it is impossible rather
 * than merely stale.
 *
 * A registry lags: we hold 102 chapters of Doom Breaker and it lists 101, which
 * is normal and must not be a contradiction. We held 201 of ORV against a
 * record listing 42, which cannot be the same work. The band is generous on
 * purpose — a false contradiction is silent and permanent, a missed one only
 * costs a question.
 */
export function countImpossible(held: number, latest: number | null): boolean {
  if (latest === null || held <= 0) return false;
  if (latest === 0) return true;
  return held > latest * 1.5 + 5;
}

export interface Judgement {
  card: RegistryCard;
  score: number;
  via: string;
  exact: boolean;
  /** Any contradiction at all. The candidate is discarded, never shown. */
  contradicted: boolean;
  /** Only agree/unknown rows survive on a surfaced candidate. */
  evidence: EvidenceRow[];
}

/**
 * Weigh one card against one folder.
 *
 * Every fact here is free — it comes from a card we already fetched and a
 * chapter count the scan already holds. Nothing opens a page, nothing costs a
 * second request. Cheap contradictions are the point: they are what let a wrong
 * candidate be discarded before anybody is asked about it.
 */
export function judge(card: RegistryCard, folderTitle: string, held: number): Judgement {
  const { score, via, exact } = bestName(card, folderTitle);
  const rows: EvidenceRow[] = [];
  let contradicted = false;

  if (exact) {
    rows.push({
      fact: via === card.canonicalTitle ? "Listed under this exact name" : `Also known there as "${via}"`,
      verdict: "agree",
    });
  } else if (score >= NAME_FLOOR) {
    rows.push({ fact: `The name is close: "${via}"`, verdict: "agree" });
  }

  // A prose record against a directory of page images. The cheapest decisive
  // fact we have, and the one that caught two of three bad harvest proposals.
  if (card.kind === "prose") {
    rows.push({ fact: "It is a novel — these are pages of a comic", verdict: "contradict" });
    contradicted = true;
  }

  if (countImpossible(held, card.latestChapter)) {
    rows.push({
      fact:
        card.latestChapter === 0
          ? `It lists no chapters at all — you hold ${held}`
          : `It lists ${card.latestChapter} chapters — you hold ${held}`,
      verdict: "contradict",
    });
    contradicted = true;
  } else if (card.latestChapter !== null && card.latestChapter > 0) {
    rows.push({ fact: `You hold ${held} · it lists ${card.latestChapter}`, verdict: "agree" });
  }

  // Soft tension is recorded as unknown, never as doubt dressed up as a
  // verdict. The cover row is honest about a comparison we have not built.
  if (!contradicted) {
    rows.push({ fact: "Cover art not compared", verdict: "unknown" });
    if (card.latestChapter === null) {
      rows.push({ fact: "It keeps no chapter count", verdict: "unknown" });
    }
  }

  return { card, score, via, exact, contradicted, evidence: rows };
}

export type Outcome =
  | { kind: "identified"; winner: Judgement }
  | { kind: "guess"; winner: Judgement }
  /** Nothing survived. Whether that is permanent is not this function's call. */
  | { kind: "none" };

/**
 * Turn judged candidates into one conclusion.
 *
 * The order of these branches is the design:
 *
 *  1. Discard every contradiction, silently. What was ruled out is not news.
 *  2. Exactly one survivor matches an exact curated title -> bind it. There is
 *     nothing uncertain to ask about.
 *  3. More than one exact match -> a question. Ambiguity is genuine
 *     uncertainty, which is the one thing that earns an interruption.
 *  4. No exact match but something resembles -> a question, with its grounds.
 *  5. Nothing survived -> `none`. The caller turns that into `unconfigured` or
 *     `no-match` depending on whether every registry slot is actually
 *     connected, which is a fact about our configuration and not about this
 *     series.
 */
export function conclude(judged: Judgement[]): Outcome {
  const alive = judged.filter((j) => j.score >= NAME_FLOOR && !j.contradicted);

  const exact = alive.filter((j) => j.exact);
  if (exact.length === 1) return { kind: "identified", winner: exact[0]! };
  if (exact.length > 1) return { kind: "guess", winner: [...exact].sort(byStrength)[0]! };
  if (alive.length > 0) return { kind: "guess", winner: [...alive].sort(byStrength)[0]! };
  return { kind: "none" };
}

function byStrength(a: Judgement, b: Judgement): number {
  const corroborated = (j: Judgement) => (j.card.latestChapter !== null && j.card.latestChapter > 0 ? 1 : 0);
  return corroborated(b) - corroborated(a) || b.score - a.score;
}
