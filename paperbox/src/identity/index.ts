/**
 * The identity service — one binding per series, and the rules that keep it
 * honest when more than one registry has an opinion.
 *
 * ---------------------------------------------------------------------------
 * When providers disagree: one binding, one provider, never a merge.
 * ---------------------------------------------------------------------------
 * The card a client sees always comes from exactly **one** provider. A second
 * provider can only corroborate (`alsoConfirmedBy`) or say nothing; it never
 * contributes a field and never overrides one.
 *
 * Merging was the obvious design and it is wrong. A merged card has no single
 * `asOf` — half of it is a day old and half a month — and no single
 * `registryId` to re-query, so "you hold 313 of 327" stops having an author.
 * The moment a count is wrong, nobody can say which database said it, and the
 * fix is unfindable. Two of twelve series matched wrong at high confidence
 * precisely because a number arrived without provenance.
 *
 * So disagreement is expressed as **absence**: if a second registry does not
 * agree, corroboration is simply missing. The user is never shown two databases
 * arguing. That is deliberation, and the interface shows conclusions
 * (docs/ui.md).
 *
 * Precedence when more than one provider could bind:
 *   1. `embedded` — identity that travelled with the files, curated by whoever
 *      assembled the library. Believed over a search result.
 *   2. a registry whose domain matches, exact on a curated title.
 *   3. anything else — which does not bind at all, only asks.
 *
 * ---------------------------------------------------------------------------
 * A human binding is frozen.
 * ---------------------------------------------------------------------------
 * `decidedBy: "human"` means later automatic matching may refresh the card's
 * *facts* from the same registryId, and may never change the provider or the
 * id. "Human flagging outranks any automated confidence" is implemented as a
 * precondition here rather than as a rule each call site must remember.
 *
 * ---------------------------------------------------------------------------
 * What this costs the API we do not pay for.
 * ---------------------------------------------------------------------------
 * Identification is **once per series, ever**: one search plus at most five
 * card reads, serialised at one request per second (net.ts). Refresh afterwards
 * is one card read for the bound id. Nothing reachable from a page render
 * touches the network — `getBinding` and `allBindings` read the sidecar copy
 * the scan already holds in memory.
 *
 * The nightly refresh at 5,000 series is therefore 5,000 card reads, ~83
 * minutes at one per second: a scheduler with a budget, resumable, one provider
 * at a time. It is designed and deliberately **not built** — a fan-out across
 * 5,000 series would get us blocked on the first night, and that is the whole
 * reason the number is written down here rather than discovered later.
 */

import { join } from "path";
import { getManga, getMangaList, getMangaDir, recordIdentity } from "../scanner";
import { readComicInfo } from "./comicinfo";
import { ComicVineProvider } from "./comicvine";
import { MangaUpdatesProvider } from "./mangaupdates";
import { conclude, judge, NAME_FLOOR, type Judgement } from "./match";
import type { ProviderStatus, RegistryCard, RegistryProvider } from "./provider";
import type { IdentityBinding, IdentityCandidate, IdentityRecord, RegistryFacts } from "./types";

/**
 * How many search hits are worth a card read.
 *
 * Measured: MangaUpdates ranks the correct record first for every one of the
 * nine manhwa in this library, and the records that beat it on a naive name
 * score are doujinshi. So the deepening walks the provider's own order, not
 * ours — five is enough to survive a bad day and cheap enough to serialise.
 */
const DEEPEN = 5;
const SEARCH_HITS = 8;

const providers: RegistryProvider[] = [new MangaUpdatesProvider(), new ComicVineProvider()];

/** Exported for tests, which substitute a provider that never touches a socket. */
export function setProviders(next: RegistryProvider[]): void {
  providers.length = 0;
  providers.push(...next);
}

export function providerStatuses(): ProviderStatus[] {
  return providers.map((p) => ({
    id: p.id,
    name: p.name,
    domain: p.domain,
    configured: p.configured(),
    canRequery: p.canRequery,
    requirement: p.requirement(),
  }));
}

const configured = () => providers.filter((p) => p.configured());
const unconfigured = () => providers.filter((p) => !p.configured());

/* ------------------------------------------------------------------ */
/* Reading — never touches the network                                 */
/* ------------------------------------------------------------------ */

function cardToFacts(card: RegistryCard, seasons: RegistryFacts["seasons"]): RegistryFacts {
  return {
    provider: card.providerName,
    registryId: card.registryId,
    canonicalTitle: card.canonicalTitle,
    status: card.status,
    latestChapter: card.latestChapter,
    cadenceDays: card.cadenceDays,
    cadenceLabel: card.cadenceLabel,
    asOf: card.asOf,
    // Confirmed boundaries only. A provider's parsed hints never arrive here.
    seasons,
    nativeTitle: card.nativeTitle,
    year: card.year,
  };
}

