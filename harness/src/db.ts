// The harness's own state. Codex keeps conversation history in its rollouts;
// everything that must be *true* — who is approved, what was requested, what
// the guest has been told — lives here, where code (not a model) owns it.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Person = {
  number: string; // digits only, e.g. 447700900123
  jid: string;
  name: string | null;
  status: "approved" | "pending" | "denied";
  notes: string;
};

// One request by one person: the structured record the check-in loop works
// from. If two people want the same title, each has their own.
export type Job = {
  id: string;
  number: string; // who asked
  media_type: "movie" | "series";
  service: string | null; // movie | series | anime_movie | anime_series
  title: string;
  year: number | null;
  ext_id: number; // tmdbId for movies, tvdbId for series
  season: number | null;
  state: string; // queued searching downloading importing on_disk ready attention retrying waiting_release stuck failed cancelled
  told_state: string | null;
  created_at: number;
  updated_at: number;
  escalated_at: number | null;
  percent: number | null;
  bytes_left: number | null;
  eta: string | null;
  release_date: string | null;
  state_since: number | null; // when the current state began
  progress_at: number | null; // when bytes last moved
  retries: number; // copies swapped out so far
  last_update_at: number | null; // when the person last heard about it
};

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      number TEXT PRIMARY KEY, jid TEXT NOT NULL, name TEXT,
      status TEXT NOT NULL CHECK (status IN ('approved','pending','denied')),
      notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS held_messages (
      id INTEGER PRIMARY KEY, number TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, tools_version TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      number TEXT NOT NULL, media_type TEXT NOT NULL, ext_id INTEGER NOT NULL,
      title TEXT NOT NULL, year INTEGER, seasons TEXT, at INTEGER NOT NULL,
      PRIMARY KEY (number, media_type, ext_id)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, number TEXT NOT NULL, media_type TEXT NOT NULL, title TEXT NOT NULL,
      year INTEGER, ext_id INTEGER NOT NULL, season INTEGER, state TEXT NOT NULL,
      told_state TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, escalated_at INTEGER
    );
    -- Everything an agent has been asked and not yet answered. Survives restarts.
    CREATE TABLE IF NOT EXISTS inbox (
      id INTEGER PRIMARY KEY, agent TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL,
      at INTEGER NOT NULL, done_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS inbox_pending ON inbox (agent, key) WHERE done_at IS NULL;
    -- Inbound message ids already handled, so a redelivery is ignored.
    CREATE TABLE IF NOT EXISTS seen (
      channel TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (channel, id)
    );
    -- Updates owed to a person about a request. Written in the same
    -- transaction as the state change; delivered_at is set only once the
    -- message has actually gone out.
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, state TEXT NOT NULL, text TEXT NOT NULL,
      created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, delivered_at INTEGER,
      UNIQUE (job_id, state)
    );
    -- Everything that happened in every conversation, for the console:
    -- what the agent was given, tool calls and results, private notes,
    -- what was sent, nudges and failures.
    CREATE TABLE IF NOT EXISTS trace (
      id INTEGER PRIMARY KEY, agent TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL,
      data TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trace_by_key ON trace (agent, key, id);
    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS job_events_by_job ON job_events (job_id, id);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, channel TEXT NOT NULL, peer TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')), text TEXT NOT NULL, at INTEGER NOT NULL
    );
  `);
  // Columns added after the first schema. SQLite has no ADD COLUMN IF NOT EXISTS.
  const cols = (t: string) => new Set((db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
  const add = (t: string, defs: Record<string, string>) => {
    const have = cols(t);
    for (const [c, d] of Object.entries(defs)) if (!have.has(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
  };
  add("jobs", {
    service: "TEXT", percent: "INTEGER", bytes_left: "INTEGER", eta: "TEXT", release_date: "TEXT",
    state_since: "INTEGER", progress_at: "INTEGER", retries: "INTEGER NOT NULL DEFAULT 0", last_update_at: "INTEGER",
  });
  add("candidates", { anime: "INTEGER NOT NULL DEFAULT 0", gated: "INTEGER NOT NULL DEFAULT 0", hard: "INTEGER NOT NULL DEFAULT 0", poster: "TEXT" });
  db.exec("CREATE TABLE IF NOT EXISTS access_requests (number TEXT NOT NULL, capability TEXT NOT NULL, title TEXT, at INTEGER NOT NULL, resolved_at INTEGER, PRIMARY KEY (number, capability))");
  add("people", { profile: "TEXT NOT NULL DEFAULT '{}'", caps: "TEXT NOT NULL DEFAULT '{}'", plex_account: "INTEGER" });
  add("threads", { created_at: "INTEGER", last_turn_at: "INTEGER", turns: "INTEGER NOT NULL DEFAULT 0", last_context: "INTEGER" });
  add("notifications", { key: "TEXT" });
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS notifications_key ON notifications (job_id, key) WHERE key IS NOT NULL");
  return new Store(db);
}

export class Store {
  constructor(readonly db: Database) {}

  person(number: string): Person | null {
    return this.db.query("SELECT number, jid, name, status, notes FROM people WHERE number = ?").get(number) as Person | null;
  }

  upsertPerson(p: { number: string; jid: string; name?: string | null; status: Person["status"] }) {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO people (number, jid, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(number) DO UPDATE SET jid = excluded.jid, name = COALESCE(excluded.name, people.name),
           status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(p.number, p.jid, p.name ?? null, p.status, now, now);
  }

  setName(number: string, name: string) {
    this.db.query("UPDATE people SET name = ?, updated_at = ? WHERE number = ? AND name IS NULL").run(name, Date.now(), number);
  }

  addNote(number: string, note: string) {
    const p = this.person(number);
    if (!p) return;
    const lines = [...p.notes.split("\n").filter(Boolean), note.trim()].slice(-30);
    this.db.query("UPDATE people SET notes = ?, updated_at = ? WHERE number = ?").run(lines.join("\n"), Date.now(), number);
  }

  // The Plex account Tom linked to this person (for watch history).
  plexAccount(number: string): number | null {
    return (this.db.query("SELECT plex_account FROM people WHERE number = ?").get(number) as { plex_account: number | null } | null)?.plex_account ?? null;
  }

  linkPlex(number: string, account: number | null) {
    this.db.query("UPDATE people SET plex_account = ?, updated_at = ? WHERE number = ?").run(account, Date.now(), number);
  }

  // What Tom has switched on for someone (see milo.ts CAPABILITIES).
  caps(number: string): Record<string, boolean> {
    const r = this.db.query("SELECT caps FROM people WHERE number = ?").get(number) as { caps: string } | null;
    return r ? JSON.parse(r.caps || "{}") : {};
  }

  setCap(number: string, cap: string, on: boolean) {
    const c = this.caps(number);
    if (on) c[cap] = true;
    else delete c[cap];
    this.db.query("UPDATE people SET caps = ?, updated_at = ? WHERE number = ?").run(JSON.stringify(c), Date.now(), number);
  }

  // What Milo knows about someone, as named fields (see milo.ts PROFILE_FIELDS).
  profile(number: string): Record<string, string> {
    const r = this.db.query("SELECT profile FROM people WHERE number = ?").get(number) as { profile: string } | null;
    return r ? JSON.parse(r.profile || "{}") : {};
  }

  setProfile(number: string, field: string, value: string) {
    const p = this.profile(number);
    if (value) p[field] = value;
    else delete p[field];
    this.db.query("UPDATE people SET profile = ?, updated_at = ? WHERE number = ?").run(JSON.stringify(p), Date.now(), number);
  }

  pendingPeople(): Person[] {
    return this.db.query("SELECT number, jid, name, status, notes FROM people WHERE status = 'pending' ORDER BY updated_at").all() as Person[];
  }

  hold(number: string, text: string) {
    this.db.query("INSERT INTO held_messages (number, text, at) VALUES (?, ?, ?)").run(number, text, Date.now());
  }

  takeHeld(number: string): string[] {
    const rows = this.db.query("SELECT text FROM held_messages WHERE number = ? ORDER BY id").all(number) as { text: string }[];
    this.db.query("DELETE FROM held_messages WHERE number = ?").run(number);
    return rows.map((r) => r.text);
  }

  thread(key: string): { thread_id: string; tools_version: string; created_at: number | null; last_turn_at: number | null; turns: number; last_context: number | null } | null {
    return this.db.query("SELECT thread_id, tools_version, created_at, last_turn_at, turns, last_context FROM threads WHERE key = ?").get(key) as any;
  }

  setThread(key: string, threadId: string, toolsVersion: string) {
    const now = Date.now();
    this.db
      .query("INSERT OR REPLACE INTO threads (key, thread_id, tools_version, updated_at, created_at, turns) VALUES (?, ?, ?, ?, ?, 0)")
      .run(key, threadId, toolsVersion, now, now);
  }

  threadTurn(key: string, context: number | null) {
    this.db.query("UPDATE threads SET last_turn_at = ?, turns = turns + 1, last_context = COALESCE(?, last_context) WHERE key = ?").run(Date.now(), context, key);
  }

  // The last few messages with this person, oldest first, for a new thread.
  recentMessages(peer: string, limit: number): { direction: string; text: string; at: number }[] {
    return (this.db.query("SELECT direction, text, at FROM messages WHERE peer = ? ORDER BY id DESC LIMIT ?").all(peer, limit) as any[]).reverse();
  }

  dropThread(key: string) {
    this.db.query("DELETE FROM threads WHERE key = ?").run(key);
  }

  rememberCandidate(number: string, c: { media_type: string; ext_id: number; title: string; year: number | null; seasons?: number[]; anime?: boolean; gated?: boolean; hard?: boolean; poster?: string | null }) {
    this.db
      .query("INSERT OR REPLACE INTO candidates (number, media_type, ext_id, title, year, seasons, anime, gated, hard, poster, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(number, c.media_type, c.ext_id, c.title, c.year, c.seasons ? JSON.stringify(c.seasons) : null, c.anime ? 1 : 0, c.gated ? 1 : 0, c.hard ? 1 : 0, c.poster ?? null, Date.now());
  }

  candidate(number: string, mediaType: string, extId: number) {
    const r = this.db
      .query("SELECT media_type, ext_id, title, year, seasons, anime, gated, hard, poster FROM candidates WHERE number = ? AND media_type = ? AND ext_id = ?")
      .get(number, mediaType, extId) as any;
    return r ? { ...r, anime: !!r.anime, gated: !!r.gated, hard: !!r.hard, seasons: r.seasons ? (JSON.parse(r.seasons) as number[]) : undefined } : null;
  }

  job(id: string): Job | null {
    return this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as Job | null;
  }

  insertJob(j: Pick<Job, "id" | "number" | "media_type" | "service" | "title" | "year" | "ext_id" | "season" | "state">) {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO jobs (id, number, media_type, service, title, year, ext_id, season, state, created_at, updated_at, state_since)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(j.id, j.number, j.media_type, j.service, j.title, j.year, j.ext_id, j.season, j.state, now, now, now);
  }

  // A failed or cancelled request asked for again: start its clock over.
  restartJob(id: string, service: string) {
    const now = Date.now();
    this.db
      .query("UPDATE jobs SET state = 'queued', service = ?, created_at = ?, updated_at = ?, state_since = ?, escalated_at = NULL, retries = 0, told_state = NULL, last_update_at = NULL WHERE id = ?")
      .run(service, now, now, now, id);
  }

  setJobState(id: string, state: string) {
    const now = Date.now();
    this.db.query("UPDATE jobs SET state = ?, updated_at = ?, state_since = ? WHERE id = ? AND state != ?").run(state, now, now, id, state);
  }

  setJobProgress(id: string, p: { percent?: number | null; bytes_left?: number | null; eta?: string | null; release_date?: string | null; moved?: boolean }) {
    this.db
      .query("UPDATE jobs SET percent = ?, bytes_left = ?, eta = ?, release_date = COALESCE(?, release_date), progress_at = CASE WHEN ? THEN ? ELSE progress_at END WHERE id = ?")
      .run(p.percent ?? null, p.bytes_left ?? null, p.eta ?? null, p.release_date ?? null, p.moved ? 1 : 0, Date.now(), id);
  }

  bumpRetries(id: string) {
    this.db.query("UPDATE jobs SET retries = retries + 1 WHERE id = ?").run(id);
  }

  jobEvent(jobId: string, kind: string, data: unknown) {
    this.db.query("INSERT INTO job_events (job_id, kind, data, at) VALUES (?, ?, ?, ?)").run(jobId, kind, JSON.stringify(data), Date.now());
  }

  jobEvents(jobId: string) {
    return (this.db.query("SELECT kind, data, at FROM job_events WHERE job_id = ? ORDER BY id").all(jobId) as any[]).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  markTold(id: string, state: string) {
    this.db.query("UPDATE jobs SET told_state = ? WHERE id = ?").run(state, id);
  }

  markEscalated(id: string) {
    this.db.query("UPDATE jobs SET escalated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  openJobs(number?: string): Job[] {
    const open = "state NOT IN ('ready','failed','cancelled')";
    return (number
      ? this.db.query(`SELECT * FROM jobs WHERE number = ? AND ${open} ORDER BY created_at`).all(number)
      : this.db.query(`SELECT * FROM jobs WHERE ${open} ORDER BY created_at`).all()) as Job[];
  }

  recentJobs(number: string, limit = 10): Job[] {
    return this.db.query("SELECT * FROM jobs WHERE number = ? ORDER BY created_at DESC LIMIT ?").all(number, limit) as Job[];
  }

  enqueue(agent: string, key: string, text: string) {
    this.db.query("INSERT INTO inbox (agent, key, text, at) VALUES (?, ?, ?, ?)").run(agent, key, text, Date.now());
  }

  queued(agent: string, key: string): { id: number; text: string; at: number }[] {
    return this.db.query("SELECT id, text, at FROM inbox WHERE agent = ? AND key = ? AND done_at IS NULL ORDER BY id").all(agent, key) as any;
  }

  queuedKeys(agent: string): string[] {
    return (this.db.query("SELECT DISTINCT key FROM inbox WHERE agent = ? AND done_at IS NULL").all(agent) as { key: string }[]).map((r) => r.key);
  }

  markDone(ids: number[]) {
    const q = this.db.query("UPDATE inbox SET done_at = ? WHERE id = ?");
    const now = Date.now();
    this.db.transaction(() => ids.forEach((id) => q.run(now, id)))();
  }

  // True the first time an inbound id is seen, false for a redelivery.
  firstSeen(channel: string, id: string): boolean {
    return this.db.query("INSERT OR IGNORE INTO seen (channel, id, at) VALUES (?, ?, ?)").run(channel, id, Date.now()).changes > 0;
  }

  // Record a new job state and, if the person should hear about it, the
  // update owed to them, atomically. `key` makes each update happen once
  // (e.g. "ready", "retry-2", "progress-3").
  transition(jobId: string, state: string | null, owed: { key: string; text: string } | null) {
    this.db.transaction(() => {
      if (state) this.setJobState(jobId, state);
      if (owed) this.owe(jobId, owed.key, owed.text, state);
    })();
  }

  owe(jobId: string, key: string, text: string, _state: string | null = null) {
    const r = this.db
      .query("INSERT OR IGNORE INTO notifications (job_id, key, state, text, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(jobId, key, key, text, Date.now()); // `state` column holds the key too: its old UNIQUE(job_id, state) then still holds
    if (r.changes) this.jobEvent(jobId, "update_owed", { key });
  }

  undelivered(): { id: number; job_id: string; state: string; text: string; attempts: number; number: string }[] {
    return this.db
      .query("SELECT n.id, n.job_id, n.state, n.text, n.attempts, j.number FROM notifications n JOIN jobs j ON j.id = n.job_id WHERE n.delivered_at IS NULL AND n.attempts < 5 ORDER BY n.id")
      .all() as any;
  }

  notificationAttempt(id: number, delivered: boolean) {
    this.db.query("UPDATE notifications SET attempts = attempts + 1, delivered_at = CASE WHEN ? THEN ? ELSE delivered_at END WHERE id = ?").run(delivered ? 1 : 0, Date.now(), id);
    if (delivered)
      this.db
        .query("UPDATE jobs SET told_state = (SELECT state FROM notifications WHERE id = ?1), last_update_at = ?2 WHERE id = (SELECT job_id FROM notifications WHERE id = ?1)")
        .run(id, Date.now());
  }

  recentInbound(channel: string, peer: string, sinceMs: number): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM messages WHERE channel = ? AND peer = ? AND direction = 'in' AND at > ?").get(channel, peer, Date.now() - sinceMs) as { n: number }).n;
  }

  trace(agent: string, key: string, kind: string, data: unknown) {
    this.db.query("INSERT INTO trace (agent, key, kind, data, at) VALUES (?, ?, ?, ?, ?)").run(agent, key, kind, JSON.stringify(data), Date.now());
  }

  traceFor(agent: string, key: string, sinceId = 0) {
    return (this.db.query("SELECT id, kind, data, at FROM trace WHERE agent = ? AND key = ? AND id > ? ORDER BY id LIMIT 2000").all(agent, key, sinceId) as any[]).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  traceKeys() {
    return this.db.query("SELECT agent, key, MAX(id) AS last_id, MAX(at) AS last_at, COUNT(*) AS n FROM trace GROUP BY agent, key ORDER BY last_at DESC").all() as any[];
  }

  logMessage(channel: string, peer: string, direction: "in" | "out", text: string) {
    this.db.query("INSERT INTO messages (channel, peer, direction, text, at) VALUES (?, ?, ?, ?, ?)").run(channel, peer, direction, text, Date.now());
  }
}
