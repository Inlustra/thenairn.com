// Plex, read-only: what's in the library (so Milo can suggest what's actually
// there) and what a linked person has watched (so he can suggest well).
//
// Never the private library (section 5, "Anime2"): it's excluded from
// browsing and from history. Anime sections only for people allowed anime.
import { readFileSync } from "node:fs";

const BASE = "http://plex:32400/";
const PREFS = "/mnt/user/Config/plex/Library/Application Support/Plex Media Server/Preferences.xml";
const SECTIONS = { film: [1], series: [2], anime_film: [8], anime_series: [3] } as const;
const HIDDEN_SECTIONS = new Set(["5"]);
// Ratings suitable for young children (UK and US, as Plex reports them).
const KIDS = new Set(["gb/U", "gb/PG", "G", "PG", "TV-Y", "TV-Y7", "TV-G", "TV-PG", "U", "gb/UC"]);

let token: string | null = null;
async function plex(path: string): Promise<any> {
  token ??= readFileSync(PREFS, "utf8").match(/PlexOnlineToken="([^"]+)"/)?.[1] ?? null;
  if (!token) throw new Error("no plex token");
  const r = await fetch(BASE + path, { headers: { "X-Plex-Token": token, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`plex ${path.split("?")[0]} -> ${r.status}`);
  return ((await r.json()) as any).MediaContainer ?? {};
}

type Item = { title: string; year?: number; kind: "film" | "series"; rating?: string; genres: string[]; about: string; runtime?: string; seasons?: number; added: number; score?: number };

// Whole sections change slowly; cache them for ten minutes.
const cache = new Map<number, { at: number; items: Item[] }>();
async function section(id: number, kind: "film" | "series"): Promise<Item[]> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.items;
  const m = await plex(`library/sections/${id}/all`);
  const items: Item[] = (m.Metadata ?? []).map((x: any) => ({
    title: x.title,
    year: x.year,
    kind,
    rating: x.contentRating,
    genres: (x.Genre ?? []).map((g: any) => g.tag),
    about: String(x.summary ?? "").slice(0, 220),
    runtime: x.duration && kind === "film" ? `${Math.round(x.duration / 60_000)} min` : undefined,
    seasons: kind === "series" ? x.childCount : undefined,
    added: (x.addedAt ?? 0) * 1000,
    score: x.audienceRating ?? x.rating,
  }));
  cache.set(id, { at: Date.now(), items });
  return items;
}

export type Browse = { kind?: "film" | "series" | "any"; genre?: string; kids?: boolean; recent_days?: number; text?: string; limit?: number; anime?: boolean };

export async function browse(q: Browse): Promise<Item[]> {
  const kinds = q.kind === "film" ? ["film"] : q.kind === "series" ? ["series"] : ["film", "series"];
  const ids: [number, "film" | "series"][] = [];
  for (const k of kinds as ("film" | "series")[]) {
    for (const id of SECTIONS[k]) ids.push([id, k]);
    if (q.anime) for (const id of SECTIONS[k === "film" ? "anime_film" : "anime_series"]) ids.push([id, k]);
  }
  let items = (await Promise.all(ids.map(([id, k]) => section(id, k)))).flat();
  const g = q.genre?.toLowerCase();
  if (g) items = items.filter((x) => x.genres.some((y) => y.toLowerCase().includes(g)));
  if (q.kids) items = items.filter((x) => x.rating && KIDS.has(x.rating));
  if (q.recent_days) items = items.filter((x) => x.added > Date.now() - q.recent_days! * 86_400_000);
  const t = q.text?.toLowerCase();
  if (t) items = items.filter((x) => x.title.toLowerCase().includes(t) || x.about.toLowerCase().includes(t));
  items.sort((a, b) => (q.recent_days ? b.added - a.added : (b.score ?? 0) - (a.score ?? 0)));
  return items.slice(0, Math.min(q.limit ?? 12, 25));
}

// Accounts that can watch on this server, with how much they've watched.
export async function accounts(): Promise<{ id: number; name: string; plays: number; last?: string }[]> {
  const [a, h] = await Promise.all([plex("accounts"), plex("status/sessions/history/all?sort=viewedAt:desc")]);
  const plays = new Map<number, { n: number; at: number }>();
  for (const x of h.Metadata ?? []) {
    const p = plays.get(x.accountID) ?? { n: 0, at: 0 };
    plays.set(x.accountID, { n: p.n + 1, at: Math.max(p.at, x.viewedAt ?? 0) });
  }
  return (a.Account ?? [])
    .filter((x: any) => x.id > 0 && x.name)
    .map((x: any) => ({ id: x.id, name: x.name, plays: plays.get(x.id)?.n ?? 0, last: plays.get(x.id)?.at ? new Date(plays.get(x.id)!.at * 1000).toISOString().slice(0, 10) : undefined }));
}

// What one account has watched lately, newest first: films, and for series
// the furthest episode reached.
export async function history(accountId: number, limit = 15): Promise<string[]> {
  const h = await plex(`status/sessions/history/all?accountID=${accountId}&sort=viewedAt:desc`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of h.Metadata ?? []) {
    if (HIDDEN_SECTIONS.has(String(x.librarySectionID))) continue;
    if (x.type !== "movie" && x.type !== "episode") continue;
    const when = new Date((x.viewedAt ?? 0) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const key = x.type === "movie" ? `m:${x.title}` : `s:${x.grandparentTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x.type === "movie" ? `${x.title} (film, ${when})` : `${x.grandparentTitle} (up to S${x.parentIndex}E${x.index}, ${when})`);
    if (out.length >= limit) break;
  }
  return out;
}
