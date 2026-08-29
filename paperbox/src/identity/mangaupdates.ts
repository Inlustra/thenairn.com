/**
 * MangaUpdates — the first provider.
 *
 * Verified against the live API on 2026-08-29 (every claim below was re-checked
 * that day, not inherited from the 2026-08-28 harvest):
 *
 *   POST /v1/series/search  { search, perpage }
 *        -> { total_hits, results: [ { record: { series_id, title, url,
 *             description, image, type, year, ... }, hit_title } ] }
 *        The search record carries `type` and `year` but **not** `associated`
 *        and **not** `latest_chapter`. So a search alone cannot corroborate
 *        anything, and it cannot even find the right record by name — see
 *        below.
 *
 *   GET  /v1/series/{id}
 *        -> { series_id, title, type, year, completed, latest_chapter,
 *             status, associated: [{ title }], url, ... }
 *
 * No API key. No auth header. Rate limiting is ours to impose (net.ts).
 *
 * **Why the detail fetch is not optional.** Measured against the real library:
 * the correct record for `Omniscient Reader's Viewpoint` is *titled*
 * "Omniscient Reader" (id 50369844984, 308 chapters), and the correct record
 * for `Reincarnation of the Suicidal Battle God` is titled "Doom Breaker"
 * (id 3796218942, 101 chapters). Both match our folder name exactly — on an
 * **alternative** title, which only the detail endpoint returns. Matching on
 * `title` alone is how the earlier harvest bound both of those to novels.
 *
 * **Season structure is prose, and stays prose.** `status` reads
 * `"326 Chapters (Ongoing)\n\n**S1** : 142 Chapters (1~142)\n**S2** : 184
 * Chapters (Ongoing) (143~???)"`. It is parsed into `seasonHints` and never
 * into `seasons` — a person confirms, or nothing happens.
 */

import { Fetcher, TTL } from "./net";
import {
  type RegistryCard,
  type RegistryProvider,
  type SeriesKind,
  statusFrom,
  today,
} from "./provider";

const BASE = "https://api.mangaupdates.com/v1";

interface MuRecord {
  series_id?: number;
  title?: string;
  url?: string;
  type?: string;
  year?: string | number;
  completed?: boolean;
  latest_chapter?: number;
  status?: string;
  associated?: { title?: string }[];
}

/**
 * MangaUpdates' `type` vocabulary onto ours.
 *
 * "Novel" is the one that earns its keep: a prose record against a directory of
 * page images is a decisive contradiction, and it is the cheapest one we have.
 * Everything unrecognised stays `unknown` rather than being guessed into
 * `comic` — an unknown kind contradicts nothing, and a wrongly-assumed one
 * would silently license a binding.
 */
export function kindOf(type: string | undefined): SeriesKind {
  const t = (type ?? "").toLowerCase();
  if (!t) return "unknown";
  if (t.includes("novel")) return "prose";
  if (["manga", "manhwa", "manhua", "doujinshi", "oel", "filipino", "indonesian", "thai", "vietnamese", "malaysian"].some((k) => t.includes(k)))
    return "comic";
  if (t.includes("artbook") || t.includes("drama cd")) return "other";
  return "unknown";
}

/**
 * Pull `**S1** : 142 Chapters (1~142)` out of the free-text status blob.
 *
 * Tolerant of both shapes seen live — `**S1** :` and `**S1:**` — and of `~`
 * escaped as `\~`, which MangaUpdates does inconsistently. Returns hints only.
 * A season whose end we cannot read is skipped rather than guessed: half a
 * boundary is worse than none, because it would draw a divider in the wrong
 * place with the same confidence as a right one.
 */
