// What's already in the library, for Milo's suggestions. Sonarr and Radarr are
// the source of truth for what is coming and when: a suggestion that is already
// set to download should be told as good news with its date, not pitched as a
// new idea.
//
// Read-only. The four services, their addresses and where their keys live are
// fixed here; the model supplies titles only, and gets back a one-line label per
// title, never keys, paths, IDs, quality or file detail.

import { readFile } from "node:fs/promises";

const SERVICES = [
  { name: "sonarr", kind: "series", url: "http://sonarr:8989/api/v3/series", config: "/mnt/user/Config/sonarr/config.xml" },
  { name: "animesonarr", kind: "series", url: "http://animesonarr:8989/api/v3/series", config: "/mnt/user/Config/sonarr_anime/config.xml" },
  { name: "radarr", kind: "movie", url: "http://radarr:7878/api/v3/movie", config: "/mnt/user/Config/radarr/config.xml" },
  { name: "animeradarr", kind: "movie", url: "http://animeradarr:7878/api/v3/movie", config: "/mnt/user/Config/animeradarr/config.xml" },
];
const CACHE_MS = 10 * 60 * 1000;
const TZ = "Europe/Paris";

/** Lowercase, strip accents, punctuation and season/part markers, so AniList,
 * web and Sonarr spellings of one show meet. "Re:ZERO -Starting Life in
 * Another World- Season 3" -> "re zero starting life in another world". */
export function normTitle(title) {
  return String(title ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(season|part|cour)\s*\d+\b/g, " ")
    .replace(/\b\d+(st|nd|rd|th)\s+(season|part|cour)\b/g, " ")
    .replace(/\((tv|\d{4})\)/g, " ")
    .replace(/\b(ii|iii|iv)\s*$/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The season a title names, if it names one. */
export function seasonOf(title) {
  const t = String(title ?? "").toLowerCase();
  const m =
    t.match(/\bseason\s*(\d+)\b/) ||
    t.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/) ||
    t.match(/\bpart\s*(\d+)\b/);
  if (m) return Number(m[1]);
  const roman = t.match(/\b(ii|iii|iv)\s*$/);
  return roman ? { ii: 2, iii: 3, iv: 4 }[roman[1]] : null;
}

const day = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
const future = (iso, now) => iso && new Date(iso).getTime() > now.getTime();

/** Reduce an Arr record to the few facts a label needs. */
export function toEntry(kind, rec) {
  const titles = [rec.title, ...(rec.alternateTitles ?? []).map((a) => a.title)].filter(Boolean);
  const base = { kind, title: rec.title, year: rec.year, keys: new Set(titles.map(normTitle).filter(Boolean)), monitored: Boolean(rec.monitored) };
  if (kind === "movie") {
    return { ...base, hasFile: Boolean(rec.hasFile), releases: [rec.digitalRelease, rec.physicalRelease, rec.inCinemas].filter(Boolean) };
  }
  return {
    ...base,
    nextAiring: rec.nextAiring ?? null,
    ended: rec.status === "ended",
    seasons: (rec.seasons ?? [])
      .filter((s) => s.seasonNumber > 0)
      .map((s) => ({
        n: s.seasonNumber,
        monitored: Boolean(s.monitored),
        have: s.statistics?.episodeFileCount ?? 0,
        total: s.statistics?.totalEpisodeCount ?? 0,
      })),
  };
}

/** One plain line about an entry, in words Milo can pass on. */
export function describe(entry, season, now = new Date()) {
  if (entry.kind === "movie") {
    if (entry.hasFile) return "already in the library, ready to watch";
    const next = entry.releases.filter((d) => future(d, now)).sort()[0];
    if (entry.monitored) return next ? `already set to download, out ${day(next)}` : "already set to download";
    return "in the library's list but not set to download";
  }
  const s = season ? entry.seasons.find((x) => x.n === season) : null;
  const next = future(entry.nextAiring, now) ? `, next episode ${day(entry.nextAiring)}` : "";
  if (season && !s) {
    return entry.monitored && !entry.ended
      ? `earlier seasons are in the library and new ones get picked up automatically${next}`
      : "earlier seasons are in the library, this one isn't yet";
  }
  if (s && !s.monitored) return `in the library, but season ${season} isn't set to download`;
  if (s && s.total > 0 && s.have >= s.total && !next) return `season ${season} is in the library, ready to watch`;
  if (entry.monitored && (next || !entry.ended)) return `already set to download${next}`;
  if (entry.seasons.some((x) => x.have > 0)) return "already in the library";
  return "in the library's list";
}

/** Find a title among entries; titles may be several spellings of one show. */
export function findEntry(entries, titles, { kind, year } = {}) {
  const keys = titles.map(normTitle).filter((k) => k.length > 1);
  const hits = entries.filter((e) => (!kind || e.kind === kind) && keys.some((k) => e.keys.has(k)));
  if (hits.length <= 1 || !year) return hits[0] ?? null;
  return hits.find((e) => e.year === year) ?? hits[0];
}

export function createLibrary(logger) {
  let cache = { at: 0, entries: [], partial: false };
  let pending = null;

  async function fetchService(svc) {
    const xml = await readFile(svc.config, "utf8");
    const key = xml.match(/<ApiKey>([^<]+)<\/ApiKey>/)?.[1];
    if (!key) throw new Error("no key");
    const res = await fetch(svc.url, { headers: { "X-Api-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).map((rec) => toEntry(svc.kind, rec));
  }

  async function refresh() {
    const results = await Promise.allSettled(SERVICES.map(fetchService));
    const entries = [];
    let partial = false;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") entries.push(...r.value);
      else {
        partial = true;
        logger?.warn?.(`watch-ideas: library ${SERVICES[i].name} unavailable: ${String(r.reason).slice(0, 120)}`);
      }
    });
    cache = { at: Date.now(), entries, partial };
    return cache;
  }

  /** Current library, refreshed at most every ten minutes. Never throws. */
  async function get() {
    if (Date.now() - cache.at < CACHE_MS && cache.entries.length) return cache;
    pending ??= refresh().finally(() => { pending = null; });
    try {
      return await pending;
    } catch {
      return cache;
    }
  }

  /** Label for one title: { found, text }. titles = spellings of one show. */
  async function label(titles, opts = {}) {
    const lib = await get();
    if (!lib.entries.length) return { found: false, text: "library check unavailable right now" };
    const all = (Array.isArray(titles) ? titles : [titles]).filter(Boolean);
    const season = opts.season ?? all.map(seasonOf).find(Boolean) ?? null;
    const entry = findEntry(lib.entries, all, opts);
    if (!entry) return { found: false, text: lib.partial ? "not found in the library (check was partial)" : "not in the library" };
    return { found: true, text: describe(entry, season) };
  }

  return { get, label };
}
