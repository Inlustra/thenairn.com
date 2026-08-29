/**
 * The spine shelf — the chapter list as a bookcase. An additive view over
 * the same sequence the list renders: same states, same verbs, nothing
 * exists here that the list lacks.
 *
 * Spine width measures reading length — pixel height when the server has
 * measured it, page count as the fallback (see lib.spineWidth). Faces
 * stand in flat series ink — spine art extraction is a missing server API
 * (docs/api-gaps.md), and only a real book has a face, so nothing is
 * invented. Boards never mix sequences; a gap is drawn only where one
 * sequence's own run attests the hole.
 *
 * A board wraps when the shelf is full, not after a count: the bookcase
 * is measured and each board takes as many books as its width holds, so
 * every shelf ends flush. (An earlier cut chunked at 25 — the sync
 * tree's block size, an implementation unit with no business deciding
 * what a shelf looks like — and shelves ended wherever the count fell.)
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { spineWidth } from "../lib";
import { spineArtUrl } from "../api/contract";
import { glyphLabel } from "../ui";
import type { ChapterRow, PencilRow } from "./Series";

/* ------------------------------------------------------------------ */
/* The face — a chapter's own art sliver, when the server has cut it   */
/* ------------------------------------------------------------------ */

/**
 * GET /api/art/spine/:chapterUid — 404 until extraction has run. Until
 * the image actually arrives the spine stands in flat series ink; a 404
 * renders nothing at all. No placeholder, no shimmer — pencil states
 * carry no artwork, and theatre is worse than absence.
 *
 * When the server is actually working on this series' art (`coming`),
 * an uncut face carries a pencil-dashed head line: the same mark ui.md
 * already uses for art absence ("art below, pencil-dashed absence
 * above"), applied to the face. Note the collision this deliberately
 * avoids: a *pencil spine* on this shelf means the chapter is not yours
 * yet (possession), and these books are held facts — so the book stays
 * ink and only its face is pencil. With no work outstanding, flat ink
 * stays unmarked: "nothing announces this" is the design's own resting
 * state, and a library at rest must not look busy.
 *
 * Failed URLs are remembered briefly so re-renders don't re-ask the
 * server for art it just said it hasn't cut; the short TTL means art
 * that lands is picked up on the next visit without any wiring.
 */
const faceMisses = new Map<string, number>();
const FACE_MISS_TTL = 60_000;

function SpineFace({ uid, coming }: { uid: string; coming: boolean }) {
  const url = spineArtUrl(uid);
  const [loaded, setLoaded] = useState(false);
  const [dead, setDead] = useState(() => {
    const at = faceMisses.get(url);
    return at != null && Date.now() - at < FACE_MISS_TTL;
  });
  if (dead) {
    return coming ? <span className="sp-await" aria-hidden /> : null;
  }
  return (
    <img
      className={`sp-face${loaded ? " is-loaded" : ""}`}
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      aria-hidden
      onLoad={() => {
        faceMisses.delete(url);
        setLoaded(true);
      }}
      onError={() => {
        faceMisses.set(url, Date.now());
        setDead(true);
      }}
    />
  );
}

interface Board {
  sequence: string;
  plate: string;
  cells: Cell[];
}

type Cell =
  | { kind: "spine"; row: ChapterRow }
  | { kind: "gap"; from: number; to: number }
  | { kind: "pencil"; p: PencilRow };

/* Layout constants mirrored from styles.css — cell gap and row padding
   (.shelf-row), the fixed widths of gap slots, pencil spines and season
   posts. Board building is plain arithmetic over these, so the wrap
   point is known before render and shelves end flush. */
const GAP = 3;
const ROW_PAD = 12;
const GAP_SLOT_W = 21;
const PENCIL_W = 24;
const SEASON_POST_W = 5 + GAP;

