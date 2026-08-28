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
// Each must be followed by a number or the end of the name. Without that,
// ordinary titles get misfiled into a separate block and ordering namespace
// permanently: "Special Delivery" became sequence "special", "Bonus Round 4"
// became "bonus".
const SEQ_TAIL = String.raw`(?=\s*[#.]?\s*\d|\s*$)`;
const SEQUENCE_WORDS: Array<[RegExp, string]> = [
  [new RegExp(String.raw`^spin[\s_-]?offs?\b` + SEQ_TAIL, "i"), "spin-off"],
  [new RegExp(String.raw`^side[\s_-]?stor(?:y|ies)\b` + SEQ_TAIL, "i"), "side-story"],
  [new RegExp(String.raw`^extras?\b` + SEQ_TAIL, "i"), "extra"],
  [new RegExp(String.raw`^omakes?\b` + SEQ_TAIL, "i"), "omake"],
  [new RegExp(String.raw`^specials?\b` + SEQ_TAIL, "i"), "special"],
  [new RegExp(String.raw`^bonus\b` + SEQ_TAIL, "i"), "bonus"],
  [/^prologue\b/i, "main"], // a prologue is part of the main run, not a sequence
];

/**
 * An explicit chapter token, tried before "first digit run".
 *
 * Volume- and season-prefixed names are common in adopted Kavita/Komga/Tachiyomi
 * libraries, and first-digit-run keys every one of them to the volume:
 * `Vol. 2 Ch. 5` -> 2, `Season 2 Chapter 1` -> 2, `v02 c010` -> 2. Because keys
 * are stored on first sight, fixing the parser afterwards cannot repair them.
 */
const CHAPTER_TOKEN = /(?:^|[^a-z0-9])(?:chapter|chap|ch|episode|ep|c)\s*[.#]?\s*(\d+(?:\.\d+)?)/i;

/** Real chapter numbers are small; anything larger is a year, an id, or junk. */
const MAX_SANE = 100_000;

function sane(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= MAX_SANE;
}

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

  // Find the chapter number's position: an explicit chapter token if there is
  // one, else the first digit run.
  const token = rest.match(CHAPTER_TOKEN);
  const plain = rest.match(/\d+(?:\.\d+)?/);
  const hit = token?.[1] !== undefined ? { text: token[1], end: token.index! + token[0].length } : plain?.[0] !== undefined ? { text: plain[0], end: plain.index! + plain[0].length } : null;

  if (hit && sane(parseFloat(hit.text))) {
    const from = parseFloat(hit.text);

    // A range is only a range when the second number follows THIS one directly.
    // An unanchored search matched any hyphenated digit pair later in the name,
    // so `Chapter 1 (2020-2021)` keyed to 2020 and `Chapter 1 - Part 2-3` to 2.
    const after = rest.slice(hit.end).match(/^\s*[-–]\s*(\d+(?:\.\d+)?)/);
    if (after?.[1]) {
      const to = parseFloat(after[1]);
      if (sane(to) && to > from) {
        return { label, sortKey: from, sortKeyEnd: to, sequence, mark: `${fmt(from)}–${fmt(to)}` };
      }
    }
    return { label, sortKey: from, sequence, mark: fmt(from) };
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
