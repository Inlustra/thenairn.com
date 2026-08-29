/**
 * The provider abstraction — what a registry must supply to be treated
 * uniformly, and the four rules that make "uniformly" mean something.
 *
 * docs/upstream.md left three questions open. They are answered here and in
 * docs/decisions.md ("The provider abstraction"); this file is the executable
 * half.
 *
 * ---------------------------------------------------------------------------
 * 1. A provider reports. It never scores.
 * ---------------------------------------------------------------------------
 * No method here returns a confidence, a rank or a "best" anything. A provider
 * hands back cards; `match.ts` decides. This is not tidiness — two of twelve
 * series matched *wrong* at "high" confidence (docs/upstream.md, "Matching"),
 * and a per-provider score is a second place for that mistake to be made where
 * nobody would find it. One matcher, one bar, one place to fix it.
 *
 * ---------------------------------------------------------------------------
 * 2. Every field may be unknown, and unknown is never zero.
 * ---------------------------------------------------------------------------
 * `latestChapter: null` means the registry keeps no chapter records; `0` means
 * its records say zero. They produce *opposite* verdicts — null is silence and
 * removes the gap line entirely, 0 against a held library is a contradiction
 * that discards the candidate. A provider that collapses one into the other is
 * broken, and it would be broken invisibly.
 *
 * ---------------------------------------------------------------------------
 * 3. A registryId must be stable and re-queryable.
 * ---------------------------------------------------------------------------
 * `fetch(card.registryId)` must return that same work tomorrow. A provider that
 * cannot do this can be *believed* but never *bound*: nothing can refresh it,
 * so it can never say you are behind. `canRequery` states which kind a provider
 * is, out loud, because the interface renders the difference (ComicInfo.xml is
 * the believed-but-unbindable case, and it is deliberate rather than a defect).
 *
 * ---------------------------------------------------------------------------
 * 4. Normalisation happens at the provider boundary.
 * ---------------------------------------------------------------------------
 * `kind` and `status` are our vocabulary. MangaUpdates says "Manhwa" and
 * "Novel"; Comic Vine will say neither. The matcher must never learn a
 * provider's dialect, or every new provider becomes an edit to the matcher.
 * `typeLabel` keeps the provider's own word for display, because "Manhwa" is
 * worth showing and "comic" is not.
 */

/**
 * What sort of thing this is, in the only distinction the matcher acts on.
 *
 * `prose` is load-bearing: a novel record against a directory of page images is
 * the cheapest decisive contradiction we have, and it is the one that caught
 * two of the three bad harvest proposals.
 */
export type SeriesKind = "comic" | "prose" | "other" | "unknown";

/** The shared status vocabulary. A provider maps its own words onto this. */
export type RegistryStatus = "ongoing" | "hiatus" | "complete" | "unknown";

/**
 * One registry's account of one work, normalised.
 *
 * This is the whole surface the rest of the system sees. Adding a provider must
 * never mean adding a field here for that provider's benefit — if it does, the
 * field belongs in `raw` or nowhere.
 */
export interface RegistryCard {
  /** Provider slot id, e.g. "mangaupdates". */
  provider: string;
  /** Display name, e.g. "MangaUpdates". Shown to people. */
  providerName: string;
  /** Stable and re-queryable — rule 3. */
  registryId: string;
  canonicalTitle: string;
  /**
   * Every other title the registry knows this work by. Load-bearing, not
   * decoration: the correct record for "Omniscient Reader's Viewpoint" is
   * *titled* "Omniscient Reader", and the correct record for "Reincarnation of
   * the Suicidal Battle God" is titled "Doom Breaker". Both are exact matches
   * on an alternative title, and neither is reachable by comparing titles.
   */
  altTitles: string[];
  kind: SeriesKind;
  /** The provider's own word, for display only. Never matched on. */
  typeLabel: string | null;
  status: RegistryStatus;
  /** The denominator in "you hold 313 of 327". null ≠ 0 — see rule 2. */
  latestChapter: number | null;
  cadenceDays: number | null;
  cadenceLabel: string | null;
  /**
   * Confirmed season boundaries. **A provider never fills this in.** On
   * MangaUpdates seasons exist solely as markdown prose in a free-text
   * `status` field, so they are evidence for a person, never an automatic
   * import (docs/decisions.md). This is populated from the stored binding
   * after somebody said yes, and it is empty until then.
   */
  seasons: { name: string; endAfterSortKey: number }[];
  /**
   * What the provider *thinks* the seasons are, and where it read that. Offered
   * for confirmation; never rendered as fact. Kept separate from `seasons` so
   * that the difference between "parsed out of prose" and "a person agreed"
   * cannot be lost by a careless assignment.
   */
  seasonHints: { name: string; endAfterSortKey: number; from: string }[];
  nativeTitle?: string;
  year?: number;
  url?: string;
  /** ISO date this card was read. The freshness stamp the UI shows verbatim. */
  asOf: string;
}

/**
 * Which family of works a provider knows about.
 *
 * Not a genre taxonomy — it exists for exactly one sentence: *"a registry we
 * have not connected could know this"*. Our three Warhammer titles are western
 * comics, and no manga database will ever hold them.
 */
export type ProviderDomain = "manga" | "western" | "embedded";

export interface ProviderStatus {
  id: string;
  name: string;
  domain: ProviderDomain;
  configured: boolean;
  canRequery: boolean;
  /** What is missing, in the user's terms. Empty when configured. */
  requirement: string;
}

export interface RegistryProvider {
  readonly id: string;
  readonly name: string;
  readonly domain: ProviderDomain;
  /**
   * Whether this provider can be re-asked about a work it identified.
   * false means "believable, not bindable" — see rule 3.
   */
  readonly canRequery: boolean;
  /**
   * False means the slot exists and nobody connected it. Distinct from
   * "found nothing": *unconfigured is a different state from unmatched*
   * (docs/upstream.md), and it is the difference between a permanent no and
   * a thing the owner can fix in two minutes.
   */
  configured(): boolean;
  /** What is missing, phrased for a person. Empty string when configured. */
  requirement(): string;
  /**
   * Candidates for a phrase. May return shallow cards (a search endpoint
   * rarely carries alt titles or chapter counts); `fetch` deepens them.
   * Must not throw for "nothing found" — that is an empty array.
   */
  search(phrase: string, limit: number): Promise<RegistryCard[]>;
  /** The full card for an id this provider issued. null when it is gone. */
  fetch(registryId: string): Promise<RegistryCard | null>;
}

/** True when the card carries enough to corroborate rather than just name-match. */
export function isDeep(card: RegistryCard): boolean {
  return card.altTitles.length > 0 || card.latestChapter !== null;
}

export function statusFrom(completed: boolean | undefined, text: string | undefined): RegistryStatus {
  const s = (text ?? "").toLowerCase();
  if (completed === true) return "complete";
  if (/\bhiatus\b/.test(s)) return "hiatus";
  if (/\bcomplete[d]?\b/.test(s)) return "complete";
  if (/\bongoing\b/.test(s)) return "ongoing";
  return "unknown";
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
