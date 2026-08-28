/**
 * The library — the front door. A shelf of series, each cover carrying
 * exactly: the artwork, the unread count, and the ink bar with its
 * honestly-bounded track. Everything else is one caption stating the
 * fact that decides the next tap.
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type {
  SeriesSummary,
  IdentityBinding,
  DownloadTask,
  ContinuePoint,
  JobsEnvelope,
} from "../api/contract";
import { coverArtUrl } from "../api/contract";
import { derivedWorkFor, type DerivedWork } from "../lib";
import { InkBar, PlainBinding } from "../ui";

interface SeriesCardData {
  series: SeriesSummary;
  identity: IdentityBinding | null;
  unread: number | null;
  /** Chapters queued or inking for this series right now. */
  queued: number;
  inking: { name: string; done: number; total: number } | null;
  failed: boolean;
  /** Art/cover work standing against this series (scoped jobs only —
      library-wide passes stay in the workbench, or every card at once
      would caption itself and the shelf would look busy). */
  derived: DerivedWork;
}

/**
 * The one caption under the title — the fact that decides the next tap.
 * Housekeeping (artwork, covers) never captions a card unless a person
 * is needed: the work shows up as the art itself arriving, not as a
 * sentence about it.
 */
function caption(d: SeriesCardData): { text: string; tone: "quiet" | "pencil" | "amber" | "red" } {
  const { series, identity, queued, inking, failed, derived } = d;
  if (failed) return { text: "Stopped — needs you in the workbench", tone: "red" };
  if (identity?.state === "contradicted")
    return { text: "Match looks wrong — take a look", tone: "red" };
  if (derived?.kind === "red")
    return { text: "Artwork stopped — see the workbench", tone: "red" };
  if (identity?.state === "guess")
    return { text: "Best guess ready · confirm", tone: "pencil" };
  if (inking)
    return { text: `Getting ${inking.name} · ${inking.done} of ${inking.total} pages`, tone: "pencil" };
  if (queued > 0)
    return { text: `${queued} ${queued === 1 ? "chapter" : "chapters"} on the way`, tone: "pencil" };
  const latest = identity?.registry?.latestChapter ?? null;
  if (latest && latest > series.chapterCount)
    return { text: `${series.chapterCount} of ${latest} published`, tone: "quiet" };
  const status = identity?.registry?.status ?? series.meta.status?.toLowerCase();
  if (status === "hiatus") return { text: "Caught up · on hiatus", tone: "quiet" };
  if (status === "complete" || status === "completed")
    return { text: `Complete · ${series.chapterCount}`, tone: "quiet" };
  if (identity?.state === "unconfigured" || identity?.state === "files-only")
    return { text: `Files only · ${series.chapterCount} ${series.chapterCount === 1 ? "chapter" : "chapters"}`, tone: "quiet" };
  return { text: `${series.chapterCount} chapters`, tone: "quiet" };
}

/**
 * A cover walks its candidates in order: the source-fetched cover, then
 * the server-generated one (GET /api/art/cover/:seriesUid — 404 until
 * generated). When neither answers, the plain binding — flat series ink,
 * never a placeholder or shimmer.
 */
function Cover({ series }: { series: SeriesSummary }) {
  const urls = [series.coverUrl, coverArtUrl(series.uid)].filter(
    (u): u is string => !!u,
  );
  const [at, setAt] = useState(0);
  if (at >= urls.length) return <PlainBinding title={series.title} />;
  return (
    <img
      className="cover-img"
      src={urls[at]}
      alt=""
      loading="lazy"
      onError={() => setAt(at + 1)}
    />
  );
}

