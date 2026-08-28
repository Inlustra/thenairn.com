/**
 * ── THE PENDING ADAPTER ──────────────────────────────────────────────
 *
 * Every contract surface the server does not implement yet lives HERE and
 * nowhere else. Views never know which half of the contract they are
 * talking to. Each section below documents the server work it stands in
 * for; the full ledger is docs/api-gaps.md.
 *
 * Ground rules for this file:
 *  - Derive from real server data wherever possible (read state counts
 *    against the real chapter lists; source health against the real
 *    download tasks).
 *  - Where derivation is impossible (registry facts), representative data
 *    comes from the REAL 2026-08-28 registry harvest recorded in
 *    docs/upstream.md — real numbers, keyed by the real series titles.
 *  - Local persistence (localStorage) is used so flows are exercisable,
 *    and is explicitly NOT the store of record. When the server route
 *    lands, the localStorage layer is deleted with this entry.
 */

import { store } from "../lib";
import { library, downloads, status, scan } from "./real";
import type {
  ReadStateApi,
  SeriesReadState,
  ContinuePoint,
  IdentityApi,
  IdentityBinding,
  RegistryFacts,
  EvidenceRow,
  SourceHealthApi,
  SourceHealth,
  SurveyApi,
  SurveyRow,
  RulesApi,
  SyncRule,
  FreshnessApi,
  SeriesFreshness,
  FlagsApi,
  ContentFlag,
  JobsApi,
  Job,
} from "./contract";

/* ------------------------------------------------------------------ */
/* Read state                                                          */
/*                                                                     */
/* STANDS IN FOR: GET/PUT /api/readstate/* — persisted read positions   */
/* with furthest-wins merge. Server work is underway in src/readstate/ */
/* (store, schema, resolver, Tachiyomi import). Until those routes are  */
/* mounted, positions live in this browser only: honest for one         */
/* device, wrong across devices — which is exactly the gap.             */
/* ------------------------------------------------------------------ */

const rsKey = (seriesId: string) => `pb:rs:${seriesId}`;
const RAIL_KEY = "pb:continue-rail";

export const readState: ReadStateApi = {
  async series(seriesId) {
    return (
      store.get<SeriesReadState>(rsKey(seriesId)) ?? { seriesId, chapters: {} }
    );
  },

  async setPosition(seriesId, chapterId, page, pageCount) {
    const s = store.get<SeriesReadState>(rsKey(seriesId)) ?? { seriesId, chapters: {} };
    const prev = s.chapters[chapterId];
    // Furthest wins, mirroring the designed server merge.
    const furthest = Math.max(page, prev?.page ?? 0);
    s.chapters[chapterId] = {
      chapterId,
      page: furthest,
      pageCount,
      read: (prev?.read ?? false) || furthest >= pageCount - 1,
      updatedAt: Date.now(),
    };
    store.set(rsKey(seriesId), s);
  },

  async markRead(seriesId, chapterId, read) {
    const s = store.get<SeriesReadState>(rsKey(seriesId)) ?? { seriesId, chapters: {} };
    const prev = s.chapters[chapterId];
    s.chapters[chapterId] = {
      chapterId,
      page: prev?.page ?? 0,
      pageCount: prev?.pageCount ?? 0,
      read,
      updatedAt: Date.now(),
    };
    store.set(rsKey(seriesId), s);
  },

  async continueRail(limit = 3) {
    return (store.get<ContinuePoint[]>(RAIL_KEY) ?? []).slice(0, limit);
  },

  async unreadCounts() {
    const lib = await library.list({ limit: 100 });
    const out: Record<string, number> = {};
    for (const m of lib.data) {
      const s = store.get<SeriesReadState>(rsKey(m.id));
      const read = s ? Object.values(s.chapters).filter((c) => c.read).length : 0;
      out[m.id] = Math.max(0, m.chapterCount - read);
    }
    return out;
  },
};

/** Called by the reader; keeps the Continue rail current. */
export function recordContinue(point: ContinuePoint): void {
  const rail = (store.get<ContinuePoint[]>(RAIL_KEY) ?? []).filter(
    (p) => p.seriesId !== point.seriesId,
  );
  rail.unshift(point);
  store.set(RAIL_KEY, rail.slice(0, 8));
}

