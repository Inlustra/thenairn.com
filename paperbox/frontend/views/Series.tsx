/**
 * One series, in hand. Header that knows who the series is; the chapter
 * list as the default view with the spine shelf one visible tap away —
 * a first-class peer, remembered per series per client. Both views render
 * the same states with the same verbs.
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type {
  SeriesDetail,
  ChapterInfo,
  IdentityBinding,
  DownloadTask,
  SeriesReadState,
  ContentFlag,
  SeriesFreshness,
  JobsEnvelope,
} from "../api/contract";
import { coverArtUrl } from "../api/contract";
import { Glyph, Line, Weather, NeedsYou, Evidence, InkBar, type GlyphState } from "../ui";
import { store, timeAgo, clock, derivedWorkFor } from "../lib";
import { SpineShelf } from "./SpineShelf";

/* ------------------------------------------------------------------ */
/* Derived chapter state                                               */
/* ------------------------------------------------------------------ */

export interface ChapterRow {
  chapter: ChapterInfo;
  glyph: GlyphState;
  fill: number;
  read: boolean;
  readingNow: boolean;
  page: number | null;
  flagged: boolean;
  taskId?: string;
  error?: string;
}

/** A pencil row for a chapter a task carries that is not on disk yet. */
export interface PencilRow {
  name: string;
  glyph: GlyphState;
  fill: number;
  pagesDone: number;
  pagesTotal: number;
  taskId: string;
  error?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function deriveRows(
  detail: SeriesDetail,
  tasks: DownloadTask[],
  rs: SeriesReadState | null,
  flags: ContentFlag[],
): { rows: ChapterRow[]; pencil: PencilRow[] } {
  const mine = tasks.filter(
    (t) => t.mangaTitle.trim().toLowerCase() === detail.title.trim().toLowerCase(),
  );
  const heldNorm = new Map(detail.chapters.map((c) => [norm(c.dir), c.id]));
  const flaggedSet = new Set(flags.filter((f) => f.seriesId === detail.id).map((f) => f.chapterId));

  // The chapter being read: the most recent unfinished position.
  let readingId: string | null = null;
  if (rs) {
    let best = 0;
    for (const c of Object.values(rs.chapters)) {
      if (!c.read && c.page > 0 && c.updatedAt > best) {
        best = c.updatedAt;
        readingId = c.chapterId;
      }
    }
  }

  const pencil: PencilRow[] = [];
  const overlay = new Map<string, { glyph: GlyphState; fill: number; taskId: string; error?: string }>();
  for (const t of mine) {
    for (const c of t.chapters) {
      if (c.status === "completed" || c.status === "cancelled") continue;
      const glyph: GlyphState =
        c.status === "failed" ? "needs-you" : c.status === "downloading" ? "inking" : "queued";
      const fill = c.pagesTotal > 0 ? c.pagesDownloaded / c.pagesTotal : 0;
      const heldId = heldNorm.get(norm(c.name));
      if (heldId) overlay.set(heldId, { glyph, fill, taskId: t.id, error: c.error });
      else
        pencil.push({
          name: c.name,
          glyph,
          fill,
          pagesDone: c.pagesDownloaded,
          pagesTotal: c.pagesTotal,
          taskId: t.id,
          error: c.error,
        });
    }
  }

  const rows: ChapterRow[] = detail.chapters.map((chapter) => {
    const o = overlay.get(chapter.id);
    const r = rs?.chapters[chapter.id];
    return {
      chapter,
      glyph: flaggedSet.has(chapter.id) ? "flagged" : (o?.glyph ?? "server"),
      fill: o?.fill ?? 1,
      read: r?.read ?? false,
      readingNow: chapter.id === readingId,
      page: r && !r.read && r.page > 0 ? r.page : null,
      flagged: flaggedSet.has(chapter.id),
      taskId: o?.taskId,
      error: o?.error,
    };
  });

  return { rows, pencil };
}

function sortRows(rows: ChapterRow[]): ChapterRow[] {
  return [...rows].sort((a, b) => {
    const sa = a.chapter.sequence, sb = b.chapter.sequence;
    if (sa !== sb) return sa === "main" ? -1 : sb === "main" ? 1 : sa.localeCompare(sb);
    return a.chapter.sortKey - b.chapter.sortKey || a.chapter.label.localeCompare(b.chapter.label);
  });
}

/** "Tuesday", or a clock time today, or a date — a dated word, never a timer. */
function lookedPhrase(t: number): string {
  const d = new Date(t);
  if (d.toDateString() === new Date().toDateString()) return `at ${clock(t)}`;
  if (Date.now() - t < 7 * 86400_000) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString();
}

/** Same candidate walk as the library cover: fetched, then generated, then nothing. */
function HeadCover({ detail }: { detail: SeriesDetail }) {
  const urls = [detail.coverUrl, coverArtUrl(detail.uid)].filter((u): u is string => !!u);
  const [at, setAt] = useState(0);
  if (at >= urls.length) return null;
  return <img src={urls[at]} alt="" onError={() => setAt(at + 1)} />;
}

/* ------------------------------------------------------------------ */
/* Identity line + sheet                                               */
/* ------------------------------------------------------------------ */

function IdentityLine({
  binding,
  onChanged,
}: {
  binding: IdentityBinding;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const b = binding;

  const act = async (fn: () => Promise<void>) => {
    await fn();
    setOpen(false);
    onChanged();
  };

  let line: React.ReactNode;
  switch (b.state) {
    case "identified":
      line = (
        <Line tone="quiet">
          Identified · {b.registry?.provider}
          {b.alsoConfirmedBy ? ` + ${b.alsoConfirmedBy}` : ""} ·{" "}
          <button className="linkish" onClick={() => setOpen(!open)}>change</button>
        </Line>
      );
      break;
    case "guess":
      line = (
        <Line tone="pencil">
          Best guess: {b.candidate?.title} —{" "}
          <button className="linkish" onClick={() => setOpen(!open)}>confirm?</button>
        </Line>
      );
      break;
    case "contradicted":
      line = (
        <Line tone="red">
          Probably not {b.candidate?.title} — the name fits, the facts don't.{" "}
          <button className="linkish" onClick={() => setOpen(!open)}>look</button>
        </Line>
      );
      break;
    case "unconfigured":
      line = (
        <Line tone="quiet">
          No connected registry knows this — {b.suggestedProvider} likely would, and it isn't
          connected. <button className="linkish" onClick={() => setOpen(!open)}>options</button>
        </Line>
      );
      break;
    case "files-only":
      line = <Line tone="quiet">Files only — your word, kept.</Line>;
      break;
    default:
      line = (
        <Line tone="quiet">
          Not identified. <button className="linkish" onClick={() => setOpen(!open)}>options</button>
        </Line>
      );
  }

  return (
    <div className="identity">
      {line}
      {open && (
        <div className="id-sheet">
          {b.candidate && (
            <>
              <p className="id-cand">
                {b.candidate.title} <span className="cap">· {b.candidate.provider}</span>
              </p>
              <Evidence rows={b.candidate.evidence} />
            </>
          )}
          {b.state === "identified" && b.registry && (
            <p className="cap">
              Bound to {b.registry.canonicalTitle} at {b.registry.provider} · card as of {b.registry.asOf}
            </p>
          )}
          <div className="id-verbs">
            {b.state === "guess" && (
              <button className="btn btn-primary" onClick={() => act(() => api.identity.confirm(b.seriesId, b.candidate!.provider, ""))}>
                Yes, that's it
              </button>
            )}
            {(b.state === "guess" || b.state === "contradicted" || b.state === "identified") && (
              <button className="btn" onClick={() => act(() => api.identity.reject(b.seriesId))}>
                Not this
              </button>
            )}
            <button className="btn" onClick={() => act(() => api.identity.keepFilesOnly(b.seriesId))}>
              Keep files-only
            </button>
          </div>
          {b.state === "unconfigured" && (
            <p className="cap">Connecting a registry takes a free key, added in the workbench once providers land.</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The view                                                            */
/* ------------------------------------------------------------------ */

export function SeriesView({
  id,
  tasks,
  jobsEnv,
  onBack,
  onRead,
  refreshTasks,
}: {
  id: string;
  tasks: DownloadTask[];
  jobsEnv: JobsEnvelope | null;
  onBack: () => void;
  onRead: (chapterId: string) => void;
  refreshTasks: () => void;
}) {
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [binding, setBinding] = useState<IdentityBinding | null>(null);
  const [rs, setRs] = useState<SeriesReadState | null>(null);
  const [flagList, setFlagList] = useState<ContentFlag[]>([]);
  const [fresh, setFresh] = useState<SeriesFreshness | null>(null);
  const [err, setErr] = useState("");
  const [view, setView] = useState<"list" | "shelf">(
    () => store.get<"list" | "shelf">(`pb:view:${id}`) ?? "list",
  );
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [getting, setGetting] = useState(false);
  const [getNote, setGetNote] = useState("");

  const load = () => {
    api.library.get(id).then(setDetail).catch(() => setErr("Could not open the series."));
    api.identity.get(id).then(setBinding).catch(() => {});
    api.readState.series(id).then(setRs).catch(() => {});
    api.flags.list().then(setFlagList).catch(() => {});
    api.freshness.all().then((f) => setFresh(f[id] ?? null)).catch(() => {});
  };
  useEffect(load, [id]);

  const { rows, pencil } = useMemo(
    () => (detail ? deriveRows(detail, tasks, rs, flagList) : { rows: [], pencil: [] }),
    [detail, tasks, rs, flagList],
  );
  const sorted = useMemo(() => sortRows(rows), [rows]);

  if (err) return <main className="series"><Line tone="quiet">{err}</Line></main>;
  if (!detail) return <main className="series" />;

  // Art/cover work standing against this series. A library-wide pass
  // (scope null) genuinely covers it, so it counts on this screen.
  const derived = derivedWorkFor(jobsEnv, detail.uid, true);
  const faceComing = derived?.kind === "running" || derived?.kind === "queued";

  const registry = binding?.state === "identified" ? binding.registry : null;
  const latest = registry?.latestChapter ?? null;
  const mainRows = sorted.filter((r) => r.chapter.sequence === "main");
  const firstKey = mainRows.find((r) => r.chapter.mark !== "")?.chapter.sortKey;
  const lastRow = [...mainRows].reverse().find((r) => r.chapter.mark !== "");
  const lastKey = lastRow?.chapter.sortKeyEnd ?? lastRow?.chapter.sortKey;
  const behind = latest && lastKey ? Math.max(0, latest - lastKey) : 0;
  const unreadCount = rows.filter((r) => !r.read).length;
  const resume = sorted.find((r) => r.readingNow) ?? sorted.find((r) => !r.read);
  const inflight = pencil.length + rows.filter((r) => r.glyph !== "server" && r.glyph !== "flagged").length;

  const setViewKeep = (v: "list" | "shelf") => {
    setView(v);
    store.set(`pb:view:${id}`, v);
  };

  /** Get: make it readable here. Queues everything the source has that we hold nothing for. */
  const getMissing = async () => {
    if (!detail.meta.sourceId || !detail.meta.link) return;
    setGetting(true);
    setGetNote("");
    try {
      const info = await api.sources.info(detail.meta.sourceId, detail.meta.link);
      const names = info.manga.chapterNames ?? [];
      const links = info.manga.chapterLinks ?? [];
      const held = new Set(detail.chapters.map((c) => norm(c.dir)));
      const queuedAlready = new Set(
        tasks
          .filter((t) => t.mangaTitle.trim().toLowerCase() === detail.title.trim().toLowerCase())
          .flatMap((t) => t.chapters)
          .filter((c) => c.status === "queued" || c.status === "downloading")
          .map((c) => norm(c.name)),
      );
      const want = names
        .map((name, i) => ({ name, url: links[i] ?? "" }))
        .filter((c) => c.url && !held.has(norm(c.name)) && !queuedAlready.has(norm(c.name)));
      if (want.length === 0) {
        setGetNote("The source lists nothing you don't hold.");
      } else {
        await api.downloads.create({
          mangaTitle: detail.title,
          sourceId: detail.meta.sourceId,
          mangaUrl: detail.meta.link,
          chapters: want,
        });
        // The timescale, said once, at the ask. Never an estimate.
        setGetNote(`Queued ${want.length} — fetching takes a while, no need to watch.`);
        refreshTasks();
      }
    } catch (e: any) {
      setGetNote(e?.message || "The source didn't answer.");
    } finally {
      setGetting(false);
    }
  };

  const toggleRead = async (r: ChapterRow) => {
    await api.readState.markRead(id, r.chapter.id, !r.read);
    api.readState.series(id).then(setRs).catch(() => {});
  };
  const toggleFlag = async (r: ChapterRow) => {
    if (r.flagged) await api.flags.unflag(id, r.chapter.id);
    else await api.flags.flag(id, r.chapter.id);
    api.flags.list().then(setFlagList).catch(() => {});
    api.freshness.all().then((f) => setFresh(f[id] ?? null)).catch(() => {});
  };

  const shown = unreadOnly ? sorted.filter((r) => !r.read) : sorted;

  return (
    <main className="series">
      <button className="back" onClick={onBack}>‹ Library</button>

      <header className="series-head">
        <div className="series-cover">
          <HeadCover detail={detail} />
        </div>
        <div className="series-facts">
          <h2>{detail.title}</h2>
          {registry?.nativeTitle && <p className="native">{registry.nativeTitle}</p>}
          <p className="byline">
            {[detail.meta.author, detail.meta.artist && `art ${detail.meta.artist}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {registry && (
            <p className="pulse">
              {registry.status}
              {registry.cadenceLabel ? ` · ${registry.cadenceLabel}` : ""}
            </p>
          )}

          {/* The hold line — behind-ness kept honest, three numbers apart. */}
          <p className="hold">
            You hold{" "}
            <strong>
              {firstKey != null && lastKey != null && lastKey > firstKey
                ? `${firstKey}–${lastKey}`
                : String(detail.chapterCount)}
            </strong>
            {latest ? <> of {latest} published</> : <> {firstKey != null ? "" : "chapters"}</>}
            {behind > 0 && inflight > 0 && <> · {inflight} on the way</>}
            {behind > 0 && inflight === 0 && <> · {behind} published, not yet fetched</>}
          </p>

          {/* scheduler.md §3: pencil is what the server has not looked at
              recently. The stamp appears only past the deadline — a fresh
              series is normal ink and says nothing. */}
          {fresh?.stale && fresh.lastLookedAt != null && (
            <Line tone="pencil">Last looked at {lookedPhrase(fresh.lastLookedAt)}.</Line>
          )}

          {/* Derived work, legible where the books are. The book is ink —
              its face is what's pencil. Failure is told apart from waiting
              here, not only in the workbench ledger. */}
          {derived?.kind === "red" && (
            <NeedsYou verb="Look again" onVerb={() => api.scan.start().catch(() => {})}>
              {derived.job.label} stopped
              {derived.job.error ? ` — ${derived.job.error}` : ""}. Nothing already on your
              shelf was touched.
            </NeedsYou>
          )}
          {derived?.kind === "amber" && (
            <Weather>
              {derived.job.label} didn't finish — it will be tried again by itself.
            </Weather>
          )}
          {derived?.kind === "running" && (
            <Line tone="pencil">
              {derived.job.label}
              {derived.job.startedAt ? ` · started ${timeAgo(derived.job.startedAt)}` : ""}.
            </Line>
          )}
          {derived?.kind === "queued" && (
            <Line tone="pencil">Art for this series is waiting its turn.</Line>
          )}

          {binding && <IdentityLine binding={binding} onChanged={load} />}

          {detail.meta.description && (
            <div className="desc">
              <button className="linkish" onClick={() => setDescOpen(!descOpen)}>
                About this series {descOpen ? "▴" : "▾"}
              </button>
              {descOpen && <p className="desc-body">{detail.meta.description}</p>}
            </div>
          )}

          <div className="series-verbs">
            {resume && (
              <button className="btn btn-primary" onClick={() => onRead(resume.chapter.id)}>
                {resume.page != null
                  ? `Resume ${resume.chapter.title} · p. ${resume.page + 1}`
                  : rows.some((r) => r.read)
                    ? `Next · ${resume.chapter.title}`
                    : `Start · ${resume.chapter.title}`}
              </button>
            )}
            {behind > 0 && detail.meta.sourceId && (
              <button className="btn" onClick={getMissing} disabled={getting}>
                {getting ? "Asking the source…" : `Get the ${behind}`}
              </button>
            )}
          </div>
          {getNote && <Line tone="pencil">{getNote}</Line>}

          <InkBar held={detail.chapterCount} inflight={pencil.length} latest={latest} />
        </div>
      </header>

      <div className="chapter-tools">
        <div className="seg" role="tablist" aria-label="Filter">
          <button className={!unreadOnly ? "on" : ""} onClick={() => setUnreadOnly(false)}>
            All · {rows.length}
          </button>
          <button className={unreadOnly ? "on" : ""} onClick={() => setUnreadOnly(true)}>
            Unread · {unreadCount}
          </button>
        </div>
        <div className="seg" role="tablist" aria-label="View">
          <button className={view === "list" ? "on" : ""} onClick={() => setViewKeep("list")}>List</button>
          <button className={view === "shelf" ? "on" : ""} onClick={() => setViewKeep("shelf")}>Shelf</button>
        </div>
      </div>

      {view === "shelf" ? (
        <SpineShelf
          rows={shown}
          pencil={pencil}
          seasons={registry?.seasons ?? []}
          faceComing={faceComing}
          onRead={(cid) => onRead(cid)}
          onToggleRead={(cid) => {
            const r = rows.find((x) => x.chapter.id === cid);
            if (r) toggleRead(r);
          }}
        />
      ) : (
        <ol className="chapter-list">
          {shown.map((r, i) => {
            const prevSeq = i > 0 ? shown[i - 1]!.chapter.sequence : r.chapter.sequence;
            const divider = (registry?.seasons ?? []).find(
              (s) =>
                i > 0 &&
                shown[i - 1]!.chapter.sequence === "main" &&
                r.chapter.sequence === "main" &&
                shown[i - 1]!.chapter.sortKey <= s.endAfterSortKey &&
                r.chapter.sortKey > s.endAfterSortKey,
            );
            return (
              <li key={r.chapter.id}>
                {r.chapter.sequence !== prevSeq && (
                  <div className="seq-label">{r.chapter.sequence}</div>
                )}
                {divider && <div className="season-divider">{divider.name} ends here</div>}
                <div
                  className={`ch-row ${r.read ? "is-read" : ""} ${r.readingNow ? "is-reading" : ""}`}
                >
                  <button
                    className="ch-main"
                    onClick={() => setExpanded(expanded === r.chapter.id ? null : r.chapter.id)}
                  >
                    <Glyph state={r.glyph} fill={r.fill} />
                    <span className="ch-mark">{r.chapter.mark || "·"}</span>
                    <span className="ch-label">{r.chapter.label}</span>
                    <span className="ch-meta">
                      {r.readingNow && <em className="ribbon">reading</em>}
                      {r.page != null && !r.readingNow && <em className="ribbon">p. {r.page + 1}</em>}
                      {r.chapter.pageCount > 0 && `${r.chapter.pageCount} p`}
                    </span>
                  </button>
                  {expanded === r.chapter.id && (
                    <div className="ch-verbs">
                      <button className="btn btn-primary" onClick={() => onRead(r.chapter.id)}>Read</button>
                      <button className="btn" onClick={() => toggleRead(r)}>
                        {r.read ? "Mark unread" : "Mark read"}
                      </button>
                      <button className="btn" onClick={() => toggleFlag(r)}>
                        {r.flagged ? "Unflag" : "Flag it"}
                      </button>
                      {r.chapter.provenance?.sourceName && (
                        <span className="cap">
                          from {r.chapter.provenance.sourceName}
                          {r.chapter.provenance.fetchedAt
                            ? ` · ${timeAgo(r.chapter.provenance.fetchedAt)}`
                            : ""}
                        </span>
                      )}
                      {r.flagged && (
                        <span className="cap">
                          Marked wrong for the household — it stays readable until replaced.
                        </span>
                      )}
                    </div>
                  )}
                  {r.glyph === "needs-you" && r.taskId && (
                    <NeedsYou verb="Retry" onVerb={() => api.downloads.retry(r.taskId!).then(refreshTasks)}>
                      Stopped partway — what landed is kept. {r.error ?? ""}
                    </NeedsYou>
                  )}
                </div>
              </li>
            );
          })}

          {/* Chapters a task carries that are not on disk yet — pencil rows. */}
          {pencil.map((p) => (
            <li key={`p-${p.name}`}>
              <div className="ch-row is-pencil">
                <div className="ch-main">
                  <Glyph state={p.glyph} fill={p.fill} />
                  <span className="ch-mark" />
                  <span className="ch-label">{p.name}</span>
                  <span className="ch-meta">
                    {/* Pages on disk over pages total — accomplished fact,
                        never a ticking percentage (the far-lane rule). */}
                    {p.glyph === "inking" && p.pagesTotal > 0
                      ? `${p.pagesDone} of ${p.pagesTotal} pages`
                      : p.glyph === "queued"
                        ? "queued"
                        : ""}
                  </span>
                </div>
                {p.glyph === "needs-you" && (
                  <NeedsYou verb="Retry" onVerb={() => api.downloads.retry(p.taskId).then(refreshTasks)}>
                    Stopped — nothing already on your shelf was touched. {p.error ?? ""}
                  </NeedsYou>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {behind > 0 && (
        <p className="overhang">
          {behind} further published (to {latest}), not yet on this shelf.
        </p>
      )}
      {binding?.state === "identified" && registry && (
        <p className="cap registry-stamp">
          Counts from {registry.provider} · card as of {registry.asOf}
        </p>
      )}
    </main>
  );
}
