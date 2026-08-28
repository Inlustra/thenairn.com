/**
 * The job queue's schema.
 *
 * -------------------------------------------------------------------------
 * Why this is on disk at all
 * -------------------------------------------------------------------------
 * The download queue is a `Map` in `src/downloads/manager.ts`. Restart the
 * container and every task in it is gone -- not failed, not cancelled, simply
 * absent, with no record that anything was ever asked for. That is the failure
 * this table exists to not repeat. A job survives a restart; a job that was
 * *running* when the process died comes back `queued`, because the one thing
 * we know for certain about it is that nothing is running it now.
 *
 * -------------------------------------------------------------------------
 * Why the file may have a default path, when readstate.db may not
 * -------------------------------------------------------------------------
 * `src/readstate/schema.ts` refuses to invent a location, because read state
 * cannot be rebuilt by rescanning and a default would be a path that
 * `--force-recreate` deletes. Every row in *this* table describes work that can
 * simply be asked for again, over artefacts that are themselves regenerable, so
 * losing the file costs a re-derivation and never a fact. It therefore defaults
 * to `$DERIVED_DIR/jobs.db` -- inside the store it manages, so that deleting
 * the store deletes its bookkeeping too and the two cannot disagree.
 *
 * -------------------------------------------------------------------------
 * The partial unique index is the deduplication rule
 * -------------------------------------------------------------------------
 * `(kind, scope)` is unique among jobs that have not finished. Asking twice for
 * the artwork of one series -- a page load, a rescan and a download all
 * plausibly do -- must not queue the work twice, and expressing that as an
 * index rather than as a check-then-insert means two callers racing cannot both
 * pass the check. `ifnull(scope,'')` because SQL NULLs never compare equal, so
 * without it every library-wide job would be distinct from every other one.
 */

export const JOBS_SCHEMA_VERSION = 1;

export const DDL = `
CREATE TABLE IF NOT EXISTS job (
  id          TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL,
  -- Series uid, or NULL for library-wide.
  scope       TEXT,
  -- One human line. Rendered as-is; never a template the client has to fill.
  label       TEXT    NOT NULL,
  state       TEXT    NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  -- NULL, not 0, while the total is unknown. A client showing 0/0 as a
  -- percentage renders NaN; a client showing null knows to draw no bar.
  total       INTEGER,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER,
  error       TEXT,
  -- Set by cancel, cleared by nothing. The worker reads it between units, so a
  -- cancel is observed at unit granularity rather than by killing anything.
  cancelled   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS job_state ON job (state, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS job_pending
  ON job (kind, ifnull(scope, ''))
  WHERE state IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS jobs_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