/* ------------------------------------------------------------------ */
/* Identity — registry binding                                         */
/*                                                                     */
/* STANDS IN FOR: /api/identity/* — one registry binding per series,    */
/* established by evidence-corroborated matching (docs/upstream.md),    */
/* stored once as provider IDs, re-scored as chapters arrive. Needs a   */
/* provider abstraction (MangaUpdates, AniList, Comic Vine, Metron)     */
/* and the confirm/reject/files-only flow.                              */
/*                                                                     */
/* The bindings below are the REAL results of the 2026-08-28 harvest    */
/* measured against this library (docs/upstream.md, "Matching"):        */
/* real registry chapter counts, the two confidently-wrong matches,     */
/* the Warhammer unconfigured case. Confirm/reject decisions are        */
/* overlaid in localStorage so the flows work end to end in a browser.  */
/* ------------------------------------------------------------------ */

const norm = (t: string) =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function mu(over: Partial<RegistryFacts> & { canonicalTitle: string }): RegistryFacts {
  return {
    provider: "MangaUpdates",
    registryId: `mu:${norm(over.canonicalTitle).replace(/ /g, "-")}`,
    status: "unknown",
    latestChapter: null,
    cadenceDays: null,
    cadenceLabel: null,
    asOf: "2026-08-28",
    seasons: [],
    ...over,
  };
}

const ev = (fact: string, verdict: EvidenceRow["verdict"]): EvidenceRow => ({ fact, verdict });

/** Keyed by normalised on-disk title. Every number is from the harvest. */
const HARVEST: Record<string, Omit<IdentityBinding, "seriesId">> = {
  [norm("Nano Machine")]: {
    state: "identified",
    alsoConfirmedBy: "AniList",
    registry: mu({
      canonicalTitle: "Nano Machine",
      nativeTitle: "나노마신",
      status: "ongoing",
      latestChapter: 327,
      cadenceDays: 7,
      cadenceLabel: "weekly · Wed",
      year: 2020,
      seasons: [{ name: "Season 1", endAfterSortKey: 142 }],
    }),
  },
  [norm("Solo Leveling")]: {
    state: "identified",
    registry: mu({
      canonicalTitle: "Solo Leveling",
      status: "complete",
      latestChapter: 201,
      year: 2018,
      cadenceLabel: "complete",
    }),
  },
  [norm("Return of the Disaster-Class Hero")]: {
    state: "identified",
    registry: mu({
      canonicalTitle: "The Return of the Disaster-Class Hero",
      status: "ongoing",
      latestChapter: 186,
      cadenceDays: 7,
      cadenceLabel: "weekly",
      year: 2021,
    }),
  },
  [norm("SSS-Class Suicide Hunter")]: {
    state: "identified",
    registry: mu({
      canonicalTitle: "SSS-Class Revival Hunter",
      status: "hiatus",
      latestChapter: 151,
      year: 2020,
      cadenceLabel: "on hiatus",
      seasons: [
        { name: "Season 3", endAfterSortKey: 115 },
        { name: "Season 4", endAfterSortKey: 151 },
      ],
    }),
  },
  [norm("Trash of the Count's Family")]: {
    state: "guess",
    registry: null,
    candidate: {
      provider: "MangaUpdates",
      title: "Lout of Count's Family",
      nameScore: 0.75,
      evidence: [
        ev("Different English rendering of the same Korean title", "agree"),
        ev("Chapter count sane: you hold 176 · it stands at 185", "agree"),
        ev("Alternative titles agree in other languages", "agree"),
        ev("Cover palette: not yet compared", "unknown"),
      ],
    },
  },
  [norm("Omniscient Reader's Viewpoint")]: {
    state: "contradicted",
    registry: null,
    candidate: {
      provider: "MangaUpdates",
      title: "Omniscient Reader's Viewpoint (Novel)",
      nameScore: 0.91,
      evidence: [
        ev("Name nearly exact", "agree"),
        ev("It is a novel — this folder holds 201 chapters of page images", "contradict"),
        ev("Its latest chapter is 42 — you hold 201. Can't be the same thing.", "contradict"),
      ],
    },
  },
  [norm("The Greatest Estate Developer")]: {
    state: "contradicted",
    registry: null,
    candidate: {
      provider: "MangaUpdates",
      title: "The Greatest Estate Developer (Novel)",
      nameScore: 0.91,
      evidence: [
        ev("Name nearly exact", "agree"),
        ev("It is a novel — this folder holds image chapters", "contradict"),
        ev("Its latest chapter is 0 — you hold 219. Impossible.", "contradict"),
      ],
    },
  },
  [norm("Reincarnation of the Suicidal Battle God")]: {
    state: "guess",
    registry: null,
    candidate: {
      provider: "MangaUpdates",
      title: "Reincarnation of the Martial God",
      nameScore: 0.78,
      evidence: [
        ev("Name partially agrees", "agree"),
        ev("Candidate began 2025 with 27 chapters — you hold 102. Impossible.", "contradict"),
      ],
    },
  },
  [norm("The S-Classes That I Raised")]: {
    state: "identified",
    registry: mu({
      canonicalTitle: "My S-Class Hunters",
      status: "ongoing",
      latestChapter: null, // the registry keeps no release records for it
      cadenceLabel: null,
    }),
  },
  [norm("Warhammer 40,000")]: {
    state: "unconfigured",
    registry: null,
    suggestedProvider: "Comic Vine",
  },
  [norm("Warhammer 40,000: Exterminatus")]: {
    state: "unconfigured",
    registry: null,
    suggestedProvider: "Comic Vine",
  },
  [norm("Warhammer 40,000: Marneus Calgar")]: {
    state: "unconfigured",
    registry: null,
    suggestedProvider: "Comic Vine",
  },
};