function buildBoards(
  rows: ChapterRow[],
  pencil: PencilRow[],
  seasons: { name: string; endAfterSortKey: number }[],
  rowWidth: number,
): Board[] {
  const bySeq = new Map<string, ChapterRow[]>();
  for (const r of rows) {
    const list = bySeq.get(r.chapter.sequence) ?? [];
    list.push(r);
    bySeq.set(r.chapter.sequence, list);
  }
  const seqs = [...bySeq.keys()].sort((a, b) =>
    a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b),
  );

  const boards: Board[] = [];
  for (const seq of seqs) {
    const list = bySeq.get(seq)!;
    // Interleave gap slots where the run's own numbers attest a hole.
    const cells: Cell[] = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      if (i > 0) {
        const prev = list[i - 1]!;
        const prevEnd = prev.chapter.sortKeyEnd ?? prev.chapter.sortKey;
        const isInt = (n: number) => Number.isInteger(n);
        if (
          prev.chapter.mark !== "" &&
          r.chapter.mark !== "" &&
          isInt(prevEnd) &&
          isInt(r.chapter.sortKey) &&
          r.chapter.sortKey - prevEnd > 1
        ) {
          cells.push({ kind: "gap", from: prevEnd + 1, to: r.chapter.sortKey - 1 });
        }
      }
      cells.push({ kind: "spine", row: r });
    }
    if (seq === "main") for (const p of pencil) cells.push({ kind: "pencil", p });

    // Fill each board to the measured width, then wrap. The plate then
    // describes whatever actually landed on the shelf.
    // One pixel held back. `.bookcase` is measured but `.shelf-row` is what
    // wraps, and a fractional width anywhere between them rounds the wrong way
    // often enough to cost a book. Cheaper than being right about every device.
    const usable = Math.max(GAP_SLOT_W, rowWidth - ROW_PAD - 1);
    const cellWidth = (cell: Cell): number => {
      if (cell.kind === "gap") return GAP_SLOT_W;
      if (cell.kind === "pencil") return PENCIL_W;
      const ch = cell.row.chapter;
      const post = seasons.some(
        (sn) => ch.sequence === "main" && (ch.sortKeyEnd ?? ch.sortKey) === sn.endAfterSortKey,
      );
      return spineWidth(ch.pageCount, ch.pixelHeight) + (post ? SEASON_POST_W : 0);
    };
    const flush = (chunk: Cell[]) => {
      const marks = chunk
        .filter((c): c is Extract<Cell, { kind: "spine" }> => c.kind === "spine")
        .map((c) => c.row.chapter.mark)
        .filter((m) => m !== "");
      const plate =
        marks.length > 1 ? `${marks[0]} – ${marks[marks.length - 1]}` : (marks[0] ?? "");
      boards.push({ sequence: seq, plate, cells: chunk });
    };
    let chunk: Cell[] = [];
    let used = 0;
    for (const cell of cells) {
      const w = cellWidth(cell);
      if (chunk.length > 0 && used + GAP + w > usable) {
        flush(chunk);
        chunk = [];
        used = 0;
      }
      chunk.push(cell);
      used += (chunk.length > 1 ? GAP : 0) + w;
    }
    if (chunk.length > 0) flush(chunk);
  }
  return boards;
}

