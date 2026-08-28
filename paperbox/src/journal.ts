// The library journal.
//
// An append-only log of what actually happened to the library, plus the state
// table needed to derive it. A client sends the last sequence number it saw and
// gets everything after it, in order, in one request.
//
// WHY THIS EXISTS ALONGSIDE THE SYNC TREE. The tree answers "what differs
// between us right now" -- an unordered comparison. That is the right question
// for a client returning after a long absence, and the wrong one for a client
// that syncs daily. "A chapter arrived at 03:12 while you slept" is an event,
// and an event has an order; a diff cannot tell you what arrived, only what is
// different now. So: the journal is the fast path, the tree is the cold path
// for anyone who has fallen past the retention horizon.
//
// The state table is what makes this change-data-capture rather than an event
// bus. Without it, every restart would replay the entire library as "added",
// because an in-memory cache starts empty and everything looks new.

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export type EventKind =
  | "series.added"
  | "series.removed"
  | "chapter.added"
  | "chapter.replaced"
  | "chapter.removed";

export interface JournalEntry {
  seq: number;
  at: number;
  kind: EventKind;
  series: string;
  chapter: string | null;
  detail: Record<string, unknown>;
}

/** One chapter as the journal currently believes it to be. */
export interface ChapterState {
  chapter: string;
  series: string;
  fingerprint: string;
  pages: number;
  dir: string;
}

const DEFAULT_RETAIN = 100_000;

let db: Database | null = null;