interface IdentityOverlay {
  state?: IdentityBinding["state"];
  confirmed?: boolean;
}
const idKey = (seriesId: string) => `pb:identity:${seriesId}`;

function resolveBinding(seriesId: string, title: string): IdentityBinding {
  const base = HARVEST[norm(title)];
  const overlay = store.get<IdentityOverlay>(idKey(seriesId));
  let binding: IdentityBinding = base
    ? { seriesId, ...base }
    : { seriesId, state: "unmatched", registry: null };
  if (overlay?.confirmed && binding.candidate) {
    // A confirmed guess becomes an identified binding with the candidate's
    // facts promoted — mirroring "store the confirmed mapping, never re-guess".
    binding = {
      seriesId,
      state: "identified",
      registry: mu({
        canonicalTitle: binding.candidate.title,
        status: "ongoing",
        latestChapter: 185, // Lout of Count's Family — the real registry count
        cadenceLabel: "weekly",
      }),
    };
  } else if (overlay?.state) {
    binding = { ...binding, state: overlay.state };
  }
  return binding;
}

export const identity: IdentityApi = {
  async get(seriesId) {
    const detail = await library.get(seriesId);
    return resolveBinding(seriesId, detail.title);
  },
  async all() {
    const lib = await library.list({ limit: 100 });
    const out: Record<string, IdentityBinding> = {};
    for (const m of lib.data) out[m.id] = resolveBinding(m.id, m.title);
    return out;
  },
  async confirm(seriesId) {
    store.set(idKey(seriesId), { confirmed: true } satisfies IdentityOverlay);
  },
  async reject(seriesId) {
    store.set(idKey(seriesId), { state: "unmatched" } satisfies IdentityOverlay);
  },
  async keepFilesOnly(seriesId) {
    store.set(idKey(seriesId), { state: "files-only" } satisfies IdentityOverlay);
  },
  async search() {
    // Registry search needs the provider abstraction server-side; there is
    // nothing honest to return from a browser.
    return [];
  },
};

/* ------------------------------------------------------------------ */
/* Source health                                                       */
/*                                                                     */
/* STANDS IN FOR: /api/sources/health — per-source state derived from   */
/* fetch outcomes (rate limits, block pages, connection refusals) and,  */
/* with a registry bound, stall detection: source quiet while the       */
/* series publishes. DERIVED here from the real download tasks — real   */
/* errors produce real "cooling"/"down" rows — but with no history      */
/* beyond this session and no stall detection at all.                   */
/* ------------------------------------------------------------------ */