function toBinding(seriesId: string, rec: IdentityRecord | undefined): IdentityBinding {
  if (!rec) return { seriesId, state: "unchecked", registry: null };
  const facts = rec.card ? { ...rec.card, seasons: rec.seasons ?? rec.card.seasons ?? [] } : null;
  const b: IdentityBinding = {
    seriesId,
    state: rec.state,
    registry: rec.state === "identified" ? facts : null,
  };
  if (rec.alsoConfirmedBy) b.alsoConfirmedBy = rec.alsoConfirmedBy;
  if (rec.state === "guess" && rec.candidate) b.candidate = rec.candidate;
  if (rec.state === "unconfigured" && rec.suggestedProvider) b.suggestedProvider = rec.suggestedProvider;
  return b;
}

export function getBinding(seriesId: string): IdentityBinding | null {
  const manga = getManga(seriesId);
  if (!manga) return null;
  return toBinding(seriesId, manga.series.identity);
}

export function allBindings(): Record<string, IdentityBinding> {
  const out: Record<string, IdentityBinding> = {};
  for (const m of getMangaList()) {
    const detail = getManga(m.id);
    out[m.id] = toBinding(m.id, detail?.series.identity);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Writing — decisions                                                 */
/* ------------------------------------------------------------------ */

const now = () => new Date().toISOString();

async function write(seriesId: string, rec: IdentityRecord | undefined): Promise<IdentityBinding | null> {
  const manga = getManga(seriesId);
  if (!manga) return null;
  await recordIdentity(manga.uid, rec);
  return toBinding(seriesId, rec);
}

/**
 * The user says yes — to a guess, or to something they found themselves.
 *
 * This is the only path that produces `decidedBy: "human"`, and from here on
 * automatic matching may refresh the facts but never the identity.
 */
export async function confirm(seriesId: string, providerId: string, registryId: string): Promise<IdentityBinding | null> {
  const manga = getManga(seriesId);
  if (!manga) return null;
  const provider = providers.find((p) => p.id === providerId || p.name === providerId);
  if (!provider) throw new Error(`No provider named ${providerId}`);
  if (!provider.configured()) throw new Error(`${provider.name} is not connected`);

  const card = await provider.fetch(registryId);
  if (!card) throw new Error(`${provider.name} no longer has ${registryId}`);
  return write(seriesId, {
    state: "identified",
    provider: provider.id,
    registryId: card.registryId,
    decidedBy: "human",
    decidedAt: now(),
    card: cardToFacts(card, []),
  });
}

/**
 * "Not this."
 *
 * Lands on `no-match`, never back on `unchecked`: we did look, and a person
 * looked too. Recording it as never-looked would invite the matcher to propose
 * the same thing again tomorrow.
 */
export function reject(seriesId: string): Promise<IdentityBinding | null> {
  return write(seriesId, { state: "no-match", decidedBy: "human", decidedAt: now() });
}

/**
 * Forget the binding entirely — back to "nobody has looked".
 *
 * Distinct from `reject`, which records that a person looked and said no. This
 * is the un-decision: it removes the key from the sidecar rather than writing a
 * state string that says absent. Nothing routes to it yet; it exists because
 * "we have not looked" must be representable as an absence, and because a reset
 * that leaves a residue is not a reset.
 */
export function clearBinding(seriesId: string): Promise<IdentityBinding | null> {
  return write(seriesId, undefined);
}

/** "Don't look this up." A full citizen, and it outranks every later match. */
export function filesOnly(seriesId: string): Promise<IdentityBinding | null> {
  return write(seriesId, { state: "files-only", decidedBy: "human", decidedAt: now() });
}

/**
 * Confirmed season boundaries.
 *
 * Separate from everything else on purpose: on MangaUpdates seasons exist only
 * as markdown prose in a free-text field, so they are evidence for a person and
 * never an automatic import. This endpoint is where a person's agreement lands.
 */
export async function setSeasons(
  seriesId: string,
  seasons: { name: string; endAfterSortKey: number }[],
): Promise<IdentityBinding | null> {
  const manga = getManga(seriesId);
  if (!manga?.series.identity) return null;
  return write(seriesId, { ...manga.series.identity, seasons });
}

/* ------------------------------------------------------------------ */
/* Matching — the only path that costs requests                        */
/* ------------------------------------------------------------------ */

function toCandidate(j: Judgement): IdentityCandidate {
  return {
    provider: j.card.providerName,
    registryId: j.card.registryId,
    title: j.card.canonicalTitle,
    // Internal, and it stays internal: the client renders evidence, never this.
    nameScore: Math.round(j.score * 100) / 100,
    evidence: j.evidence,
  };
}

/**
 * Ask one provider about one title, and judge what comes back.
 *
 * The prose skip is worth its line: a search record already carries the
 * provider's type, so a novel is discarded *before* we spend a card read on it.
 * That is a real contradiction applied for free, and on this library it saves
 * one request per series on three of twelve.
 */
async function askProvider(provider: RegistryProvider, title: string, held: number): Promise<Judgement[]> {
  let shallow: RegistryCard[] = [];
  try {
    shallow = await provider.search(title, SEARCH_HITS);
  } catch (e) {
    console.error(`[identity] ${provider.name} search failed for ${JSON.stringify(title)}:`, e);
    return [];
  }
  const worth = shallow.filter((c) => c.kind !== "prose").slice(0, DEEPEN);
  const judged: Judgement[] = [];
  for (const s of worth) {
    let deep: RegistryCard | null = null;
    try {
      deep = await provider.fetch(s.registryId);
    } catch (e) {
      console.error(`[identity] ${provider.name} card ${s.registryId} failed:`, e);
    }
    judged.push(judge(deep ?? s, title, held));
  }
  return judged;
}

/**
 * Look this series up.
 *
 * Explicit, never automatic on a render, and never on a timer. The result is
 * written to the sidecar, so every later read is free.
 */
export async function identify(seriesId: string, opts: { force?: boolean } = {}): Promise<IdentityBinding | null> {
  const manga = getManga(seriesId);
  if (!manga) return null;
  const existing = manga.series.identity;

  // A person's decision is not re-litigated. Refresh the facts behind it from
  // the same id and leave the identity exactly where they put it.
  if (existing && existing.decidedBy === "human" && !opts.force) {
    if (existing.state !== "identified" || !existing.provider || !existing.registryId) {
      return toBinding(seriesId, existing);
    }
    const provider = providers.find((p) => p.id === existing.provider);
    if (!provider?.configured()) return toBinding(seriesId, existing);
    const card = await provider.fetch(existing.registryId);
    if (!card) return toBinding(seriesId, existing);
    return write(seriesId, { ...existing, card: cardToFacts(card, existing.seasons ?? []) });
  }

  const title = manga.title;
  const held = manga.chapterCount;

  // 1. Identity that arrived with the files outranks anything we could search
  //    for. It is an assertion by whoever assembled the library, not a guess.
  const embedded = await readComicInfo(manga.uid, [join(getMangaDir(), manga.dir)]);
  if (embedded) {
    return write(seriesId, {
      state: "identified",
      provider: embedded.provider,
      registryId: embedded.registryId,
      decidedBy: "file",
      decidedAt: now(),
      card: cardToFacts(embedded, existing?.seasons ?? []),
    });
  }

  // 2. Every configured registry, each judged on its own.
  const results: { provider: RegistryProvider; judged: Judgement[] }[] = [];
  for (const p of configured()) {
    if (p.domain === "embedded") continue;
    results.push({ provider: p, judged: await askProvider(p, title, held) });
  }

  const bound = results
    .map((r) => ({ provider: r.provider, outcome: conclude(r.judged) }))
    .filter((r) => r.outcome.kind === "identified");

  if (bound.length > 0) {
    const primary = bound[0]!;
    const winner = (primary.outcome as { winner: Judgement }).winner;
    // Corroboration only. A second registry never contributes a field, and a
    // second registry that disagrees contributes nothing at all -- silently.
    const also = bound[1] ? bound[1].provider.name : undefined;
    return write(seriesId, {
      state: "identified",
      provider: primary.provider.id,
      registryId: winner.card.registryId,
      decidedBy: "auto",
      decidedAt: now(),
      card: cardToFacts(winner.card, existing?.seasons ?? []),
      ...(also ? { alsoConfirmedBy: also } : {}),
    });
  }

  const guesses = results
    .map((r) => conclude(r.judged))
    .filter((o): o is { kind: "guess"; winner: Judgement } => o.kind === "guess");
  if (guesses.length > 0) {
    const best = guesses.sort((a, b) => b.winner.score - a.winner.score)[0]!;
    return write(seriesId, {
      state: "guess",
      decidedBy: "auto",
      decidedAt: now(),
      candidate: toCandidate(best.winner),
    });
  }

  // Nothing survived. Whether that is permanent is a fact about our
  // configuration, not about this series: "found in no registry we have
  // connected" and "in none that exists" are different answers, and only the
  // second is final (docs/upstream.md). While a slot sits unconnected we are
  // not entitled to the second one.
  //
  // An earlier version tried to be cleverer -- if nothing even *resembled* the
  // name, we asked the wrong sort of database -- and it was measured to be
  // junk. See NAME_FLOOR in match.ts for the record that killed it.
  const slot = unconfigured()[0];
  if (slot) {
    return write(seriesId, {
      state: "unconfigured",
      decidedBy: "auto",
      decidedAt: now(),
      suggestedProvider: slot.name,
    });
  }
  return write(seriesId, { state: "no-match", decidedBy: "auto", decidedAt: now() });
}

/**
 * The user searches for themselves.
 *
 * The discard rule applies here exactly as it does to an automatic match: a
 * candidate the evidence disproves does not cross the wire, whether or not a
 * person typed the query. The bar is a property of the evidence, not of who
 * asked -- and showing somebody a novel they can bind their comic to is not
 * respect for their agency, it is a trap with a button on it.
 */
export async function search(seriesId: string, phrase: string): Promise<IdentityCandidate[]> {
  const manga = getManga(seriesId);
  if (!manga) return [];
  const q = phrase.trim();
  if (!q) return [];
  const held = manga.chapterCount;

  const out: Judgement[] = [];
  for (const p of configured()) {
    if (p.domain === "embedded") continue;
    out.push(...(await askProvider(p, q, held)));
  }
  return out
    .filter((j) => !j.contradicted && j.score >= NAME_FLOOR)
    .sort((a, b) => b.score - a.score)
    .map(toCandidate);
}