export function LibraryView({
  tasks,
  jobsEnv,
  onOpen,
  onRead,
}: {
  tasks: DownloadTask[];
  jobsEnv: JobsEnvelope | null;
  onOpen: (id: string) => void;
  onRead: (seriesId: string, chapterId: string) => void;
}) {
  const [items, setItems] = useState<SeriesSummary[] | null>(null);
  const [identities, setIdentities] = useState<Record<string, IdentityBinding>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [rail, setRail] = useState<ContinuePoint[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api.library.list({ limit: 100 }).then((d) => setItems(d.data)).catch(() => {});
    api.identity.all().then(setIdentities).catch(() => {});
    api.readState.unreadCounts().then(setUnread).catch(() => {});
    api.readState.continueRail(4).then(setRail).catch(() => {});
  }, []);

  const cards: SeriesCardData[] = useMemo(() => {
    if (!items) return [];
    const q = search.trim().toLowerCase();
    return items
      .filter((m) => !q || m.title.toLowerCase().includes(q))
      .map((series) => {
        const mine = tasks.filter(
          (t) => t.mangaTitle.trim().toLowerCase() === series.title.trim().toLowerCase(),
        );
        const dl = mine
          .flatMap((t) => t.chapters)
          .find((c) => c.status === "downloading");
        return {
          series,
          identity: identities[series.id] ?? null,
          unread: series.id in unread ? unread[series.id]! : null,
          queued: mine.flatMap((t) => t.chapters).filter((c) => c.status === "queued").length,
          inking: dl ? { name: dl.name, done: dl.pagesDownloaded, total: dl.pagesTotal } : null,
          failed: mine.some((t) => t.status === "failed"),
          derived: derivedWorkFor(jobsEnv, series.uid, false),
        };
      });
  }, [items, identities, unread, tasks, search, jobsEnv]);

  // Attention sorts first only where a person is actually needed; the shelf
  // itself is never an error surface.
  const sorted = useMemo(
    () =>
      [...cards].sort((a, b) => {
        const rank = (c: SeriesCardData) =>
          c.failed || c.identity?.state === "contradicted" || c.derived?.kind === "red" ? 0
          : c.identity?.state === "guess" ? 1
          : c.inking || c.queued ? 2
          : 3;
        return rank(a) - rank(b) || a.series.title.localeCompare(b.series.title);
      }),
    [cards],
  );

  return (
    <main className="library">
      <div className="lib-tools">
        <input
          className="search"
          type="search"
          placeholder="Search your shelf"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search your shelf"
        />
      </div>

      {rail.length > 0 && (
        <section className="continue-rail" aria-label="Continue">
          <h2 className="rail-h">Continue</h2>
          <div className="rail-row">
            {rail.map((p) => (
              <button
                key={p.seriesId}
                className="rail-card"
                onClick={() => onRead(p.seriesId, p.chapterId)}
              >
                <span className="rail-series">{p.seriesTitle}</span>
                <span className="rail-where">
                  {p.chapterLabel} · p. {p.page + 1}/{p.pageCount}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {items === null ? null : sorted.length === 0 ? (
        <div className="empty">
          <h2>Nothing on the shelf yet</h2>
          <p className="line line-quiet">
            Paperbox reads your files where they are — it never moves, renames, or rewrites them.
            Get a series from the workbench to begin.
          </p>
        </div>
      ) : (
        <ul className="shelf-grid">
          {sorted.map((d) => {
            const c = caption(d);
            const latest = d.identity?.registry?.latestChapter ?? null;
            return (
              <li key={d.series.id}>
                <button className="series-card" onClick={() => onOpen(d.series.id)}>
                  <div className="cover">
                    <Cover series={d.series} />
                    {d.unread != null && d.unread > 0 && (
                      <span className="unread" aria-label={`${d.unread} unread`}>{d.unread}</span>
                    )}
                    {d.identity?.state === "contradicted" && (
                      <span className="idmark" aria-label="Match looks wrong">?</span>
                    )}
                  </div>
                  <InkBar
                    held={d.series.chapterCount}
                    inflight={d.queued + (d.inking ? 1 : 0)}
                    latest={latest}
                  />
                  <span className="card-title">{d.series.title}</span>
                  <span className={`card-cap cap-${c.tone}`}>{c.text}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
