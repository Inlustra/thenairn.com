/**
 * What a chapter's "number" actually is.
 *
 * Settled 2026-08-28 (see docs/decisions.md). A chapter has three stored fields
 * rather than one derived number:
 *
 *   label      the verbatim directory name. Never lossy.
 *   sortKey    derived once, stored, used for ordering and block keying.
 *   sequence   "main" by default; a series can contain several runs.
 *
 * Two pieces of measured evidence forced this shape:
 *
 *   - Upstream chapter identifiers are strings, not numbers: `7c`, `14-19` (one
 *     release covering six chapters), `10a-c`, `50.5`, `Oneshot`, null. A float
 *     silently discards most of that vocabulary.
 *   - A chapter number is not unique within a series. `Episode 001` and
 *     `Spin-off #001` both exist on disk and both are legitimately "1".
 *
 * The derivation lives here, but callers must treat its output as something to
 * *store once*, not to recompute on read. Re-deriving on every read means that
 * improving this file silently re-keys every block hash and invalidates every
 * client's held state, with no migration and no signal.
 */

/** Runs that are not the main sequence, matched at the start of a stripped name. */
const SEQUENCE_WORDS: Array<[RegExp, string]> = [
  [/^spin[\s_-]?offs?\b/i, "spin-off"],
  [/^side[\s_-]?stor(?:y|ies)\b/i, "side-story"],
  [/^extras?\b/i, "extra"],
  [/^omakes?\b/i, "omake"],
  [/^specials?\b/i, "special"],
  [/^bonus\b/i, "bonus"],
  [/^prologue\b/i, "main"], // a prologue is part of the main run, not a sequence
];

export interface ChapterKey {
  /** The directory name, verbatim. */
  label: string;
  /** Ordering and block key. 0 means "no number could be derived". */
  sortKey: number;
  /**
   * End of an inclusive range, when one directory covers several chapters
   * (`14-19`). Absent for ordinary chapters. Gap arithmetic must span this, or
   * an omnibus opens a false hole at 15-18.
   */
  sortKeyEnd?: number;
  /** Which run this belongs to. "main" unless the name says otherwise. */
  sequence: string;
  /**
   * The compact face shown on a spine's foot band - `216`, `101.1`, `14-19`.
   * Empty when nothing numeric could be derived: an unnumbered chapter gets no
   * invented mark, and the label carries it instead.
   */
  mark: string;
}

/** Strip a leading series title, so `Warhammer 40,000_ Exterminatus Issue #1` parses as 1. */
function stripSeriesTitle(seriesTitle: string, name: string): string {
  if (!seriesTitle) return name;
  const lowered = name.toLowerCase();
  const title = seriesTitle.toLowerCase();
  if (lowered.startsWith(title)) {
    const rest = name.slice(seriesTitle.length);
    // Only accept the strip if something survives it; a chapter directory named
    // exactly after its series keeps its full name rather than becoming empty.
    if (rest.trim()) return rest.trim();
  }
  return name;
}

/**
 * Derive the stored key for one chapter directory.
 *
 * `seriesTitle` is the series directory name. Stripping it first is what takes
 * the real library from 14 colliding chapters to 4 - without it, every
 * `Warhammer 40,000_ Exterminatus Issue #N` parses to 40.
 */
export function deriveChapterKey(seriesTitle: string, dir: string): ChapterKey {
  const label = dir;
  let rest = stripSeriesTitle(seriesTitle, dir);

  let sequence = "main";
  for (const [pattern, name] of SEQUENCE_WORDS) {
    if (pattern.test(rest)) {
      sequence = name;
      rest = rest.replace(pattern, "").trim();
      break;
    }
  }

  // A range: one directory holding several chapters. Checked before the plain
  // number, or `14-19` would read as 14 and open a false gap at 15-19.
  const range = rest.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
  if (range?.[1] && range[2]) {
    const from = parseFloat(range[1]);
    const to = parseFloat(range[2]);
    if (to > from) {
      return { label, sortKey: from, sortKeyEnd: to, sequence, mark: `${fmt(from)}–${fmt(to)}` };
    }
  }

  const single = rest.match(/(\d+(?:\.\d+)?)/);
  if (single?.[1]) {
    const n = parseFloat(single[1]);
    return { label, sortKey: n, sequence, mark: fmt(n) };
  }

  // Nothing numeric. `Warhammer 40,000 Full` and `Oneshot` land here, and get no
  // invented mark - the shelf shows the label instead of a fabricated number.
  return { label, sortKey: 0, sequence, mark: "" };
}

/** A derived number's display face. Kept separate so the mark can change without the key. */
function fmt(n: number): string {
  return String(n);
}

/** The last chapter a directory covers - its range end, or its own key. */
export function keyEnd(k: Pick<ChapterKey, "sortKey" | "sortKeyEnd">): number {
  return k.sortKeyEnd ?? k.sortKey;
}

/** How many chapters a directory accounts for: a range counts as its span. */
export function keySpan(k: Pick<ChapterKey, "sortKey" | "sortKeyEnd">): number {
  if (k.sortKeyEnd === undefined) return 1;
  return Math.max(1, Math.round(k.sortKeyEnd - k.sortKey) + 1);
}