export function parseSeasonHints(status: string | undefined): { name: string; endAfterSortKey: number; from: string }[] {
  if (!status) return [];
  const out: { name: string; endAfterSortKey: number; from: string }[] = [];
  const line = /\*\*\s*(S(?:eason)?\s*\d+)\s*:?\s*\*\*\s*:?\s*([^\n]*)/gi;
  for (const m of status.matchAll(line)) {
    const name = (m[1] ?? "").replace(/\s+/g, " ").trim().replace(/^S(\d)/i, "Season $1");
    const rest = m[2] ?? "";
    // `(1~142)`, `(1-104)`, `(143~???)` — the end is what we want, and `???`
    // means the season is still running, so there is no boundary yet.
    const range = rest.match(/\((\d+)\s*\\?[~\-–]\s*(\d+)\)/);
    if (!range) continue;
    const end = Number(range[2]);
    if (!Number.isFinite(end) || end <= 0) continue;
    out.push({ name, endAfterSortKey: end, from: "MangaUpdates status text" });
  }
  return out;
}

/**
 * The work's own-language title, picked out of the associated list.
 *
 * MangaUpdates does not label which alternative title is the native one, so it
 * is inferred from script: Hangul, kana or Han. That is right for the Korean
 * and Japanese works this library holds and simply returns nothing for anything
 * else, which is the correct failure -- the field is optional and the UI omits
 * it when absent.
 */
export function nativeTitleOf(alts: string[]): string | undefined {
  return alts.find((t) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(t));
}

function toCard(rec: MuRecord, deep: boolean): RegistryCard | null {
  const id = rec.series_id;
  const title = (rec.title ?? "").trim();
  if (!id || !title) return null;
  const year = Number(rec.year);
  const altTitles = (rec.associated ?? []).map((a) => (a.title ?? "").trim()).filter(Boolean);
  return {
    provider: "mangaupdates",
    providerName: "MangaUpdates",
    registryId: String(id),
    canonicalTitle: title,
    altTitles,
    kind: kindOf(rec.type),
    typeLabel: rec.type ?? null,
    status: statusFrom(rec.completed, rec.status),
    // Rule 2 in provider.ts: only a deep card may say `null` and mean "no
    // records". A search record simply does not carry the field, and reporting
    // that absence as `null` would let a shallow card look like a registry with
    // no chapters — which is a contradiction, and would discard the candidate
    // we are about to deepen.
    latestChapter: deep ? (typeof rec.latest_chapter === "number" ? rec.latest_chapter : null) : null,
    cadenceDays: null,
    cadenceLabel: null,
    seasons: [],
    seasonHints: deep ? parseSeasonHints(rec.status) : [],
    nativeTitle: nativeTitleOf(altTitles),
    year: Number.isFinite(year) && year > 0 ? year : undefined,
    url: rec.url,
    asOf: today(),
  };
}

export class MangaUpdatesProvider implements RegistryProvider {
  readonly id = "mangaupdates";
  readonly name = "MangaUpdates";
  readonly domain = "manga" as const;
  readonly canRequery = true;

  constructor(private net = new Fetcher(1000)) {}

  configured(): boolean {
    return true;
  }
  requirement(): string {
    return "";
  }

  async search(phrase: string, limit: number): Promise<RegistryCard[]> {
    const body = JSON.stringify({ search: phrase, perpage: Math.min(25, Math.max(1, limit)) });
    const data = await this.net.json<{ results?: { record?: MuRecord }[] }>(
      `mu:search:${body}`,
      TTL.search,
      async (signal) => {
        const res = await fetch(`${BASE}/series/search`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body,
          signal,
        });
        if (!res.ok) throw new Error(`MangaUpdates search ${res.status}`);
        return res.json() as Promise<{ results?: { record?: MuRecord }[] }>;
      },
    );
    const out: RegistryCard[] = [];
    for (const r of data.results ?? []) {
      const card = r.record ? toCard(r.record, false) : null;
      if (card) out.push(card);
    }
    return out.slice(0, limit);
  }

  async fetch(registryId: string): Promise<RegistryCard | null> {
    if (!/^\d+$/.test(registryId)) return null;
    const rec = await this.net.json<MuRecord | null>(`mu:series:${registryId}`, TTL.card, async (signal) => {
      const res = await fetch(`${BASE}/series/${registryId}`, {
        headers: { accept: "application/json" },
        signal,
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`MangaUpdates series ${res.status}`);
      return res.json() as Promise<MuRecord>;
    });
    return rec ? toCard(rec, true) : null;
  }
}
