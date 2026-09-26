// The media desk: the deterministic half of the media agent.
//
// Everything a guest can cause goes through here: look a title up (with
// enough detail for Milo to talk about it), check the library, add exactly one
// film or one season, read back real progress, confirm it's on Plex, and swap
// out a stalled download for another copy. The rules are code, not prose:
//
//   - exact catalogue IDs from a lookup this person did; one season at a time
//   - house profiles: films Radarr 6 (720p/1080p), series Sonarr 1 ("Any",
//     grabs 1080p), anime to AnimeSonarr/AnimeRadarr profile 7; never 4K/remux
//   - never /amedia, and never reveal anything in it
//   - films only once released (minimumAvailability "released")
//
// Judgement (which alternative source, a better release, space trade-offs) is
// the media agent's job; it gets anything this desk can't settle.
import { readFileSync } from "node:fs";
import type { Store, Job } from "./db";
import { log } from "./log";

export type Service = "movie" | "series" | "anime_movie" | "anime_series";
type Kind = "movie" | "series";

const SERVICES: Record<Service, { base: string; config: string; kind: Kind; root: string; profile: number }> = {
  movie: { base: "http://radarr:7878/api/v3/", config: "/mnt/user/Config/radarr/config.xml", kind: "movie", root: "/movies", profile: 6 },
  series: { base: "http://sonarr:8989/api/v3/", config: "/mnt/user/Config/sonarr/config.xml", kind: "series", root: "/tv", profile: 1 },
  anime_movie: { base: "http://animeradarr:7878/api/v3/", config: "/mnt/user/Config/animeradarr/config.xml", kind: "movie", root: "/movies", profile: 7 },
  anime_series: { base: "http://animesonarr:8989/api/v3/", config: "/mnt/user/Config/sonarr_anime/config.xml", kind: "series", root: "/anime", profile: 7 },
};
const HIDDEN_ROOT = "/amedia"; // private library: never add to it, never mention it
const DRY_RUN = process.env.MEDIA_DRY_RUN === "1"; // tests: look everything up, change nothing
const PLEX = { base: "http://plex:32400/", prefs: "/mnt/user/Config/plex/Library/Application Support/Plex Media Server/Preferences.xml" };

export class PublicError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
  }
}

const keys = new Map<string, string>();
function secret(file: string, re: RegExp) {
  if (!keys.has(file)) {
    const v = readFileSync(file, "utf8").match(re)?.[1];
    if (!v) throw new PublicError("That's unavailable right now.");
    keys.set(file, v);
  }
  return keys.get(file)!;
}

