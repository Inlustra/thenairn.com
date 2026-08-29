/**
 * The persistent job queue.
 *
 * `bun:sqlite`, with schema.ts holding
 * the reasoning, this file is the mechanism.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DDL, JOBS_SCHEMA_VERSION } from "./schema";

/**
 * Every kind of background work there is.
 *
 * The list is flat on purpose. A scan is not a different *category* of work
 * from cutting a spine -- it is the same shape (enumerate units, run them
 * through the shared budget, report progress, stop when cancelled) pointed at a
 * different artefact. See `docs/decisions.md`, "One queue, several job kinds".
 *
 * `scan` discovers, and records only facts that are free -- names, byte sizes,
 * mtimes, the fingerprint. It never opens a page. Everything that opens a page
 * is one of the others, and the scan is what notices they are missing.
 */
export type JobKind = "scan" | "art" | "cover" | "height";
export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * The wire shape, exactly as `GET /api/jobs` returns it.
 *
 * Deliberately flat and deliberately small. A client polling this every couple
 * of seconds should be able to diff it without parsing anything nested, and
 * every field is either identity, a state, or a number it can render.
 */
export interface Job {
  id: string;
  kind: JobKind;
  /** Series uid, or null for library-wide. */
  scope: string | null;
  /** Human, one line, e.g. "Nano Machine". */
  label: string;
  state: JobState;
  /** Units completed. */
  done: number;
  /** Null when not yet known. */
  total: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Set only when state === "failed". */
  error: string | null;
}

interface Row {
  id: string;
  kind: JobKind;
  scope: string | null;
  label: string;
  state: JobState;
  done: number;
  total: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  cancelled: number;
  silent: number;
}

function toJob(r: Row): Job {
  return {
    id: r.id,
    kind: r.kind,
    scope: r.scope,
    label: r.label,
    state: r.state,
    done: r.done,
    total: r.total,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    // Only a failure carries a message. A cancelled job is not an error and
    // must not render as one.
    error: r.state === "failed" ? r.error : null,
  };
}

export interface EnqueueOptions {
  kind: JobKind;
  scope?: string | null;
  label: string;
  total?: number | null;
  /**
   * Nobody asked for this. It runs like any other job and appears in no list.
   *
   * Only the rolling scan sets it. See `schema.ts` for why this is a column and
   * not a second scheduler.
   */
  silent?: boolean;
}

/** How long a finished job stays visible before it is pruned. */
const RETAIN_MS = 6 * 60 * 60 * 1000;
/** ...and how many, whichever is the larger set. A queue that empties itself
 *  the moment work finishes cannot answer "did that actually run?". */
const RETAIN_MIN = 50;

