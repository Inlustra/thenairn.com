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
} from "../api/contract";
import { InkBar, PlainBinding } from "../ui";

interface SeriesCardData {
  series: SeriesSummary;
  identity: IdentityBinding | null;
  unread: number | null;
  /** Chapters queued or inking for this series right now. */
  queued: number;
  inking: { name: string; done: number; total: number } | null;
  failed: boolean;
}

/** The one caption under the title — the fact that decides the next tap. */
function caption(d: SeriesCardData): { text: string; tone: "quiet" | "pencil" | "amber" | "red" } {
  const { series, identity, queued, inking, failed } = d;
  if (failed) return { text: "A fetch needs you — see the workbench", tone: "red" };
  if (identity?.state === "contradicted")
    return { text: "Identity needs a look", tone: "red" };
  if (identity?.state === "guess")
    return { text: "Best guess ready · confirm", tone: "pencil" };
  if (inking)
    return { text: `Inking ${inking.name} · ${inking.done} of ${inking.total} pages`, tone: "pencil" };
  if (queued > 0) return { text: `Queued · ${queued} chapters`, tone: "pencil" };
  const latest = identity?.registry?.latestChapter ?? null;
  if (latest && latest > series.chapterCount)
    return { text: `${series.chapterCount} of ${latest} published`, tone: "quiet" };
  const status = identity?.registry?.status ?? series.meta.status?.toLowerCase();
  if (status === "hiatus") return { text: "Caught up · on hiatus", tone: "quiet" };
  if (status === "complete" || status === "completed")
    return { text: `Complete · ${series.chapterCount}`, tone: "quiet" };
  if (identity?.state === "unconfigured" || identity?.state === "files-only")
    return { text: `Files only · ${series.chapterCount} ${series.chapterCount === 1 ? "chapter" : "issues"}`, tone: "quiet" };
  return { text: `${series.chapterCount} chapters`, tone: "quiet" };
}

function Cover({ series }: { series: SeriesSummary }) {
  const [failed, setFailed] = useState(false);
  if (!series.coverUrl || failed) return <PlainBinding title={series.title} />;
  return (
    <img
      className="cover-img"
      src={series.coverUrl}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function LibraryView({
  tasks,
  onOpen,
  onRead,
}: {
  tasks: DownloadTask[];
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
        };
      });
  }, [items, identities, unread, tasks, search]);

  // Attention sorts first only where a person is actually needed; the shelf
  // itself is never an error surface.
  const sorted = useMemo(
    () =>
      [...cards].sort((a, b) => {
        const rank = (c: SeriesCardData) =>
          c.failed || c.identity?.state === "contradicted" ? 0
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
          <h2>An empty shelf is a good problem</h2>
          <p className="line line-quiet">
            Paperbox reads your files where they are — it never moves, renames, or rewrites them.
            Scan your folders from the workbench, or find a series at a source and Get it.
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
                      <span className="idmark" aria-label="Identity needs a look">?</span>
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