async function api(svc: Service, path: string, method = "GET", body?: unknown): Promise<any> {
  const s = SERVICES[svc];
  if (DRY_RUN && method !== "GET") {
    log.info({ svc, method, path }, "media dry run: not sent");
    return { ...((body as object) ?? {}), id: -1 };
  }
  const r = await fetch(s.base + path, {
    method,
    redirect: "error",
    headers: { "X-Api-Key": secret(s.config, /<ApiKey>([^<]+)<\/ApiKey>/), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) throw new Error(`${svc} ${method} ${path.split("?")[0]} -> ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

const resource = (svc: Service) => (SERVICES[svc].kind === "movie" ? "movie" : "series");
const idField = (kind: Kind) => (kind === "movie" ? "tmdbId" : "tvdbId");
const hidden = (x: any) => String(x?.rootFolderPath ?? x?.path ?? "").startsWith(HIDDEN_ROOT);

// Opaque option refs handed to Milo: "film-116149", "series-354483".
export const refOf = (kind: Kind, id: number) => `${kind === "movie" ? "film" : "series"}-${id}`;
export function parseRef(ref: string): { kind: Kind; id: number } {
  const m = /^(film|series)-(\d{1,9})$/.exec(String(ref).trim());
  if (!m) throw new PublicError("I need to look that title up again first.");
  return { kind: m[1] === "film" ? "movie" : "series", id: Number(m[2]) };
}

// Made for children: by rating, or by genre when the rating is missing.
const KIDS_RATINGS = new Set(["G", "PG", "U", "TV-Y", "TV-Y7", "TV-Y7-FV", "TV-G", "TV-PG", "UC"]);
export function forKids(x: any) {
  const cert = String(x.certification ?? "").replace(/^[a-z]{2}\//i, "").toUpperCase();
  const genres: string[] = (x.genres ?? []).map((g: string) => g.toLowerCase());
  return KIDS_RATINGS.has(cert) || genres.some((g) => ["children", "kids", "family"].includes(g));
}

function isAnime(x: any, kind: Kind) {
  const genres: string[] = (x.genres ?? []).map((g: string) => g.toLowerCase());
  const lang = String(x.originalLanguage?.name ?? "").toLowerCase();
  if (kind === "series" && x.seriesType === "anime") return true;
  return genres.includes("anime") || (lang === "japanese" && genres.includes("animation"));
}

// Where this title lives, across both instances of its kind. A title in the
// hidden library is reported as not present.
async function findItem(kind: Kind, id: number): Promise<{ svc: Service; item: any } | null> {
  for (const svc of (kind === "movie" ? ["movie", "anime_movie"] : ["series", "anime_series"]) as Service[]) {
    const item = ((await api(svc, resource(svc))) as any[]).find((x) => x[idField(kind)] === id);
    if (item) return hidden(item) ? null : { svc, item };
  }
  return null;
}

export type Candidate = {
  option: string;
  title: string;
  year: number | null;
  kind: "film" | "series";
  onPlex: string;
  about: string;
  genres: string[];
  runtime?: string;
  certification?: string;
  rating?: string;
  seasons?: number[];
  status?: string;
  releases?: string;
  findability: { outlook: "easy" | "may take a while" | "could be hard"; why: string[] };
};

// How hard a title is likely to be to get, from facts rather than guesswork:
// age, how many people have rated it (a proxy for how widely it's shared),
// original language, release status, length. Milo uses it to set
// expectations before anyone's disappointed.
function findability(x: any, kind: Kind): Candidate["findability"] {
  const why: string[] = [];
  let score = 0;
  const year = x.year ?? 0;
  const votes = kind === "movie" ? Math.max(x.ratings?.imdb?.votes ?? 0, x.ratings?.tmdb?.votes ?? 0) : x.ratings?.votes ?? 0;
  if (year && year < 1990) (why.push(`old (${year})`), (score += 2));
  else if (year && year < 2005) (why.push(`older (${year})`), (score += 1));
  if (votes < 150) (why.push("very niche: hardly anyone has rated it"), (score += 2));
  else if (votes < (kind === "movie" ? 2000 : 500)) (why.push("fairly niche"), (score += 1));
  const lang = x.originalLanguage?.name;
  if (lang && lang !== "English") (why.push(`originally in ${lang}: an English version may be hard to find, or only subtitled`), (score += 1));
  if (kind === "movie" && x.status !== "released") (why.push(x.status === "inCinemas" ? "only in cinemas so far" : "not released yet"), (score += 1));
  if (kind === "series") {
    const n = (x.seasons ?? []).filter((s: any) => s.seasonNumber > 0).length;
    if (n > 6) why.push(`long series (${n} seasons): best taken a season at a time`);
  }
  return { outlook: score >= 3 ? "could be hard" : score >= 1 ? "may take a while" : "easy", why };
}

export async function lookup(store: Store, number: string, kind: Kind, title: string, year?: number): Promise<Candidate[]> {
  if (title.length < 2 || title.length > 160) throw new PublicError("Could you give me the title again?");
  const svc: Service = kind === "movie" ? "movie" : "series";
  const raw = (await api(svc, `${resource(svc)}/lookup?term=${encodeURIComponent(title)}`)) as any[];
  // The catalogue's own order puts obscure near-misses first ("Bluey" gave a
  // 1976 show and two "Blue"s before the Bluey everyone means). Rank exact
  // title matches first, then by how widely watched it is.
  const norm = (t: string) => t.toLowerCase().replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const want = norm(title);
  const votes = (x: any) => (kind === "movie" ? Math.max(x.ratings?.imdb?.votes ?? 0, x.ratings?.tmdb?.votes ?? 0) : x.ratings?.votes ?? 0);
  const rank = (x: any) => (norm(x.title) === want ? 0 : norm(x.title).startsWith(want) ? 1 : 2);
  const rows = raw.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || votes(b.x) - votes(a.x) || a.i - b.i).map((r) => r.x);
  const out: Candidate[] = [];
  for (const x of rows) {
    if (year && x.year !== year) continue;
    const id = x[idField(kind)];
    if (!id) continue;
    const seasons = kind === "series" ? (x.seasons ?? []).map((y: any) => y.seasonNumber).filter((n: number) => n > 0) : undefined;
    const anime = isAnime(x, kind);
    // Anime goes to the anime instances either way; only grown-up anime needs
    // access (Pokémon doesn't make someone an anime fan).
    const poster = String(x.remotePoster ?? x.images?.find((i: any) => i.coverType === "poster")?.remoteUrl ?? "").replace("/t/p/original/", "/t/p/w500/") || null;
    store.rememberCandidate(number, { media_type: kind, ext_id: id, title: x.title, year: x.year ?? null, seasons, anime, gated: anime && !forKids(x), hard: findability(x, kind).outlook === "could be hard", poster });
    const have = await findItem(kind, id);
    const rating = x.ratings?.imdb?.value ?? x.ratings?.tmdb?.value ?? x.ratings?.value;
    const status = have ? await libraryStatus(kind, id, have.item, seasons) : "not on Plex; can be requested";
    out.push({
      option: refOf(kind, id),
      title: String(x.title).replace(new RegExp(`\\s*\\(${x.year}\\)$`), ""), // "Bluey (2018)" -> "Bluey"; the year is its own field
      year: x.year ?? null,
      kind: kind === "movie" ? "film" : "series",
      // Where it stands, in full; only who asked for it is private.
      onPlex: status,
      about: String(x.overview ?? "").slice(0, 400),
      genres: (x.genres ?? []).slice(0, 4),
      runtime: x.runtime ? `${x.runtime} min${kind === "series" ? " per episode" : ""}` : undefined,
      certification: x.certification || undefined,
      rating: rating ? `${Number(rating).toFixed(1)}/10` : undefined,
      seasons,
      status: kind === "series" ? x.status : x.status === "released" ? undefined : x.status,
      releases: kind === "movie" ? releaseLine(x) : x.firstAired ? `first aired ${String(x.firstAired).slice(0, 10)}` : undefined,
      findability: findability(x, kind),
    });
    if (out.length === 3) break;
  }
  return out;
}

function releaseLine(x: any) {
  const parts = [x.inCinemas && `cinemas ${x.inCinemas.slice(0, 10)}`, x.digitalRelease && `digital ${x.digitalRelease.slice(0, 10)}`, x.physicalRelease && `disc ${x.physicalRelease.slice(0, 10)}`].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

// What's watchable and what's on its way, for Milo to talk about. Never who
// asked for it: that's another person's business.
async function libraryStatus(kind: Kind, id: number, item: any, seasons?: number[]): Promise<string> {
  const probe = (season: number | null) =>
    progress({ media_type: kind, ext_id: id, season, title: item.title } as Job).catch(() => ({ state: "searching" }) as Progress);
  const say = (p: Progress) =>
    p.state === "downloading"
      ? `already on its way${p.percent ? `, about ${p.percent}% done` : ""}${p.eta ? `, expected ${humanWhen(p.eta)}` : ""}`
      : p.state === "importing" || p.state === "on_disk"
        ? "just arrived, ready within minutes"
        : p.state === "waiting_release"
          ? `not released yet${p.releaseDate ? `, due ${humanDate(p.releaseDate)}` : ""}; it'll be fetched automatically when it's out`
          : p.state === "attention"
            ? "on its way, though the current copy has hit a snag"
            : "wanted already and being searched for, not found yet";
  if (kind === "movie") return item.hasFile ? "yes, ready to watch" : say(await probe(null));
  const stats = new Map((item.seasons ?? []).map((x: any) => [x.seasonNumber, x.statistics ?? {}]));
  const parts: string[] = [];
  for (const n of seasons ?? []) {
    const st: any = stats.get(n) ?? {};
    const monitored = (item.seasons ?? []).find((x: any) => x.seasonNumber === n)?.monitored;
    if (st.episodeCount > 0 && st.episodeFileCount >= st.episodeCount) parts.push(`season ${n}: ready`);
    else if (st.episodeFileCount > 0) parts.push(`season ${n}: ${st.episodeFileCount} of ${st.totalEpisodeCount ?? st.episodeCount} episodes ready`);
    else if (monitored) parts.push(`season ${n}: ${say(await probe(n))}`);
    else parts.push(`season ${n}: not on Plex`);
  }
  return parts.join("; ") || "not on Plex; can be requested";
}

// ---------------------------------------------------------------- progress

export type Progress = {
  state: "on_disk" | "importing" | "downloading" | "searching" | "waiting_release" | "attention" | "missing";
  percent?: number;
  bytesLeft?: number;
  eta?: string; // ISO
  releaseDate?: string; // ISO date, for waiting_release
  detail?: string; // internal only: why it needs attention
};

export async function progress(job: Job): Promise<Progress> {
  const found = await findItem(job.media_type, job.ext_id);
  if (!found) return { state: "missing" };
  const { svc, item } = found;
  const kind = job.media_type;
  let released = true, releaseDate: string | undefined, onDisk = false;
  if (kind === "movie") {
    onDisk = !!item.hasFile;
    // Our own check, not Radarr's isAvailable: that follows the item's
    // minimumAvailability, and items added elsewhere may say "tba" (always
    // "available"). Out means a digital or disc release has happened.
    const home = [item.digitalRelease, item.physicalRelease].filter(Boolean).map((d: string) => Date.parse(d));
    const out = home.some((t: number) => t <= Date.now()) || (!home.length && item.status === "released");
    if (!onDisk && !out) {
      released = false;
      releaseDate = (item.digitalRelease ?? item.physicalRelease ?? item.inCinemas)?.slice(0, 10);
    }
  } else {
    const eps = ((await api(svc, `episode?seriesId=${item.id}`)) as any[]).filter((e) => e.seasonNumber === job.season);
    const aired = eps.filter((e) => e.airDateUtc && Date.parse(e.airDateUtc) <= Date.now());
    onDisk = aired.length > 0 && aired.every((e) => e.hasFile);
    if (!aired.length) {
      released = false;
      releaseDate = eps.map((e) => e.airDateUtc).filter(Boolean).sort()[0]?.slice(0, 10);
    }
  }
  if (onDisk) return { state: "on_disk" };

  const queue = await api(svc, "queue?page=1&pageSize=1000&includeEpisode=true");
  // A multi-season download ("S01-S03") can be queued under its first
  // season's episodes only: it still covers the later seasons.
  const covers = (q: any) => {
    const m = /S(\d{1,2})\s*-\s*S?(\d{1,2})/i.exec(String(q.title ?? ""));
    return !!m && Number(m[1]) <= (job.season ?? 0) && (job.season ?? 0) <= Number(m[2]);
  };
  const mine = ((queue?.records ?? []) as any[]).filter((q) =>
    kind === "movie" ? q.movieId === item.id : q.seriesId === item.id && ((q.episode?.seasonNumber ?? q.seasonNumber) === job.season || covers(q)),
  );
  if (mine.length) {
    // One torrent can back several rows (a season pack): count each once.
    const byDl = new Map<string, any>();
    for (const q of mine) byDl.set(q.downloadId ?? String(q.id), q);
    const dls = [...byDl.values()];
    const size = dls.reduce((a, q) => a + (q.size ?? 0), 0);
    const left = dls.reduce((a, q) => a + (q.sizeleft ?? 0), 0);
    const eta = dls.map((q) => q.estimatedCompletionTime).filter(Boolean).sort().at(-1);
    const base = { percent: size ? Math.round(((size - left) / size) * 100) : undefined, bytesLeft: left, eta };
    const trouble = mine.filter((q) => q.trackedDownloadStatus === "warning" || q.trackedDownloadStatus === "error" || ["importBlocked", "failedPending", "failed"].includes(q.trackedDownloadState));
    if (trouble.length) {
      const why = trouble.flatMap((q) => (q.statusMessages ?? []).flatMap((m: any) => m.messages ?? [])).slice(0, 3).join("; ");
      return { state: "attention", ...base, detail: `${trouble[0].trackedDownloadState}/${trouble[0].trackedDownloadStatus}: ${why}` };
    }
    if (dls.every((q) => q.status === "completed" || q.sizeleft === 0)) return { state: "importing", ...base, percent: 100 };
    return { state: "downloading", ...base };
  }
  if (!released) return { state: "waiting_release", releaseDate };
  return { state: "searching" };
}

// Is it actually watchable? Plex can't be filtered by external ID, so search
// by title and match the ID Plex reports.
export async function onPlex(job: Job): Promise<boolean> {
  const token = secret(PLEX.prefs, /PlexOnlineToken="([^"]+)"/);
  const q = new URLSearchParams({ query: job.title, limit: "20", includeGuids: "1" });
  const r = await fetch(`${PLEX.base}hubs/search?${q}`, { headers: { "X-Plex-Token": token, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`plex search -> ${r.status}`);
  const guid = `${job.media_type === "movie" ? "tmdb" : "tvdb"}://${job.ext_id}`;
  const hits = (((await r.json()) as any).MediaContainer?.Hub ?? []).flatMap((h: any) => h.Metadata ?? []);
  const hit = hits.find((m: any) => (m.Guid ?? []).some((g: any) => g.id === guid));
  if (!hit) return false;
  if (job.media_type === "movie") return true;
  const r2 = await fetch(`${PLEX.base}library/metadata/${hit.ratingKey}/children`, { headers: { "X-Plex-Token": token, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  const s = (((await r2.json()) as any).MediaContainer?.Metadata ?? []).find((x: any) => x.index === job.season);
  return !!s && s.leafCount > 0;
}

// Ask Plex to look for new files when the Arr has it but Plex doesn't yet.
export async function plexScan(job: Job) {
  const token = secret(PLEX.prefs, /PlexOnlineToken="([^"]+)"/);
  const section = job.service === "anime_movie" ? 8 : job.service === "anime_series" ? 3 : job.media_type === "movie" ? 1 : 2;
  await fetch(`${PLEX.base}library/sections/${section}/refresh`, { headers: { "X-Plex-Token": token }, signal: AbortSignal.timeout(15_000) }).catch(() => {});
}

// ---------------------------------------------------------------- changes

// Add one film or one season and start the search.
export async function acquire(store: Store, number: string, option: string, season: number | null): Promise<{ job: Job; already: boolean }> {
  const { kind, id } = parseRef(option);
  const c = store.candidate(number, kind, id);
  if (!c) throw new PublicError("I need to look that title up again first.");
  if (kind === "series") {
    if (!season || !Number.isInteger(season)) throw new PublicError("Which season would you like?");
    if (c.seasons && !c.seasons.includes(season)) throw new PublicError(`I can't find a season ${season} of that.`);
  } else season = null;

  const jobId = `${number}:${kind}:${id}:${season ?? 0}`;
  const existing = store.job(jobId);
  if (existing && !["failed", "cancelled"].includes(existing.state)) return { job: existing, already: true };

  const have = await findItem(kind, id);
  const svc: Service = have?.svc ?? (c.anime ? (kind === "movie" ? "anime_movie" : "anime_series") : kind);
  // Write the intent before touching anything, so a crash mid-way is visible
  // to the watcher rather than silently lost.
  if (existing) store.restartJob(jobId, svc);
  else store.insertJob({ id: jobId, number, media_type: kind, service: svc, title: c.title, year: c.year, ext_id: id, season, state: "queued" });
  store.jobEvent(jobId, "requested", { svc, season, hard: !!c.hard });

  if (have && (await progress(store.job(jobId)!)).state === "on_disk") {
    store.jobEvent(jobId, "already_on_disk", {});
    return { job: store.job(jobId)!, already: true };
  }

  const s = SERVICES[svc];
  let item = have?.item;
  if (!item) {
    const full = ((await api(svc, `${resource(svc)}/lookup?term=${kind === "movie" ? "tmdb" : "tvdb"}:${id}`)) as any[]).find((x) => x[idField(kind)] === id);
    if (!full) throw new PublicError("I can't find that one to add.");
    const body: any = { ...full, qualityProfileId: s.profile, rootFolderPath: s.root, monitored: true };
    if (kind === "movie") {
      body.minimumAvailability = "released";
      body.addOptions = { searchForMovie: false };
    } else {
      body.seasonFolder = true;
      if (svc === "anime_series") body.seriesType = "anime";
      body.seasons = (full.seasons ?? []).map((x: any) => ({ ...x, monitored: x.seasonNumber === season }));
      body.addOptions = { searchForMissingEpisodes: false, monitor: "none" };
    }
    item = await api(svc, resource(svc), "POST", body);
    store.jobEvent(jobId, "added", { svc, profile: s.profile, root: s.root });
  }
  let command: any;
  if (kind === "series") {
    await monitorSeason(svc, item.id, season!);
    command = await api(svc, "command", "POST", { name: "SeasonSearch", seriesId: item.id, seasonNumber: season });
  } else {
    if (!item.monitored) item = await api(svc, `movie/${item.id}`, "PUT", { ...item, monitored: true });
    command = await api(svc, "command", "POST", { name: "MoviesSearch", movieIds: [item.id] });
  }
  store.jobEvent(jobId, "search_started", { command: command?.id ?? null });
  store.setJobState(jobId, "searching");
  return { job: store.job(jobId)!, already: false };
}

// Monitor one season and its episodes; leave every other season as it was.
// A freshly added series is still being refreshed in the background (and that
// refresh applies the add-time monitoring), so wait until its episodes exist
// and the refresh has finished, then set the episodes explicitly.
export async function monitorSeason(svc: Service, seriesId: number, season: number) {
  if (DRY_RUN) return;
  let eps: any[] = [];
  for (let i = 0; i < 30; i++) {
    eps = ((await api(svc, `episode?seriesId=${seriesId}`)) as any[]).filter((e) => e.seasonNumber === season);
    if (eps.length) break;
    await Bun.sleep(1000);
  }
  if (!eps.length) throw new Error(`series ${seriesId} season ${season}: no episodes after refresh`);
  for (let i = 0; i < 30; i++) {
    const busy = ((await api(svc, "command")) as any[]).some(
      (c) => ["queued", "started"].includes(c.status) && (c.body?.seriesId === seriesId || c.body?.seriesIds?.includes(seriesId)),
    );
    if (!busy) break;
    await Bun.sleep(1000);
  }
  const item = await api(svc, `series/${seriesId}`);
  await api(svc, `series/${seriesId}`, "PUT", {
    ...item,
    monitored: true,
    seasons: item.seasons.map((x: any) => (x.seasonNumber === season ? { ...x, monitored: true } : x)),
  });
  await api(svc, "episode/monitor", "PUT", { episodeIds: eps.map((e) => e.id), monitored: true });
}

// A stalled or broken download: throw it away, blocklist that release so it
// isn't picked again, and search for another copy. Returns what was done.
export async function retry(job: Job): Promise<string> {
  const found = await findItem(job.media_type, job.ext_id);
  if (!found) return "not in the library";
  const { svc, item } = found;
  const queue = await api(svc, "queue?page=1&pageSize=1000&includeEpisode=true");
  const mine = ((queue?.records ?? []) as any[]).filter((q) =>
    job.media_type === "movie" ? q.movieId === item.id : q.seriesId === item.id && (q.episode?.seasonNumber ?? q.seasonNumber) === job.season,
  );
  const seen = new Set<string>();
  for (const q of mine) {
    if (seen.has(q.downloadId)) continue;
    seen.add(q.downloadId);
    await api(svc, `queue/${q.id}?removeFromClient=true&blocklist=true&skipRedownload=true`, "DELETE");
  }
  await api(svc, "command", "POST", job.media_type === "movie" ? { name: "MoviesSearch", movieIds: [item.id] } : { name: "SeasonSearch", seriesId: item.id, seasonNumber: job.season });
  return mine.length ? `removed and blocklisted ${seen.size} release(s), searched again` : "nothing was downloading; searched again";
}

// Someone changed their mind. Their request stops (no more updates). The
// download is stopped too, unless someone else wants the same thing or it's
// already there; nothing is ever deleted from the library.
export async function cancel(store: Store, job: Job): Promise<string> {
  store.setJobState(job.id, "cancelled");
  store.jobEvent(job.id, "cancelled", {});
  const others = store
    .openJobs()
    .filter((j) => j.id !== job.id && j.media_type === job.media_type && j.ext_id === job.ext_id && j.season === job.season);
  if (others.length) return "cancelled for them; someone else still wants it, so it carries on downloading";
  const found = await findItem(job.media_type, job.ext_id);
  if (!found) return "cancelled";
  const { svc, item } = found;
  const queue = await api(svc, "queue?page=1&pageSize=1000&includeEpisode=true");
  const mine = ((queue?.records ?? []) as any[]).filter((q) =>
    job.media_type === "movie" ? q.movieId === item.id : q.seriesId === item.id && (q.episode?.seasonNumber ?? q.seasonNumber) === job.season,
  );
  const seen = new Set<string>();
  for (const q of mine) {
    if (seen.has(q.downloadId)) continue;
    seen.add(q.downloadId);
    await api(svc, `queue/${q.id}?removeFromClient=true&blocklist=false`, "DELETE");
  }
  if (job.media_type === "movie") {
    if (!item.hasFile && item.monitored) await api(svc, `movie/${item.id}`, "PUT", { ...item, monitored: false });
  } else {
    const eps = ((await api(svc, `episode?seriesId=${item.id}`)) as any[]).filter((e) => e.seasonNumber === job.season && !e.hasFile);
    if (eps.length) await api(svc, "episode/monitor", "PUT", { episodeIds: eps.map((e) => e.id), monitored: false });
    const has = (item.seasons ?? []).find((x: any) => x.seasonNumber === job.season)?.statistics?.episodeFileCount ?? 0;
    if (!has) await api(svc, `series/${item.id}`, "PUT", { ...item, seasons: item.seasons.map((x: any) => (x.seasonNumber === job.season ? { ...x, monitored: false } : x)) });
  }
  store.jobEvent(job.id, "download_stopped", { removed: seen.size });
  return seen.size ? "cancelled and the download stopped" : "cancelled";
}

// Why nothing's been grabbed, as a plain fact: ask the indexers what exists
// right now (read-only) and why each copy was turned down.
export async function probe(job: Job): Promise<{ copies: number; usable: number; summary: string }> {
  const found = await findItem(job.media_type, job.ext_id);
  if (!found) return { copies: 0, usable: 0, summary: "not in the library" };
  const { svc, item } = found;
  const rel = (await api(svc, job.media_type === "movie" ? `release?movieId=${item.id}` : `release?seriesId=${item.id}&seasonNumber=${job.season}`)) as any[];
  const mine = job.media_type === "movie" ? rel : rel.filter((r) => !/unknown series/i.test((r.rejections ?? []).join(" ")));
  const usable = mine.filter((r) => !r.rejected);
  const reasons = [...new Set(mine.filter((r) => r.rejected).flatMap((r) => r.rejections ?? []))].slice(0, 3);
  const best = [...mine].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))[0];
  const summary = !mine.length
    ? "no copies exist on the indexers at all right now"
    : usable.length
      ? `${usable.length} usable cop${usable.length === 1 ? "y" : "ies"} exist (best: ${best?.title}, ${best?.seeders ?? "?"} seeders)`
      : `${mine.length} cop${mine.length === 1 ? "y exists" : "ies exist"} but none were taken automatically: ${reasons.join("; ")} (best: ${best?.title}, ${best?.seeders ?? "?"} seeders)`;
  return { copies: mine.length, usable: usable.length, summary };
}

// The IMDb page for a job's title, from whichever instance holds it.
export async function imdbLink(job: Job): Promise<string | null> {
  const found = await findItem(job.media_type, job.ext_id).catch(() => null);
  const id = found?.item?.imdbId;
  return id ? `https://www.imdb.com/title/${id}/` : null;
}

// ---------------------------------------------------------------- words

// What a guest may be told about a job. Plain words only.
export function describeJob(j: Job) {
  const what = j.media_type === "series" ? `${j.title} season ${j.season}` : `${j.title}${j.year ? ` (${j.year})` : ""}`;
  const pct = j.percent != null && j.percent > 0 && j.percent < 100 ? `, about ${j.percent}% done` : "";
  const eta = j.eta ? `, expected ${humanWhen(j.eta)}` : "";
  const state: Record<string, string> = {
    queued: "being set up",
    searching: "being looked for",
    downloading: `downloading${pct}${eta}`,
    importing: "almost ready",
    on_disk: "almost ready",
    attention: "hit a snag; another copy is being tried",
    retrying: "stalled, so another copy is being tried",
    waiting_release: `not out yet${j.release_date ? ` (due ${humanDate(j.release_date)})` : ""}; it'll be fetched once it is`,
    ready: "ready to watch on Plex",
    stuck: "taking longer than usual; it's being looked into",
    parked: "couldn't be found anywhere right now; paused, with Tom looking into it, and it'll arrive automatically if a copy turns up",
    failed: "couldn't be found",
    cancelled: "cancelled",
  };
  return `${what}: ${state[j.state] ?? "in progress"}`;
}

export function humanDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function humanWhen(iso: string) {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return "shortly";
  if (ms < 90 * 60_000) return `in about ${Math.max(5, Math.round(ms / 60_000 / 5) * 5)} minutes`;
  if (ms < 36 * 3_600_000) return `in about ${Math.round(ms / 3_600_000)} hours`;
  return `around ${humanDate(iso)}`;
}
