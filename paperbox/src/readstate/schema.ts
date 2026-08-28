/**
 * The read-state schema.
 *
 * This is the first table in Paperbox that **cannot be rebuilt by rescanning**.
 * Every other cached fact -- fingerprints, chapter keys, ids -- is either on
 * disk in `paperbox.json` or re-derivable from the library. Read state is not:
 * if this file is lost, the only record of where anybody was is gone, and the
 * reader finds out by opening a series and being 60 chapters adrift.
 *
 * Where the file should live, and whether that path is backed up, is FLAGGED
 * AND NOT DECIDED -- see `dbPathNote` below and docs/register.md R-11.
 *
 * -------------------------------------------------------------------------
 * Why the primary key includes a reader
 * -------------------------------------------------------------------------
 * Exactly one reader ships, there is no auth, and nothing in the product can
 * currently tell two people apart. The column is still here from the first
 * write, and the reason is not symmetry:
 *
 *   A household's position in a series is `max(everyone)`. Once several people
 *   read the same library through one unattributed identity, the rows say
 *   "chapter 212 was read" and nothing says *by whom*. The information needed
 *   to split that back out per person is never written down anywhere, so
 *   adding readers afterwards is a guess dressed as a migration -- you would be
 *   inventing an attribution, not recovering one.
 *
 * The cost of carrying it now is one TEXT column, on a table whose rows are
 * already keyed by two other strings. The cost of adding it later is data that
 * does not exist.
 *
 * The concrete trigger is in the compat API: `updateChapter` /
 * `PATCH /api/v1/manga/:id/chapter/:id` carry no reader identity at all. Every
 * write that arrives today is anonymous, which is precisely why the column has
 * to be there before the writes start.
 *
 * -------------------------------------------------------------------------
 * Merge: position by max, read flag by two timestamps
 * -------------------------------------------------------------------------
 * Position merges by `max`, which is commutative, associative and idempotent,
 * so the order replicas reconnect in cannot change the result and a duplicate
 * delivery is free. Last-write-wins would need a clock we do not have, and its
 * failure mode is a silent rewind: an offline phone reconnects, its stale
 * "page 4" lands after the tablet's "page 190", and the reader loses their
 * place with no error anywhere. Furthest-wins fails the other way -- you scroll
 * back a few pages you had already read -- which is visible, recoverable, and
 * costs seconds.
 *
 * `epoch` is the escape hatch max-merge otherwise lacks. A deliberate reset
 * ("start this series again") bumps the epoch; a higher epoch takes the new
 * position wholesale rather than maxing against the old one. Without it,
 * furthest-wins means a position can never go down, which is wrong for the one
 * case where going down is the whole intent. Comparison is lexicographic on
 * `(epoch, page)`, which is still a lattice join, so all three properties hold.
 *
 * The read flag is two monotonically-max-merged timestamps rather than a
 * boolean plus a clock: `read` is true when `read_at > unread_at`. Setting read
 * and setting unread are independent max-merges, so they are order-independent
 * too, and an HLC is not needed to decide between them -- the two facts never
 * contend for one cell. A tie resolves to *unread*: claiming someone finished a
 * chapter they did not is the worse of the two errors.
 */

export const READSTATE_SCHEMA_VERSION = 1;

/**
 * `WITHOUT ROWID` because the primary key *is* the whole row's identity and
 * every lookup is by it or by its two-column prefix. The index on
 * `(reader, series_uid)` is what makes a rule cost O(series), not O(catalogue) --
 * see readstate.scale.test.ts, which asserts the query plan is a SEARCH.
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS read_state (
  reader      TEXT    NOT NULL,
  series_uid  TEXT    NOT NULL,
  chapter_uid TEXT    NOT NULL,
  -- Reset generation. Higher wins outright; equal epochs max on page.
  epoch       INTEGER NOT NULL DEFAULT 0,
  -- Furthest page reached, 1-based. 0 means "never opened".
  page        INTEGER NOT NULL DEFAULT 0,
  -- Page count as the writer saw it. A denominator, not reader state; 0 unknown.
  pages       INTEGER NOT NULL DEFAULT 0,
  -- The read flag, as two max-merged timestamps. read = read_at > unread_at.
  read_at     INTEGER NOT NULL DEFAULT 0,
  unread_at   INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (reader, series_uid, chapter_uid)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS read_state_series ON read_state (reader, series_uid);

CREATE TABLE IF NOT EXISTS readstate_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * FLAGGED, NOT DECIDED -- where `readstate.db` lives, and whether it is backed up.
 *
 * The container today mounts exactly two paths: the library at `/manga` (the
 * user's files, which this store must never write into) and `/scripts`. There
 * is no state volume, so an unconfigured server puts the database somewhere
 * that a `docker compose up -d --force-recreate` deletes.
 *
 * That is not a decision to make inside this module. What it needs is a named
 * host path, in the compose file, on something that is actually swept -- and
 * somebody to confirm that sweep covers it, by listing the destination rather
 * than by reading a script. Until then `READSTATE_DB` is required to be set
 * explicitly for anything whose loss would matter.
 */
export const dbPathNote =
  "readstate.db is the first table that cannot be rebuilt by rescanning; " +
  "its location and backup path are unresolved. Set READSTATE_DB explicitly.";