export class JobQueue {
  private db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(DDL);
    this.migrate();
    this.db
      .query("INSERT OR REPLACE INTO jobs_meta (key, value) VALUES ('schema_version', ?)")
      .run(String(JOBS_SCHEMA_VERSION));
    this.recover();
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
   * so a column added later has to be added by hand. Read from
   * `PRAGMA table_info` rather than from the recorded schema version: the
   * version says what we last *wrote*, the pragma says what is actually there,
   * and only the second one can be checked.
   */
  private migrate(): void {
    const cols = this.db
      .query<{ name: string }, []>("PRAGMA table_info(job)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("silent")) {
      this.db.exec("ALTER TABLE job ADD COLUMN silent INTEGER NOT NULL DEFAULT 0");
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Anything left `running` was interrupted, by definition: this process is the
   * only thing that runs jobs and it has just started. Returning them to
   * `queued` rather than failing them is the honest reading -- nothing went
   * wrong with the work, it simply did not happen -- and it keeps `done` so the
   * job resumes rather than restarting where a handler supports it.
   */
  recover(): number {
    return this.db
      .query("UPDATE job SET state = 'queued', started_at = NULL WHERE state = 'running'")
      .run().changes;
  }

  /**
   * Queue a job, or return the one already queued or running for this
   * (kind, scope). The caller is told which by comparing ids, and in practice
   * does not care: what it asked for is going to happen either way.
   *
   * One exception, and it is the whole reason `silent` can be trusted: if the
   * job already queued is silent and this caller is *not* silent, the flag is
   * cleared. Otherwise a rotation that happened to queue a scan of series X one
   * second earlier would swallow the user's "look at X now" -- they would press
   * the button, the work would genuinely happen, and nothing would ever appear.
   * Asking is what makes work someone's errand; it can only ever promote.
   */
  enqueue(opts: EnqueueOptions): Job {
    const scope = opts.scope ?? null;
    const silent = opts.silent === true;
    const existing = this.db
      .query<Row, [JobKind, string]>(
        "SELECT * FROM job WHERE kind = ? AND ifnull(scope,'') = ? AND state IN ('queued','running')",
      )
      .get(opts.kind, scope ?? "");
    if (existing) return toJob(this.promote(existing, silent));

    const id = `job-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    try {
      this.db
        .query(
          "INSERT INTO job (id, kind, scope, label, state, done, total, created_at, silent) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)",
        )
        .run(id, opts.kind, scope, opts.label, opts.total ?? null, now, silent ? 1 : 0);
    } catch (e) {
      // Lost the race against the partial unique index. The winner's job is
      // the answer; this is the reason the index exists rather than a check.
      const won = this.db
        .query<Row, [JobKind, string]>(
          "SELECT * FROM job WHERE kind = ? AND ifnull(scope,'') = ? AND state IN ('queued','running')",
        )
        .get(opts.kind, scope ?? "");
      if (won) return toJob(this.promote(won, silent));
      throw e;
    }
    return toJob(this.db.query<Row, [string]>("SELECT * FROM job WHERE id = ?").get(id)!);
  }

  private promote(row: Row, silent: boolean): Row {
    if (silent || row.silent === 0) return row;
    this.db.query("UPDATE job SET silent = 0 WHERE id = ?").run(row.id);
    return { ...row, silent: 0 };
  }

  get(id: string): Job | null {
    const r = this.db.query<Row, [string]>("SELECT * FROM job WHERE id = ?").get(id);
    return r ? toJob(r) : null;
  }

  /**
   * What a client may see: newest first among finished work, anything live
   * first, and nothing silent.
   *
   * The filter is here rather than in the route so it cannot be forgotten by
   * the next reader of the queue -- `counts()` and `signature()` are both built
   * on it, so a silent job cannot move the ETag either, and a poll during the
   * whole rolling rotation still costs a 304 and no body.
   */
  list(): Job[] {
    return this.rows("WHERE silent = 0");
  }

  /** Everything, silent work included. For the runner, the tests and nothing else. */
  listAll(): Job[] {
    return this.rows("");
  }

  private rows(where: string): Job[] {
    return this.db
      .query<Row, []>(
        `SELECT * FROM job ${where}
         ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                  created_at DESC`,
      )
      .all()
      .map(toJob);
  }

  counts(): { running: number; queued: number } {
    const r = this.db
      .query<{ running: number; queued: number }, []>(
        `SELECT SUM(state = 'running') AS running, SUM(state = 'queued') AS queued
         FROM job WHERE silent = 0`,
      )
      .get();
    return { running: r?.running ?? 0, queued: r?.queued ?? 0 };
  }

  /**
   * Did anyone ask for this job?
   *
   * Read like `isCancelled`, one small query at claim time, rather than carried
   * on `Job`: `Job` is the wire shape, and a flag that is false for every job a
   * client can ever see has no business on it.
   */
  isSilent(id: string): boolean {
    const r = this.db.query<{ silent: number }, [string]>("SELECT silent FROM job WHERE id = ?").get(id);
    return r?.silent === 1;
  }

  /**
   * Content-derived, never a counter.
   *
   * `docs/decisions.md`: "Every status signal is content-derived, never a
   * counter." A counter would churn on every prune and every enqueue of work
   * that turned out to be a duplicate, and the ETag would never return 304.
   * This hashes what a client actually renders, so it is stable exactly when
   * the rendered answer is.
   */
  signature(): string {
    const hasher = new Bun.CryptoHasher("sha256");
    for (const j of this.list()) {
      hasher.update(`${j.id}:${j.state}:${j.done}:${j.total ?? "-"}:${j.error ?? ""} `);
    }
    return hasher.digest("hex").slice(0, 16);
  }

  /**
   * Take the oldest queued job.
   *
   * One statement, so two workers cannot claim the same row: the UPDATE picks
   * its own target and SQLite serialises writers.
   */
  claim(): Job | null {
    const r = this.db
      .query<Row, [number]>(
        `UPDATE job SET state = 'running', started_at = ?
         WHERE id = (SELECT id FROM job WHERE state = 'queued' ORDER BY created_at LIMIT 1)
         RETURNING *`,
      )
      .get(Date.now());
    return r ? toJob(r) : null;
  }

  progress(id: string, done: number, total?: number | null): void {
    if (total === undefined) {
      this.db.query("UPDATE job SET done = ? WHERE id = ?").run(done, id);
    } else {
      this.db.query("UPDATE job SET done = ?, total = ? WHERE id = ?").run(done, total, id);
    }
  }

  /**
   * A cancelled job that was already running finishes as `cancelled`, not as
   * `done`: the work stopped early and saying otherwise would claim artefacts
   * that were never produced. See `docs/decisions.md`, "Work that reports
   * success while producing nothing".
   */
  finish(id: string): void {
    this.db
      .query(
        `UPDATE job SET state = CASE WHEN cancelled = 1 THEN 'cancelled' ELSE 'done' END,
                        finished_at = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(Date.now(), id);
  }

  fail(id: string, error: string): void {
    this.db
      .query("UPDATE job SET state = 'failed', error = ?, finished_at = ? WHERE id = ? AND state = 'running'")
      .run(error.slice(0, 500), Date.now(), id);
  }

  /**
   * Cancel is idempotent and always succeeds against a live job.
   *
   * A queued job is cancelled outright. A running one is *flagged*; the worker
   * sees it between units and stops. Killing mid-unit would leave a half-written
   * artefact, which the store's rename-into-place is designed to make
   * impossible -- so the flag is not a weaker cancel, it is the one that keeps
   * that guarantee.
   */
  cancel(id: string): boolean {
    const now = Date.now();
    const queued = this.db
      .query("UPDATE job SET state = 'cancelled', cancelled = 1, finished_at = ? WHERE id = ? AND state = 'queued'")
      .run(now, id).changes;
    if (queued > 0) return true;
    const running = this.db
      .query("UPDATE job SET cancelled = 1 WHERE id = ? AND state = 'running'")
      .run(id).changes;
    return running > 0;
  }

  isCancelled(id: string): boolean {
    const r = this.db.query<{ cancelled: number }, [string]>("SELECT cancelled FROM job WHERE id = ?").get(id);
    return r?.cancelled === 1;
  }

  /** Drop old finished work, keeping the most recent regardless of age. */
  prune(now = Date.now()): number {
    return this.db
      .query(
        `DELETE FROM job
         WHERE state IN ('done','failed','cancelled')
           AND finished_at < ?
           AND id NOT IN (
             SELECT id FROM job WHERE state IN ('done','failed','cancelled')
             ORDER BY finished_at DESC LIMIT ?
           )`,
      )
      .run(now - RETAIN_MS, RETAIN_MIN).changes;
  }
}