export function SpineShelf({
  rows,
  pencil,
  seasons,
  faceComing = false,
  onRead,
  onToggleRead,
}: {
  rows: ChapterRow[];
  pencil: PencilRow[];
  seasons: { name: string; endAfterSortKey: number }[];
  /** Art/cover work is standing against this series right now. */
  faceComing?: boolean;
  onRead: (chapterId: string) => void;
  onToggleRead: (chapterId: string) => void;
}) {
  // The bookcase is measured, not assumed: boards are rebuilt when its
  // width changes, so a resize re-fills every shelf.
  const caseRef = useRef<HTMLDivElement | null>(null);
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = caseRef.current;
    if (!el) return;
    const measure = () => setRowWidth(Math.floor(el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const boards = useMemo(
    () => (rowWidth == null ? [] : buildBoards(rows, pencil, seasons, rowWidth)),
    [rows, pencil, seasons, rowWidth],
  );
  const [pulled, setPulled] = useState<string | null>(null);
  const pulledRow = rows.find((r) => r.chapter.id === pulled) ?? null;

  let lastSeq = "";
  return (
    <div className="bookcase" ref={caseRef}>
      {boards.map((b, bi) => {
        const stack = b.sequence !== lastSeq && b.sequence !== "main";
        lastSeq = b.sequence;
        return (
          <div key={bi} className="board-wrap">
            {stack && <div className="stack-label">{b.sequence}</div>}
            <div className="board" role="group" aria-label={`Chapters ${b.plate}`}>
              {b.plate && <span className="plate">{b.plate}</span>}
              <div className="shelf-row">
                {b.cells.map((cell, ci) => {
                  if (cell.kind === "gap") {
                    const n = cell.to - cell.from + 1;
                    return (
                      <span
                        key={`g${ci}`}
                        className="gap-slot"
                        title={`Missing · ${cell.from}${n > 1 ? `–${cell.to}` : ""}`}
                        aria-label={`Missing chapters ${cell.from} to ${cell.to}`}
                      />
                    );
                  }
                  if (cell.kind === "pencil") {
                    const p = cell.p;
                    return (
                      <span
                        key={`p${ci}`}
                        className={`spine sp-${p.glyph}`}
                        style={{ width: 24 }}
                        title={`${p.name} · ${glyphLabel(p.glyph)}`}
                      >
                        {p.glyph === "inking" && (
                          <span className="sp-fill" style={{ height: `${p.fill * 100}%` }} />
                        )}
                      </span>
                    );
                  }
                  const r = cell.row;
                  const w = spineWidth(r.chapter.pageCount, r.chapter.pixelHeight);
                  const seasonAfter = seasons.find(
                    (s) =>
                      r.chapter.sequence === "main" &&
                      (r.chapter.sortKeyEnd ?? r.chapter.sortKey) === s.endAfterSortKey,
                  );
                  return (
                    <span key={r.chapter.id} className="spine-slot">
                      <button
                        className={[
                          "spine",
                          `sp-${r.glyph}`,
                          r.read ? "sp-read" : "",
                          r.readingNow ? "sp-reading" : "",
                          pulled === r.chapter.id ? "sp-pulled" : "",
                        ].join(" ")}
                        style={{ width: w }}
                        title={`${r.chapter.label} · ${r.chapter.pageCount} pages`}
                        aria-label={`${r.chapter.label}, ${r.chapter.pageCount} pages, ${
                          r.read ? "read" : glyphLabel(r.glyph)
                        }`}
                        onClick={() =>
                          setPulled(pulled === r.chapter.id ? null : r.chapter.id)
                        }
                      >
                        {(r.glyph === "server" || r.glyph === "flagged") && (
                          <SpineFace
                            uid={r.chapter.uid}
                            coming={faceComing && r.glyph === "server"}
                          />
                        )}
                        {(r.readingNow || r.glyph === "needs-you" || r.glyph === "flagged") && (
                          <span
                            className={`sp-ribbon ${
                              r.glyph === "needs-you" || r.glyph === "flagged"
                                ? "rb-red"
                                : "rb-pencil"
                            }`}
                            aria-hidden
                          />
                        )}
                        {r.glyph === "inking" && (
                          <span className="sp-fill" style={{ height: `${r.fill * 100}%` }} />
                        )}
                        {r.chapter.mark && (
                          <span
                            className={`sp-band ${r.chapter.mark.length > 3 ? "band-rot" : ""}`}
                            aria-hidden
                          >
                            {r.chapter.mark}
                          </span>
                        )}
                      </button>
                      {seasonAfter && (
                        <span className="season-post" title={`${seasonAfter.name} ends here`} aria-hidden />
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}

      {/* The verb card — the pull's landing place. The label, verbatim. */}
      {pulledRow && (
        <div className="verb-card" role="region" aria-live="polite" aria-label="Selected chapter">
          <div className="vc-facts">
            <strong>{pulledRow.chapter.label}</strong>
            <span className="cap">
              {pulledRow.chapter.pageCount} pages · {pulledRow.read ? "read" : glyphLabel(pulledRow.glyph)}
              {pulledRow.chapter.provenance?.sourceName
                ? ` · from ${pulledRow.chapter.provenance.sourceName}`
                : ""}
            </span>
          </div>
          <div className="vc-verbs">
            <button className="btn btn-primary" onClick={() => onRead(pulledRow.chapter.id)}>
              Read
            </button>
            <button className="btn" onClick={() => onToggleRead(pulledRow.chapter.id)}>
              {pulledRow.read ? "Mark unread" : "Mark read"}
            </button>
            <button className="btn" onClick={() => setPulled(null)}>Close</button>
          </div>
        </div>
      )}

    </div>
  );
}
