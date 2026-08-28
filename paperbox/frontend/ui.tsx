/**
 * The state language, as components. One vocabulary across every view:
 * pencil is intent, ink is fact, amber is weather, red is a person.
 * There is no green — done is the resting state.
 *
 * On the web client ink means "on the server": this client holds nothing.
 *
 * Every state differs in geometry or weave as well as hue — the marks
 * must survive greyscale. Pencil is dashed or outlined; amber is hatched;
 * ink is solid; red carries a distinct shape (ring-dot or question mark).
 */

import type { ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* The glyph — far lane: where a chapter stands between world & server  */
/* ------------------------------------------------------------------ */

export type GlyphState =
  /** Solid ink disc — on the server. A fact. */
  | "server"
  /** Pencil circle filling bottom-up — pages landing. Fill is literal. */
  | "inking"
  /** Dashed pencil circle — the server intends it, in order. */
  | "queued"
  /** Empty pencil outline — a bound source lists it; gettable. */
  | "at-source"
  /** Amber, hatched — weather. Fill kept; resumes itself. */
  | "waiting"
  /** Red ring with a dot — a person is needed. */
  | "needs-you"
  /** Red question — a human said the content is wrong. */
  | "flagged"
  /** Dotted grey — published, nowhere to get it. A fact about the world. */
  | "published";

export function Glyph({ state, fill = 0, title }: { state: GlyphState; fill?: number; title?: string }) {
  const t = title ?? glyphLabel(state);
  const common = { role: "img" as const, "aria-label": t };
  switch (state) {
    case "server":
      return (
        <svg viewBox="0 0 16 16" className="glyph" {...common}>
          <circle cx="8" cy="8" r="6" className="g-ink" />
        </svg>
      );
    case "inking": {
      const h = 12 * Math.min(1, Math.max(0, fill));
      return (
        <svg viewBox="0 0 16 16" className="glyph" {...common}>
          <defs>
            <clipPath id={`gclip-${Math.round(fill * 100)}`}>
              <rect x="0" y={14 - h} width="16" height={h} />
            </clipPath>
          </defs>
          <circle cx="8" cy="8" r="6" className="g-pencil-line" />
          <circle cx="8" cy="8" r="6" className="g-pencil-fill" clipPath={`url(#gclip-${Math.round(fill * 100)})`} />
        </svg>
      );
    }
    case "queued":
      return (
        <svg viewBox="0 0 16 16" className="glyph" {...common}>
          <circle cx="8" cy="8" r="6" className="g-pencil-dash" />
        </svg>
      );
    case "at-source":
      return (
        <svg viewBox="0 0 16 16" className="glyph" {...common}>
          <circle cx="8" cy="8" r="6" className="g-pencil-line" />
        </svg>
      );
    case "waiting":
      return (
        <svg viewBox="0 0 16 16" className="glyph" {...common}>
          <defs>
            <pattern id="g-hatch" width="3" height="3" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
              <rect width="3" height="3" fill="none" />
              <line x1="0" y1="0" x2="0" y2="3" className="g-amber-hatch" />
            </pattern>
          </defs>
          <circle cx="8" cy="8" r="6" className="g-amber-line" />
          <circle cx="8" cy="8" r="5" fill="url(#g-hatch)" />
        </svg>
      );
    case "needs-you":
      return (
        <svg viewBox="0 0 16 16" className="glyph" {...common}>
          <circle cx="8" cy="8" r="6" className="g-red-line" />
          <circle cx="8" cy="8" r="2.2" className="g-red-fill" />
        </svg>
      );
    case "flagged":
      return (
        <svg viewBox="0 0 16 16" className="glyph" {...common}>
          <circle cx="8" cy="8" r="6" className="g-red-line" />
          <text x="8" y="11.5" textAnchor="middle" className="g-red-text">?</text>
        </svg>
      );
    case "published":
      return (
        <svg viewBox="0 0 16 16" className="glyph" {...common}>
          <circle cx="8" cy="8" r="6" className="g-grey-dot" />
        </svg>
      );
  }
}

export function glyphLabel(state: GlyphState): string {
  switch (state) {
    case "server": return "On the server";
    case "inking": return "Inking — pages landing";
    case "queued": return "Queued";
    case "at-source": return "At the source, not fetched";
    case "waiting": return "Waiting — resumes itself";
    case "needs-you": return "Needs you";
    case "flagged": return "Flagged by a reader";
    case "published": return "Published, no source has it";
  }
}

/* ------------------------------------------------------------------ */
/* The ink bar — held / in flight / honestly-bounded track              */
/* ------------------------------------------------------------------ */

/**
 * Ink for what is held, pencil for what is in flight, and the track ends
 * at the registry's latest known chapter — behind-ness is a visible
 * unfilled tail with no badge and no second number.
 */
export function InkBar({
  held,
  inflight = 0,
  latest,
}: {
  held: number;
  inflight?: number;
  /** Registry latest, when identified. Without one, the track is the held count. */
  latest?: number | null;
}) {
  const total = Math.max(latest ?? held, held + inflight, 1);
  const heldPct = (held / total) * 100;
  const flightPct = (inflight / total) * 100;
  return (
    <div className="inkbar" role="img" aria-label={latest ? `${held} of ${latest} held` : `${held} held`}>
      <div className="inkbar-held" style={{ width: `${heldPct}%` }} />
      {inflight > 0 && <div className="inkbar-flight" style={{ width: `${flightPct}%` }} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Copy lines                                                          */
/* ------------------------------------------------------------------ */

/** One flat line, attached to the thing it explains. */
export function Line({ tone = "quiet", children }: { tone?: "quiet" | "amber" | "red" | "pencil"; children: ReactNode }) {
  return <p className={`line line-${tone}`}>{children}</p>;
}

/** Weather strip — amber, self-healing, asks nothing, no retry lever. */
export function Weather({ children }: { children: ReactNode }) {
  return (
    <div className="weather" role="status">
      <span className="weather-mark" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/** Red — a person is needed. Exactly one verb. */
export function NeedsYou({ children, verb, onVerb }: { children: ReactNode; verb?: string; onVerb?: () => void }) {
  return (
    <div className="needsyou" role="status">
      <span>{children}</span>
      {verb && onVerb && (
        <button className="btn btn-red" onClick={onVerb}>{verb}</button>
      )}
    </div>
  );
}

/** "as of" stamp — honest staleness, a fact not a warning. */
export function AsOf({ t }: { t: number | null }) {
  if (!t) return null;
  const d = new Date(t);
  return (
    <span className="asof">
      as of {d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Evidence rows — the argument, never a score                          */
/* ------------------------------------------------------------------ */

export function Evidence({ rows }: { rows: { fact: string; verdict: "agree" | "contradict" | "unknown" }[] }) {
  return (
    <ul className="evidence">
      {rows.map((r, i) => (
        <li key={i} className={`ev ev-${r.verdict}`}>
          <span className="ev-mark" aria-hidden>
            {r.verdict === "agree" ? "•" : r.verdict === "contradict" ? "✕" : "·"}
          </span>
          {r.fact}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* The plain binding — a cover that has not arrived                     */
/* ------------------------------------------------------------------ */

/**
 * A series without a face renders as a plain bound volume: series-ink
 * cloth, stamped title. Never a broken-image glyph, never a spinner.
 */
export function PlainBinding({ title }: { title: string }) {
  return (
    <div className="plain-binding" aria-hidden>
      <span>{title}</span>
    </div>
  );
}
