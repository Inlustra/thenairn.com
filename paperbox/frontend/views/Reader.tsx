/**
 * The reader. One job, pinned to night — pages are read in bed, whatever
 * the app theme. Nothing may draw over a page: arrivals, failures and
 * every other message wait at the end card. A broken page is an in-flow
 * retry tile, never an ejection.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, recordContinue } from "../api";
import type { SeriesDetail, ChapterInfo, PageInfo } from "../api/contract";
import { Line } from "../ui";

function sortChapters(chapters: ChapterInfo[]): ChapterInfo[] {
  return [...chapters].sort((a, b) => {
    if (a.sequence !== b.sequence)
      return a.sequence === "main" ? -1 : b.sequence === "main" ? 1 : a.sequence.localeCompare(b.sequence);
    return a.sortKey - b.sortKey || a.label.localeCompare(b.label);
  });
}

function PageImage({ src, index }: { src: string; index: number }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (failed)
    return (
      <button
        className="page-retry"
        onClick={() => {
          setFailed(false);
          setAttempt((a) => a + 1);
        }}
      >
        This page didn't arrive. Tap to try again — the rest of the chapter is fine.
      </button>
    );
  return (
    <img
      src={attempt > 0 ? `${src}?r=${attempt}` : src}
      alt={`Page ${index + 1}`}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function ReaderView({
  seriesId,
  chapterId,
  onClose,
  onNavigate,
  seam,
}: {
  seriesId: string;
  chapterId: string;
  onClose: () => void;
  onNavigate: (chapterId: string) => void;
  /**
   * The seam mark, handed down only when something is stuck or wrong —
   * amber or red. It rides the chrome the reader already hides, so a
   * page in progress never gains a single new pixel; a reader who taps
   * for the chrome was already asking "where am I, what's going on".
   */
  seam?: ReactNode;
}) {
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [pages, setPages] = useState<PageInfo[] | null>(null);
  const [err, setErr] = useState("");
  const [near, setNear] = useState<Set<number>>(() => new Set([0, 1, 2]));
  const [cur, setCur] = useState(0);
  const [chrome, setChrome] = useState(true);
  /** Page to land on silently — where the reader left off. */
  const [pin, setPin] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rafRef = useRef(0);
  const userMovedRef = useRef(false);

  const chapters = useMemo(() => (detail ? sortChapters(detail.chapters) : []), [detail]);
  const idx = chapters.findIndex((c) => c.id === chapterId);
  const chapter = idx >= 0 ? chapters[idx] : undefined;
  const prev = idx > 0 ? chapters[idx - 1] : undefined;
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : undefined;

  useEffect(() => {
    api.library.get(seriesId).then(setDetail).catch(() => setErr("Could not open the series."));
  }, [seriesId]);

  useEffect(() => {
    setPages(null);
    setErr("");
    setNear(new Set([0, 1, 2]));
    setCur(0);
    setPin(null);
    userMovedRef.current = false;
    pageRefs.current = [];
    scrollRef.current?.scrollTo?.(0, 0);
    Promise.all([api.library.pages(seriesId, chapterId), api.readState.series(seriesId)])
      .then(([pp, rs]) => {
        setPages(pp);
        const saved = rs.chapters[chapterId];
        if (saved && !saved.read && saved.page > 0 && pp.length > 1) {
          const target = Math.min(saved.page, pp.length - 1);
          setNear(new Set([0, 1, 2, target, target + 1, target + 2]));
          setCur(target);
          setPin(target);
        }
      })
      .catch(() => setErr("Could not load this chapter's pages."));
  }, [seriesId, chapterId]);

  // Lazy mounting: a chapter can be 128 pages and hundreds of MB.
  useEffect(() => {
    if (!pages || pages.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        setNear((prevSet) => {
          let grew = false;
          const nextSet = new Set(prevSet);
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const i = Number((e.target as HTMLElement).dataset.i);
            if (!nextSet.has(i)) {
              nextSet.add(i);
              grew = true;
            }
          }
          return grew ? nextSet : prevSet;
        });
      },
      { root: scrollRef.current, rootMargin: "200% 0px 300% 0px" },
    );
    for (const el of pageRefs.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, [pages]);

  const onScroll = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      const mark = el.scrollTop + el.clientHeight * 0.35;
      let c = 0;
      pageRefs.current.forEach((p, i) => {
        if (p && p.offsetTop <= mark) c = i;
      });
      setCur(c);
    });
  };

  // Keep the position. Debounced; furthest-wins at the adapter, and at the
  // server once /api/readstate lands.
  useEffect(() => {
    if (!pages || pages.length === 0 || !detail || !chapter) return;
    const t = setTimeout(() => {
      api.readState.setPosition(seriesId, chapterId, cur, pages.length).catch(() => {});
      recordContinue({
        seriesId,
        seriesTitle: detail.title,
        chapterId,
        chapterLabel: chapter.label,
        page: cur,
        pageCount: pages.length,
        updatedAt: Date.now(),
      });
    }, 600);
    return () => clearTimeout(t);
  }, [cur, pages, detail, chapter, seriesId, chapterId]);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "[" && prev) onNavigate(prev.id);
      else if (e.key === "]" && next) onNavigate(next.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onClose, onNavigate]);

  // Land where the reader left off — silently. Pages above the target are
  // unmounted fixed-height placeholders, so its offsetTop is exact before
  // any image loads; the scroll is a single instant jump, never animated.
  // A few follow-up corrections absorb late layout settling (fonts, the
  // target page's own image), and the first real input from the reader
  // ends the pin so it can never fight them.
  useEffect(() => {
    if (pin == null || !pages || pages.length === 0) return;
    const land = () => {
      if (userMovedRef.current) return;
      const el = pageRefs.current[pin];
      const sc = scrollRef.current;
      if (!el || !sc) return;
      if (Math.abs(sc.scrollTop - el.offsetTop) > 1) sc.scrollTo?.({ top: el.offsetTop });
    };
    const raf = requestAnimationFrame(land);
    const timers = [250, 600, 1200].map((ms) => setTimeout(land, ms));
    const moved = () => {
      userMovedRef.current = true;
    };
    const sc = scrollRef.current;
    const opts = { passive: true } as const;
    sc?.addEventListener("wheel", moved, opts);
    sc?.addEventListener("touchstart", moved, opts);
    sc?.addEventListener("pointerdown", moved, opts);
    window.addEventListener("keydown", moved);
    return () => {
      cancelAnimationFrame(raf);
      for (const t of timers) clearTimeout(t);
      sc?.removeEventListener("wheel", moved);
      sc?.removeEventListener("touchstart", moved);
      sc?.removeEventListener("pointerdown", moved);
      window.removeEventListener("keydown", moved);
    };
  }, [pin, pages]);

  const flagIt = async () => {
    await api.flags.flag(seriesId, chapterId);
  };

  return (
    <div className="reader" role="dialog" aria-label={chapter?.label ?? "Reader"}>
      <div
        className={`rd-chrome rd-top ${chrome ? "" : "rd-hidden"}`}
      >
        <button className="btn" onClick={onClose}>✕</button>
        <div className="rd-title">
          <strong>{detail?.title}</strong>
          <span>{chapter?.label}</span>
        </div>
        <span className="rd-pos">
          {pages ? `${cur + 1} / ${pages.length}` : ""}
        </span>
        {seam}
      </div>

      <div className="rd-scroll" ref={scrollRef} onScroll={onScroll} onClick={() => setChrome((c) => !c)}>
        {err && <Line tone="quiet">{err}</Line>}
        {pages?.map((p, i) => (
          <div
            key={p.index}
            className="rd-page"
            data-i={i}
            ref={(el) => {
              pageRefs.current[i] = el;
            }}
          >
            {near.has(i) ? <PageImage src={p.url} index={i} /> : <div className="rd-hold" />}
          </div>
        ))}

        {pages && pages.length > 0 && (
          <div className="end-card" onClick={(e) => e.stopPropagation()}>
            <p className="end-line">
              {next ? "End of the chapter." : "That's the newest chapter on the server."}
            </p>
            {next ? (
              <button
                className="btn btn-primary"
                onClick={() => onNavigate(next.id)}
              >
                Next · {next.label}
              </button>
            ) : (
              <p className="cap">New chapters land here when the source posts them.</p>
            )}
            <div className="end-verbs">
              {prev && (
                <button className="btn" onClick={() => onNavigate(prev.id)}>
                  ‹ {prev.label}
                </button>
              )}
              <button className="btn" onClick={onClose}>Back to series</button>
            </div>
            <p className="cap">
              Something off about this chapter?{" "}
              <button className="linkish" onClick={flagIt}>Flag it</button>
              {" "}— it stays readable while a replacement is found.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
