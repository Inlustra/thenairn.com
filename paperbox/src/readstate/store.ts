/**
 * The read-state store.
 *
 * `bun:sqlite` is built into the runtime, so this adds no dependency. The
 * merge rules and the reasoning behind the key are in schema.ts; this file is
 * the mechanism.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { DDL, READSTATE_SCHEMA_VERSION } from "./schema";

/**
 * The single reader that exists today.
 *
 * Anonymous compat-API writes land here. See schema.ts for why the column is
 * present at all when there is only ever one value in it.
 */
export const DEFAULT_READER = "default";

/** One chapter's stored position for one reader. */
export interface Progress {
  reader: string;
  seriesUid: string;
  chapterUid: string;
  epoch: number;
  /** Furthest page reached, 1-based. 0 means never opened. */
  page: number;
  /** Page count as last reported by a writer. 0 means unknown. */
  pages: number;
  /** Derived: read_at > unread_at. */
  read: boolean;
  readAt: number;
  unreadAt: number;
  updatedAt: number;
}

/**
 * One write. Every field is optional except the identity, because a client
 * that only knows "the reader turned to page 12" should not have to invent a
 * read flag, and one that only knows "mark this read" should not have to
 * invent a position.
 */
export interface ProgressWrite {
  reader?: string;
  seriesUid: string;
  chapterUid: string;
  /** Furthest page reached, 1-based. */
  page?: number;
  pages?: number;
  /** Bump to reset a position downwards. Defaults to 0. */
  epoch?: number;
  /** Explicitly set or clear the read flag. Omitted leaves it alone. */
  read?: boolean;
  /** Write timestamp in ms. Supplied so replays and tests are deterministic. */
  at?: number;
}

/**
 * unread   -- never opened
 * part-read -- opened, not finished. Held OUTSIDE the window quota.
 * read     -- the reader (or their client) says so
 *
 * Reaching the final page does NOT imply read. The client decides, and the
 * safe direction is to leave a finished-looking chapter classified part-read:
 * part-read is held, so the error costs storage rather than losing the file
 * somebody is halfway through.
 */
export type ReadState = "unread" | "part-read" | "read";

export function classify(p: Progress | undefined): ReadState {
  if (!p) return "unread";
  if (p.read) return "read";
  return p.page > 0 ? "part-read" : "unread";
}

const ROW_COLS = "reader, series_uid, chapter_uid, epoch, page, pages, read_at, unread_at, updated_at";

interface Row {
  reader: string;
  series_uid: string;
  chapter_uid: string;
  epoch: number;
  page: number;
  pages: number;
  read_at: number;
  unread_at: number;
  updated_at: number;
}

function toProgress(r: Row): Progress {
  return {
    reader: r.reader,
    seriesUid: r.series_uid,
    chapterUid: r.chapter_uid,
    epoch: r.epoch,
    page: r.page,
    pages: r.pages,
    // A tie is unread. See schema.ts: over-claiming a finished chapter is the
    // worse error of the two.
    read: r.read_at > r.unread_at,
    readAt: r.read_at,
    unreadAt: r.unread_at,
    updatedAt: r.updated_at,
  };
}

/**
 * The merge, expressed once, in SQL.
 *
 * Doing it as a single UPSERT rather than read-modify-write matters for more
 * than speed: two concurrent writers doing select-then-update lose one of the
 * two updates, and the loss is silent -- the same shape as the unserialised
 * sidecar writes that dropped two of three provenance records.
 *
 *   page   lexicographic max on (epoch, page)
 *   epoch  max
 *   pages  latest non-zero; it is a fact about the file, not reader state
 *   read   two independent max-merged timestamps
 */
const UPSERT = `
INSERT INTO read_state (${ROW_COLS})
VALUES ($reader, $series, $chapter, $epoch, $page, $pages, $readAt, $unreadAt, $at)
ON CONFLICT(reader, series_uid, chapter_uid) DO UPDATE SET
  page = CASE
    WHEN excluded.epoch > read_state.epoch THEN excluded.page
    WHEN excluded.epoch < read_state.epoch THEN read_state.page
    ELSE MAX(read_state.page, excluded.page)
  END,
  epoch      = MAX(read_state.epoch, excluded.epoch),
  pages      = CASE WHEN excluded.pages > 0 THEN excluded.pages ELSE read_state.pages END,
  read_at    = MAX(read_state.read_at, excluded.read_at),
  unread_at  = MAX(read_state.unread_at, excluded.unread_at),
  updated_at = MAX(read_state.updated_at, excluded.updated_at)
`;

/**
 * Refuse to put the database inside the user's library.
 *
 * The library is the user's files. Paperbox already writes one sidecar in
 * there and that is contested (R-05/R-06); a mutable SQLite database, its WAL
 * and its shm alongside the pages is not a question worth reopening by
 * accident. It would also be scanned: `.paperbox-backups` sitting in the
 * library root was picked up as a 13th series.
 */
export function assertOutsideLibrary(dbPath: string, libraryRoot: string | undefined): void {
  if (!libraryRoot || dbPath === ":memory:") return;
  const db = resolve(dbPath);
  const lib = resolve(libraryRoot);
  if (db === lib || db.startsWith(lib.endsWith(sep) ? lib : lib + sep)) {
    throw new Error(
      `refusing to open readstate.db at ${db}: that is inside the library at ${lib}, which Paperbox must never write to`,
    );
  }
}

export class ReadStateStore {
  private db: Database;
  private stmtUpsert;
  private stmtGet;
  private stmtSeries;
  private stmtReadCount;
  private stmtHousehold;