export const sourceHealth: SourceHealthApi = {
  async all() {
    const [tasks, lib] = await Promise.all([downloads.list(), library.list({ limit: 100 })]);
    const bound = new Map<string, number>();
    for (const m of lib.data) {
      const sid = m.meta.sourceId;
      if (sid) bound.set(sid, (bound.get(sid) ?? 0) + 1);
    }
    const byId = new Map<string, SourceHealth>();
    for (const [sid, n] of bound) {
      byId.set(sid, {
        sourceId: sid,
        sourceName: sid.replace(/^mod-/, ""),
        state: "healthy",
        detail: "",
        lastFetchAt: null,
        seriesBound: n,
        waitingChapters: 0,
      });
    }
    for (const t of tasks) {
      const h = byId.get(t.sourceId) ?? {
        sourceId: t.sourceId,
        sourceName: t.sourceName,
        state: "healthy" as const,
        detail: "",
        lastFetchAt: null,
        seriesBound: 0,
        waitingChapters: 0,
      };
      h.sourceName = t.sourceName || h.sourceName;
      h.lastFetchAt = Math.max(h.lastFetchAt ?? 0, t.updatedAt) || null;
      h.waitingChapters += t.chapters.filter((c) => c.status === "queued").length;
      const errs = t.chapters.map((c) => c.error ?? "").join(" ") + " " + (t.error ?? "");
      if (/rate|429|too many/i.test(errs)) {
        h.state = "cooling";
        h.detail = "Asked us to slow down · resumes itself";
      } else if (/block|cloudflare|403|refused|ECONN/i.test(errs)) {
        h.state = "down";
        h.detail = "Not answering normally · your chapters are untouched";
      }
      byId.set(t.sourceId, h);
    }
    return [...byId.values()];
  },
  async forSource(sourceId) {
    const all = await sourceHealth.all();
    return all.find((h) => h.sourceId === sourceId) ?? null;
  },
};

/* ------------------------------------------------------------------ */
/* Look elsewhere — the survey                                         */
/*                                                                     */
/* STANDS IN FOR: /api/series/:id/survey — ask every configured source  */
/* what it actually holds for a series, ordered by the registry's own   */
/* record of who is publishing it now. Needs per-source chapter-list    */
/* probing server-side (the Lua modules can already list chapters; the  */
/* survey is orchestration + caching + politeness). The rows here are   */
/* representative; the current-source row is real.                      */
/* ------------------------------------------------------------------ */

export const survey: SurveyApi = {
  async run(seriesId) {
    const detail = await library.get(seriesId);
    const binding = resolveBinding(seriesId, detail.title);
    const latest = binding.registry?.latestChapter ?? detail.chapterCount;
    const current = detail.meta.sourceId ?? "";
    const rows: SurveyRow[] = [
      {
        sourceId: current,
        sourceName: current.replace(/^mod-/, "") || "current source",
        holds: `Still at ${detail.chapterCount}`,
        coversWanted: 0,
        isCurrent: true,
        note: "keeps serving the chapters you already have",
      },
      {
        // Representative row — a real survey asks the source itself.
        sourceId: "mod-weebcentral",
        sourceName: "weebcentral",
        holds: `Claims 1–${latest}`,
        coversWanted: Math.max(0, latest - detail.chapterCount),
        isCurrent: false,
        note: "its claim is unverified until chapters land",
      },
    ];
    return rows;
  },
  async adopt() {
    // Adopting a source needs the source's series URL, which only a real
    // survey can discover. PATCH /api/manga/:id/source exists for the manual
    // path (workbench → series → manage source).
    throw new Error("Set the source on the series in the workbench instead.");
  },
};

/* ------------------------------------------------------------------ */
/* Rules — selective sync                                              */
/*                                                                     */
/* STANDS IN FOR: /api/rules — the rule store (docs/rules.md, designed  */
/* not built). Rules are authored on devices; the web renders them      */
/* read-only. One representative rule is returned so the workbench      */
/* surface is exercised; a real store returns the household's rules     */
/* with their current resolution computed server-side.                  */
/* ------------------------------------------------------------------ */

