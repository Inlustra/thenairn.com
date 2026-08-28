/**
 * The spine shelf — the chapter list as a bookcase. An additive view over
 * the same sequence the list renders: same states, same verbs, nothing
 * exists here that the list lacks.
 *
 * Spine width is the chapter's real page count (12px + 2.2√pages, floored
 * at 21, capped at 44). Faces stand in flat series ink — spine art
 * extraction is a missing server API (docs/api-gaps.md), and only a real
 * book has a face, so nothing is invented. Boards never mix sequences;
 * a gap is drawn only where one sequence's own run attests the hole.
 */

import { useMemo, useState } from "react";
import { spineWidth } from "../lib";
import { spineArtUrl } from "../api/contract";
import { Glyph, glyphLabel } from "../ui";
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
 * Failed URLs are remembered briefly so re-renders don't re-ask the
 * server for art it just said it hasn't cut; the short TTL means art
 * that lands is picked up on the next visit without any wiring.
 */
const faceMisses = new Map<string, number>();
const FACE_MISS_TTL = 60_000;

function SpineFace({ uid }: { uid: string }) {
  const url = spineArtUrl(uid);
  const [loaded, setLoaded] = useState(false);
  const [dead, setDead] = useState(() => {
    const at = faceMisses.get(url);
    return at != null && Date.now() - at < FACE_MISS_TTL;
  });
  if (dead) return null;
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

const BLOCK = 25;

function buildBoards(rows: ChapterRow[], pencil: PencilRow[]): Board[] {
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

    // Wrap into boards of ~BLOCK spines, plated by the marks they carry.
    for (let i = 0; i < cells.length; i += BLOCK) {
      const chunk = cells.slice(i, i + BLOCK);
      const marks = chunk
        .filter((c): c is Extract<Cell, { kind: "spine" }> => c.kind === "spine")
        .map((c) => c.row.chapter.mark)
        .filter((m) => m !== "");
      const plate =
        marks.length > 1 ? `${marks[0]} – ${marks[marks.length - 1]}` : (marks[0] ?? "");
      boards.push({ sequence: seq, plate, cells: chunk });
    }
  }
  return boards;
}

export function SpineShelf({
  rows,
  pencil,
  seasons,
  onRead,
  onToggleRead,
}: {
  rows: ChapterRow[];
  pencil: PencilRow[];
  seasons: { name: string; endAfterSortKey: number }[];
  onRead: (chapterId: string) => void;
  onToggleRead: (chapterId: string) => void;
}) {
  const boards = useMemo(() => buildBoards(rows, pencil), [rows, pencil]);
  const [pulled, setPulled] = useState<string | null>(null);
  const pulledRow = rows.find((r) => r.chapter.id === pulled) ?? null;

  let lastSeq = "";
  return (
    <div className="bookcase">
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
                        title={`Missing from this run · ${cell.from}${n > 1 ? `–${cell.to}` : ""}`}
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
                  const w = spineWidth(r.chapter.pageCount);
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
                          <SpineFace uid={r.chapter.uid} />
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

      <p className="cap shelf-note">
        <Glyph state="server" /> a spine wears its own art once the server has cut it; until
        then it stands in flat series ink. Width is the chapter's real page count.
      </p>
    </div>
  );
}