  constructor(path = ":memory:", opts: { libraryRoot?: string } = {}) {
    assertOutsideLibrary(path, opts.libraryRoot ?? process.env.MANGA_DIR);
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path, { create: true });
    // WAL so a reader (the compat API rendering a chapter list) is never
    // blocked by a writer (the same client marking the previous one read).
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(DDL);
    this.db
      .query("INSERT INTO readstate_meta (key, value) VALUES ('schemaVersion', ?) ON CONFLICT(key) DO NOTHING")
      .run(String(READSTATE_SCHEMA_VERSION));

    this.stmtUpsert = this.db.query(UPSERT);
    this.stmtGet = this.db.query<Row, [string, string, string]>(
      `SELECT ${ROW_COLS} FROM read_state WHERE reader = ? AND series_uid = ? AND chapter_uid = ?`,
    );
    // The whole rule query. Bounded by the series, not by the catalogue --
    // read_state_series makes this a SEARCH, and readstate.scale.test.ts holds
    // it to that by asserting the query plan.
    this.stmtSeries = this.db.query<Row, [string, string]>(
      `SELECT ${ROW_COLS} FROM read_state WHERE reader = ? AND series_uid = ?`,
    );
    this.stmtReadCount = this.db.query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM read_state WHERE reader = ? AND series_uid = ? AND read_at > unread_at`,
    );
    this.stmtHousehold = this.db.query<Row, [string, string]>(
      `SELECT ${ROW_COLS} FROM read_state WHERE series_uid = ? AND chapter_uid = ?`,
    );
  }

  /** Apply one write. Idempotent: replaying it changes nothing. */
  record(w: ProgressWrite): void {
    const at = w.at ?? Date.now();
    this.stmtUpsert.run({
      $reader: w.reader ?? DEFAULT_READER,
      $series: w.seriesUid,
      $chapter: w.chapterUid,
      $epoch: w.epoch ?? 0,
      $page: Math.max(0, Math.trunc(w.page ?? 0)),
      $pages: Math.max(0, Math.trunc(w.pages ?? 0)),
      $readAt: w.read === true ? at : 0,
      $unreadAt: w.read === false ? at : 0,
      $at: at,
    });
  }

  /** Apply many writes in one transaction. Same merge, same result, one fsync. */
  recordAll(writes: ProgressWrite[]): void {
    this.db.transaction((batch: ProgressWrite[]) => {
      for (const w of batch) this.record(w);
    })(writes);
  }

  get(seriesUid: string, chapterUid: string, reader = DEFAULT_READER): Progress | undefined {
    const row = this.stmtGet.get(reader, seriesUid, chapterUid);
    return row ? toProgress(row) : undefined;
  }

  /** Every stored row for one series, keyed by chapter uid. One indexed scan. */
  forSeries(seriesUid: string, reader = DEFAULT_READER): Map<string, Progress> {
    const out = new Map<string, Progress>();
    for (const row of this.stmtSeries.all(reader, seriesUid)) out.set(row.chapter_uid, toProgress(row));
    return out;
  }

  /**
   * How many chapters of this series are marked read, for this reader.
   *
   * The compat API's `unreadCount` needs only this and the chapter count, so it
   * never has to enumerate chapters to answer.
   */
  readCount(seriesUid: string, reader = DEFAULT_READER): number {
    return this.stmtReadCount.get(reader, seriesUid)?.n ?? 0;
  }

  /**
   * The household's position in one chapter: `max` across every reader.
   *
   * This is the collapse that decision 1 is about. It is derivable from
   * per-reader rows and per-reader rows are not derivable from it, which is
   * the whole argument for the column.
   */
  householdProgress(seriesUid: string, chapterUid: string): Progress | undefined {
    const rows = this.stmtHousehold.all(seriesUid, chapterUid);
    if (rows.length === 0) return undefined;
    let best = toProgress(rows[0]!);
    for (const r of rows.slice(1)) {
      const p = toProgress(r);
      if (p.epoch > best.epoch || (p.epoch === best.epoch && p.page > best.page)) {
        best = { ...best, epoch: p.epoch, page: p.page, pages: p.pages || best.pages };
      }
      if (p.readAt > best.readAt) best = { ...best, readAt: p.readAt };
      if (p.unreadAt > best.unreadAt) best = { ...best, unreadAt: p.unreadAt };
      if (p.updatedAt > best.updatedAt) best = { ...best, updatedAt: p.updatedAt };
    }
    return { ...best, reader: "*", read: best.readAt > best.unreadAt };
  }

  /**
   * When this series was last touched by a reader, or null if never.
   *
   * The scan scheduler's hot and warm lanes are defined in terms of "read
   * within 24 h" and "read within 30 d" (`docs/scheduler.md`), and this store
   * is the only place in Paperbox that knows. Keyed on `(reader, series_uid)`
   * so it rides the existing index -- a `MAX(updated_at) WHERE series_uid = ?`
   * across every reader would be a full scan of the catalogue for one lane
   * decision, which is precisely what `scale.test.ts` exists to prevent.
   */
  lastReadAt(seriesUid: string, reader = DEFAULT_READER): number | null {
    const r = this.db
      .query<{ at: number | null }, [string, string]>(
        "SELECT MAX(updated_at) AS at FROM read_state WHERE reader = ? AND series_uid = ?",
      )
      .get(reader, seriesUid);
    return r?.at ?? null;
  }

  /** Escape hatch for the scale test and the bench; not part of the API. */
  raw(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