function open(): Database {
  if (db) return db;
  const path = process.env.JOURNAL_PATH || "/data/journal.db";
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {}
  db = new Database(path, { create: true });
  // WAL so a long scan writing events never blocks a client reading them.
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(`CREATE TABLE IF NOT EXISTS entry(
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    at      INTEGER NOT NULL,
    kind    TEXT    NOT NULL,
    series  TEXT    NOT NULL,
    chapter TEXT,
    detail  TEXT    NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS ix_entry_series ON entry(series, seq)");
  db.exec(`CREATE TABLE IF NOT EXISTS state(
    chapter     TEXT PRIMARY KEY,
    series      TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    pages       INTEGER NOT NULL,
    dir         TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS ix_state_series ON state(series)");
  return db;
}

/** Test seam: point the journal at a different file, or reset it. */
export function resetJournal(path?: string): void {
  if (db) {
    db.close();
    db = null;
  }
  if (path) process.env.JOURNAL_PATH = path;
}

export function head(): number {
  const r = open().query("SELECT COALESCE(MAX(seq), 0) AS n FROM entry").get() as { n: number };
  return r.n;
}

/**
 * Oldest sequence still retained. A client whose cursor is below this has
 * fallen past the horizon and cannot be caught up from the log alone.
 */
export function horizon(): number {
  const r = open().query("SELECT COALESCE(MIN(seq), 0) AS n FROM entry").get() as { n: number };
  return r.n;
}

export interface Delta {
  entries: JournalEntry[];
  cursor: number;
  head: number;
  /** True when the log cannot serve this cursor; fall back to tree reconciliation. */
  rebuild: boolean;
  /** More entries remain past `cursor`; call again. */
  more: boolean;
}

export function since(cursor: number, limit = 500): Delta {
  const d = open();
  const h = head();
  const low = horizon();

  // cursor 0 means "I have nothing" -- always a rebuild, because replaying the
  // entire history of a library is strictly worse than being handed its
  // current shape. The log is for catching up, not for bootstrapping.
  if (cursor <= 0 || (low > 0 && cursor < low - 1)) {
    return { entries: [], cursor, head: h, rebuild: true, more: false };
  }

  const rows = d
    .query("SELECT seq, at, kind, series, chapter, detail FROM entry WHERE seq > ? ORDER BY seq LIMIT ?")
    .all(cursor, limit) as Array<Omit<JournalEntry, "detail"> & { detail: string }>;

  const entries: JournalEntry[] = rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  const next = entries.length ? entries[entries.length - 1]!.seq : cursor;
  return { entries, cursor: next, head: h, rebuild: false, more: next < h };
}

/**
 * Reconcile the journal's view against a fresh scan and emit whatever changed.
 *
 * `observed` is the full current state for the series in scope. Scope matters:
 * a scoped scan only saw one series, so absences elsewhere are not deletions.
 */
export function record(
  observed: ChapterState[],
  opts: { seriesScope?: string } = {},
): JournalEntry[] {
  const d = open();
  const now = Date.now();
  const emitted: JournalEntry[] = [];

  const prevRows = (
    opts.seriesScope
      ? d.query("SELECT * FROM state WHERE series = ?").all(opts.seriesScope)
      : d.query("SELECT * FROM state").all()
  ) as ChapterState[];

  const prev = new Map(prevRows.map((r) => [r.chapter, r]));
  const seenSeries = new Set(prevRows.map((r) => r.series));

  const insert = d.prepare(
    "INSERT INTO entry(at, kind, series, chapter, detail) VALUES (?,?,?,?,?)",
  );
  const upsert = d.prepare(
    `INSERT INTO state(chapter, series, fingerprint, pages, dir) VALUES (?,?,?,?,?)
     ON CONFLICT(chapter) DO UPDATE SET fingerprint=excluded.fingerprint,
       pages=excluded.pages, dir=excluded.dir, series=excluded.series`,
  );
  const drop = d.prepare("DELETE FROM state WHERE chapter = ?");

  const emit = (kind: EventKind, series: string, chapter: string | null, detail: object) => {
    const r = insert.run(now, kind, series, chapter, JSON.stringify(detail)) as { lastInsertRowid: number };
    emitted.push({ seq: Number(r.lastInsertRowid), at: now, kind, series, chapter, detail: detail as any });
  };

  d.transaction(() => {
    const liveSeries = new Set<string>();

    for (const c of observed) {
      liveSeries.add(c.series);
      const was = prev.get(c.chapter);
      if (!was) {
        if (!seenSeries.has(c.series) && !liveSeries.has(c.series)) {
          emit("series.added", c.series, null, {});
        }
        emit("chapter.added", c.series, c.chapter, { dir: c.dir, pages: c.pages });
      } else if (was.fingerprint !== c.fingerprint) {
        // Same chapter, different content -- a re-source or a repaired page.
        emit("chapter.replaced", c.series, c.chapter, {
          dir: c.dir, pages: c.pages, was: was.fingerprint,
        });
      }
      upsert.run(c.chapter, c.series, c.fingerprint, c.pages, c.dir);
      prev.delete(c.chapter);
    }

    // Anything left in `prev` was not observed. Only a deletion if we actually
    // looked where it should have been.
    for (const gone of prev.values()) {
      if (opts.seriesScope && gone.series !== opts.seriesScope) continue;
      emit("chapter.removed", gone.series, gone.chapter, { dir: gone.dir });
      drop.run(gone.chapter);
    }

    for (const s of seenSeries) {
      if (liveSeries.has(s)) continue;
      if (opts.seriesScope && s !== opts.seriesScope) continue;
      emit("series.removed", s, null, {});
    }
  })();

  return emitted;
}

/**
 * Drop history older than the retention window.
 *
 * Compaction is what makes the horizon real: a client past it must rebuild from
 * the tree instead. Retention is therefore a product decision about how long a
 * phone may be away before catching up costs more than starting fresh.
 */
export function compact(retain = Number(process.env.JOURNAL_RETAIN) || DEFAULT_RETAIN): number {
  const d = open();
  const h = head();
  const cutoff = h - retain;
  if (cutoff <= 0) return 0;
  const before = horizon();
  d.query("DELETE FROM entry WHERE seq <= ?").run(cutoff);
  return Math.max(0, cutoff - before + 1);
}

export function stats() {
  const d = open();
  const r = d.query("SELECT COUNT(*) AS entries FROM entry").get() as { entries: number };
  const s = d.query("SELECT COUNT(*) AS chapters FROM state").get() as { chapters: number };
  return { entries: r.entries, chapters: s.chapters, head: head(), horizon: horizon() };
}