export const rules: RulesApi = {
  async list() {
    const sample: SyncRule = {
      id: "sample-rule",
      scope: { kind: "window", ref: "nano-machine", n: 10 },
      trigger: "standing",
      retention: { kind: "keep" },
      priority: 1,
      resolved: { chapters: 10, bytes: 74 * 1048576 },
      deviceId: "sample-device",
      deviceName: "(sample — no device has paired; the rule store is not built)",
    };
    return [sample];
  },
};

/* ------------------------------------------------------------------ */
/* Freshness                                                           */
/*                                                                     */
/* STANDS IN FOR: per-series lastLookedAt from the rolling scan          */
/* scheduler (docs/scheduler.md, designed not built). DERIVED here      */
/* from the real library-wide lastScan — truthful today because every    */
/* scan is a full pass; wrong the day the rolling scheduler lands,      */
/* which is exactly when the real route must exist.                     */
/* ------------------------------------------------------------------ */

export const freshness: FreshnessApi = {
  async all() {
    const [st, lib] = await Promise.all([status.get(), library.list({ limit: 100 })]);
    const out: Record<string, SeriesFreshness> = {};
    for (const m of lib.data) {
      out[m.id] = {
        seriesId: m.id,
        lastLookedAt: st.library.lastScan,
        stale: Date.now() - st.library.lastScan > 6 * 3600_000, // the 6h floor deadline
      };
    }
    return out;
  },
};

/* ------------------------------------------------------------------ */
/* Flags — wrong content                                               */
/*                                                                     */
/* STANDS IN FOR: /api/flags — household-visible content flags that     */
/* outrank checksums, quarantine the source pairing, and queue the      */
/* look-elsewhere hunt. localStorage only: this browser sees its own    */
/* flags; the household does not, which is the gap.                     */
/* ------------------------------------------------------------------ */

const FLAGS_KEY = "pb:flags";

export const flags: FlagsApi = {
  async list() {
    return store.get<ContentFlag[]>(FLAGS_KEY) ?? [];
  },
  async flag(seriesId, chapterId, note) {
    const all = (store.get<ContentFlag[]>(FLAGS_KEY) ?? []).filter(
      (f) => !(f.seriesId === seriesId && f.chapterId === chapterId),
    );
    all.push({ seriesId, chapterId, flaggedAt: Date.now(), note });
    store.set(FLAGS_KEY, all);
  },
  async unflag(seriesId, chapterId) {
    const all = (store.get<ContentFlag[]>(FLAGS_KEY) ?? []).filter(
      (f) => !(f.seriesId === seriesId && f.chapterId === chapterId),
    );
    store.set(FLAGS_KEY, all);
  },
};

/* ------------------------------------------------------------------ */
/* Jobs — fallback                                                     */
/*                                                                     */
/* STANDS IN FOR: GET /api/jobs + POST /api/jobs/:id/cancel — the      */
/* background-work envelope (scan, cover generation, spine-art          */
/* extraction). Being built server-side alongside this client; the      */
/* composed client (index.ts) tries the real route first and lands      */
/* here only on a 404. DERIVED from the real scan-progress endpoint:    */
/* an active scan shows as the one job the server can already report.   */
/* Art and cover work is invisible from a browser until the route       */
/* answers, so no rows are invented for it. See docs/api-gaps.md #11.   */
/* ------------------------------------------------------------------ */

export const jobsFallback: JobsApi = {
  async list() {
    const p = await scan.progress();
    if (!p.active) return { jobs: [], running: 0, queued: 0 };
    const job: Job = {
      id: "scan",
      kind: "scan",
      scope: p.scope,
      label: p.currentSeries
        ? `Looking at ${p.currentSeries}`
        : "Looking through the library",
      state: "running",
      done: p.seriesDone,
      total: p.seriesTotal || null,
      startedAt: p.startedAt,
      finishedAt: null,
      error: null,
    };
    return { jobs: [job], running: 1, queued: 0 };
  },
  async cancel() {
    // No cancel route exists yet server-side; nothing honest to do here.
    throw new Error("Could not stop it.");
  },
};
