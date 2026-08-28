import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";

const API = "/api";

/* ------------------------------------------------------------------ */
/* Types (mirrors src/types.ts + src/downloads/manager.ts)             */
/* ------------------------------------------------------------------ */

interface Provenance {
  module: string;
  seriesUrl?: string;
  chapterUrl?: string;
  group?: string;
  fetchedAt: string;
}

interface ChapterRec {
  uid: string;
  dir: string;
  number: number;
  pages: number;
  updatedAt?: string;
  provenance?: Provenance;
  history?: Provenance[];
}

interface SeriesMeta {
  uid: string;
  title?: string;
  sources?: string[];
  chapters: Record<string, ChapterRec>;
}

interface MangaMeta {
  title?: string;
  author?: string;
  artist?: string;
  description?: string;
  link?: string;
  sourceId?: string;
  tags?: string[];
  status?: string;
}

interface Manga {
  id: string;
  dir: string;
  title: string;
  coverUrl: string | null;
  chapterCount: number;
  meta: MangaMeta;
}

interface Chapter {
  id: string;
  dir: string;
  title: string;
  number: number;
  pageCount: number;
  provenance?: Provenance;
}

interface MangaDetail extends Manga {
  chapters: Chapter[];
  series: SeriesMeta;
}

interface TaskChapter {
  name: string;
  url: string;
  status: string;
  pagesTotal: number;
  pagesDownloaded: number;
  error?: string;
}

type TaskStatus = "queued" | "downloading" | "completed" | "failed" | "cancelled";

interface DownloadTask {
  id: string;
  mangaTitle: string;
  sourceId: string;
  sourceName: string;
  mangaUrl: string;
  status: TaskStatus;
  error?: string;
  chapters: TaskChapter[];
  createdAt: number;
  updatedAt: number;
}

interface ScriptInfo {
  id: string;
  name: string;
  category: string;
  rootUrl: string;
}

interface DlConfig {
  parallelPages: number;
  parallelChapters: number;
  retries: number;
  retryDelayMs: number;
}

interface ServerStatus {
  mangaDir: string;
  mangaCount: number;
  lastScan: number;
}

interface SourceInfoResult {
  manga: {
    title: string;
    coverLink: string;
    authors: string;
    artists: string;
    summary: string;
    status: string;
    genres: string;
    chapterNames: string[];
    chapterLinks: string[];
  };
  source: string;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any)?.error || `HTTP ${r.status}`);
  return d as T;
}

const post = (url: string, body?: unknown) =>
  j(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

function timeAgo(t?: number | string): string {
  if (!t) return "";
  const ms = typeof t === "string" ? Date.parse(t) : t;
  if (!ms || isNaN(ms)) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function chapNum(name: string): number {
  const m = name.match(/(\d+(?:\.\d+)?)/);
  return m?.[1] ? parseFloat(m[1]) : NaN;
}

const fmt = (n: number) => n.toLocaleString("en-US");

function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

/* localStorage, defensively — reading position lives only on this device
   (the server accepts and discards it), so never pretend it's synced. */
const store = {
  get<T>(k: string): T | null {
    try {
      const v = localStorage.getItem(k);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  },
  set(k: string, v: unknown) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  },
  del(k: string) {
    try { localStorage.removeItem(k); } catch {}
  },
};

interface Page {
  index: number;
  filename: string;
  url: string;
}

interface ReadTarget {
  mangaId: string;
  chapterId: string;
}

interface SavedPos {
  p: number;
  n: number;
  at: number;
}

interface ContinueRec extends SavedPos {
  mangaId: string;
  mangaTitle: string;
  chapterId: string;
  chapterTitle: string;
  number: number;
}

const posKey = (m: string, c: string) => `pb:pos:${m}/${c}`;

function pageSrc(mangaDir: string, chapterDir: string, file: string): string {
  return `${API}/images/${encodeURIComponent(mangaDir)}/${encodeURIComponent(chapterDir)}/${encodeURIComponent(file)}`;
}

function sortChapters(chapters: Chapter[]): Chapter[] {
  return [...chapters].sort((a, b) => {
    if (isNaN(a.number) || isNaN(b.number))
      return a.title.localeCompare(b.title, undefined, { numeric: true });
    return a.number - b.number;
  });
}

/* Failure classification — derived from the exact error strings the
   download manager produces. Each kind gets its own color + hint. */

type FailKind = "partial" | "refused" | "ratelimit" | "blockpage" | "empty" | "error";

interface Failure {
  kind: FailKind;
  label: string;
  hint: string;
}

function classifyError(err?: string): Failure | null {
  if (!err) return null;
  const m = err.match(/Downloaded (\d+)\/(\d+) pages/i);
  if (m) {
    const got = +m[1]!;
    const total = +m[2]!;
    if (got === 0)
      return { kind: "refused", label: `every page refused (0 of ${total})`, hint: "Rate-limit signature — clears on its own. Existing copy kept." };
    return { kind: "partial", label: `stopped at page ${got + 1} of ${total}`, hint: "Existing copy kept — nothing was replaced." };
  }
  if (/not an image/i.test(err))
    return { kind: "blockpage", label: "source served a block page", hint: "Slow down or change source — retrying harder won’t help. Existing copy kept." };
  if (/HTTP 429/.test(err))
    return { kind: "ratelimit", label: "rate-limited (HTTP 429)", hint: "Source throttling — clears on its own. Retry in a few minutes." };
  const h = err.match(/HTTP (403|503|420)/);
  if (h)
    return { kind: "ratelimit", label: `refused (HTTP ${h[1]})`, hint: "Throttled or blocked — wait a few minutes, then retry." };
  if (/no pages found/i.test(err))
    return { kind: "empty", label: "no pages found", hint: "The chapter URL may be dead. Check the source." };
  return { kind: "error", label: err, hint: "Nothing was written for failed pages." };
}

const COLD_KINDS: FailKind[] = ["refused", "ratelimit", "blockpage"];

/* ------------------------------------------------------------------ */
/* Small shared pieces                                                 */
/* ------------------------------------------------------------------ */

function Stamp({ status }: { status: TaskStatus }) {
  const label =
    status === "downloading" ? "fetching" : status === "completed" ? "complete" : status;
  return <span className={`stamp stamp-${status}`}>{label}</span>;
}

function Note({ kind, children }: { kind: "ok" | "bad" | "info"; children: ReactNode }) {
  return <div className={`note note-${kind}`}>{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Add series flow                                                     */
/* ------------------------------------------------------------------ */

/** A hand-off from the provenance ledger: re-pull these chapters of an
    existing series from whatever source URL gets pasted next. */
interface ResourceReq {
  dir: string;
  title: string;
  numbers: number[];
}

function AddSeries({
  sources,
  onQueued,
  resource,
  onClearResource,
}: {
  sources: ScriptInfo[];
  onQueued: () => void;
  resource: ResourceReq | null;
  onClearResource: () => void;
}) {
  const [url, setUrl] = useState("");
  const [srcId, setSrcId] = useState("");
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState<SourceInfoResult | null>(null);
  const [libMatch, setLibMatch] = useState<MangaDetail | null>(null);
  const [sel, setSel] = useState<boolean[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [queueing, setQueueing] = useState(false);

  const detect = (u: string) => {
    setUrl(u);
    setAuto(false);
    try {
      const host = hostOf(u);
      if (!host) return;
      const match = sources.find((s) => hostOf(s.rootUrl) === host);
      if (match) {
        setSrcId(match.id);
        setAuto(true);
      }
    } catch {}
  };

  const haveNums = useMemo(() => {
    const set = new Set<number>();
    if (libMatch) for (const c of libMatch.chapters) if (!isNaN(c.number)) set.add(c.number);
    return set;
  }, [libMatch]);

  const fetchInfo = async () => {
    if (!url) return;
    const id = srcId || sources[0]?.id;
    if (!id) return;
    setBusy(true);
    setErr("");
    setInfo(null);
    setLibMatch(null);
    try {
      const data = await j<SourceInfoResult>(
        `${API}/scripts/${id}/info?url=${encodeURIComponent(url)}`
      );
      setInfo(data);
      // Cross-reference the library so already-downloaded chapters are visible.
      let lib: MangaDetail | null = null;
      try {
        lib = await j<MangaDetail>(`${API}/manga/${slugify(data.manga.title)}`);
      } catch {}
      setLibMatch(lib);
      const have = new Set<number>();
      if (lib) for (const c of lib.chapters) if (!isNaN(c.number)) have.add(c.number);
      if (resource) {
        const wanted = new Set(resource.numbers);
        setSel(data.manga.chapterNames.map((n) => wanted.has(chapNum(n))));
      } else {
        setSel(
          data.manga.chapterNames.map((n) => {
            const num = chapNum(n);
            return !(lib && !isNaN(num) && have.has(num));
          })
        );
      }
    } catch (e: any) {
      setErr(e?.message || "Could not read that page");
    }
    setBusy(false);
  };

  const selectedCount = sel.filter(Boolean).length;
  const onDiskCount = info
    ? info.manga.chapterNames.filter((n) => {
        const num = chapNum(n);
        return !isNaN(num) && haveNums.has(num);
      }).length
    : 0;

  const setAll = (v: boolean) => setSel(sel.map(() => v));
  const setMissing = () =>
    setSel(
      info!.manga.chapterNames.map((n) => {
        const num = chapNum(n);
        return !(!isNaN(num) && haveNums.has(num));
      })
    );

  const queue = async () => {
    if (!info || selectedCount === 0) return;
    setQueueing(true);
    setErr("");
    try {
      const picked = info.manga.chapterNames
        .map((name, i) => ({ name, url: info.manga.chapterLinks[i] || "", i }))
        .filter((c) => sel[c.i]);
      // Download oldest-first regardless of the order the source lists them.
      picked.sort((a, b) => {
        const na = chapNum(a.name);
        const nb = chapNum(b.name);
        if (isNaN(na) || isNaN(nb)) return a.i - b.i;
        return na - nb;
      });
      await post(`${API}/downloads`, {
        // Use the on-disk directory name when the series already exists, so a
        // re-pull from a differently-titled source lands in the same folder.
        mangaTitle: resource ? resource.dir : libMatch ? libMatch.dir : info.manga.title,
        sourceId: srcId || sources[0]?.id,
        mangaUrl: url,
        chapters: picked.map(({ name, url }) => ({ name, url })),
      });
      setInfo(null);
      setUrl("");
      setSel([]);
      if (resource) onClearResource();
      onQueued();
    } catch (e: any) {
      setErr(e?.message || "Could not queue the download");
    }
    setQueueing(false);
  };

  const srcName = sources.find((s) => s.id === srcId)?.name;

  return (
    <section className="add">
      <div className="add-head">
        <h3>{resource ? "Re-source chapters" : "Add series"}</h3>
        <p className="cap">
          {resource
            ? "Paste a replacement source’s URL for this series."
            : "Paste a series URL from a supported source."}
        </p>
      </div>
      {resource && (
        <div className="resource-note">
          <span>
            Re-pulling <b>{fmt(resource.numbers.length)}</b> chapters of “{resource.title}” — the
            old source stays in each chapter’s history.
          </span>
          <button className="btn btn-mini btn-quiet" onClick={onClearResource}>
            Cancel
          </button>
        </div>
      )}
      <div className="add-row">
        <input
          className="input add-url"
          type="url"
          placeholder="https://weebcentral.com/series/…"
          value={url}
          onChange={(e) => detect(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && fetchInfo()}
        />
        <select
          className="input add-src"
          value={srcId}
          onChange={(e) => {
            setSrcId(e.target.value);
            setAuto(false);
          }}
          aria-label="Source"
        >
          <option value="">source…</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" onClick={fetchInfo} disabled={busy || !url || (!srcId && !sources.length)}>
          {busy ? "Reading…" : "Fetch chapters"}
        </button>
      </div>
      {auto && srcName && <p className="cap cap-ok">source detected: {srcName}</p>}
      {url && !srcId && !auto && (
        <p className="cap cap-warn">No source matches this URL — pick one, or update scripts below.</p>
      )}
      {err && <Note kind="bad">{err}</Note>}

      {info && (
        <div className="preview">
          <div className="preview-top">
            <div>
              <h4 className="preview-title">{info.manga.title}</h4>
              <p className="preview-by">
                {[info.manga.authors, info.manga.artists !== info.manga.authors ? info.manga.artists : ""]
                  .filter(Boolean)
                  .join(" · ")}
                {info.manga.status ? ` · ${info.manga.status}` : ""}
              </p>
            </div>
            <button className="btn btn-ghost" onClick={() => setInfo(null)}>
              Discard
            </button>
          </div>
          {info.manga.summary && <p className="preview-sum">{info.manga.summary}</p>}

          <div className="picker">
            <div className="picker-bar">
              <span className="picker-stat">
                <b>{fmt(info.manga.chapterNames.length)}</b> chapters
                {libMatch && (
                  <>
                    {" · "}
                    <b>{fmt(onDiskCount)}</b> on disk
                  </>
                )}
                {" · "}
                <b>{fmt(selectedCount)}</b> selected
              </span>
              <span className="picker-btns">
                <button className="btn btn-mini" onClick={() => setAll(true)}>All</button>
                <button className="btn btn-mini" onClick={() => setAll(false)}>None</button>
                {libMatch && (
                  <button className="btn btn-mini" onClick={setMissing}>Missing</button>
                )}
                <button className="btn btn-mini" onClick={() => setListOpen(!listOpen)}>
                  {listOpen ? "Hide list" : "Choose"}
                </button>
              </span>
            </div>
            {libMatch && onDiskCount > 0 && (
              <p className="cap">{fmt(onDiskCount)} already on disk — missing ones preselected.</p>
            )}
            {listOpen && (
              <div className="picker-list">
                {info.manga.chapterNames.map((name, i) => {
                  const num = chapNum(name);
                  const have = !isNaN(num) && haveNums.has(num);
                  return (
                    <label key={i} className={`picker-item${have ? " have" : ""}`}>
                      <input
                        type="checkbox"
                        checked={!!sel[i]}
                        onChange={() => {
                          const next = sel.slice();
                          next[i] = !next[i];
                          setSel(next);
                        }}
                      />
                      <span className="picker-name">{name}</span>
                      {have && <span className="picker-have">on disk</span>}
                    </label>
                  );
                })}
              </div>
            )}
            <div className="picker-go">
              <button className="btn btn-primary" onClick={queue} disabled={queueing || selectedCount === 0}>
                {queueing ? "Queueing…" : `Queue ${fmt(selectedCount)} chapter${selectedCount === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Transfer settings                                                   */
/* ------------------------------------------------------------------ */

const DELAY_OPTS = [500, 1000, 2000, 5000, 10000, 30000];
const delayLabel = (ms: number) => (ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`);

function Tuning({
  config,
  onChange,
}: {
  config: DlConfig;
  onChange: (p: Partial<DlConfig>) => void;
}) {
  const [open, setOpen] = useState(false);
  const risky = config.parallelChapters > 1;
  return (
    <section className={`tune${risky ? " tune-risky" : ""}`}>
      <button className="tune-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tune-title">Transfer settings</span>
        <span className="tune-sum">
          {config.parallelChapters} chapter{config.parallelChapters > 1 ? "s" : ""} at once ·{" "}
          {config.parallelPages} pages · {config.retries} retries · {delayLabel(config.retryDelayMs)} delay
        </span>
        {risky && <span className="tune-flag">rate-limit risk</span>}
        <span className="tune-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="tune-body">
          <p className="cap">Faster settings work until the source blocks you.</p>
          <div className="tune-grid">
            <label className="tune-field">
              <span>Chapters at once</span>
              <select
                className="input"
                value={config.parallelChapters}
                onChange={(e) => onChange({ parallelChapters: +e.target.value })}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}{n === 1 ? " — reliable" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="tune-field">
              <span>Pages at once</span>
              <select
                className="input"
                value={config.parallelPages}
                onChange={(e) => onChange({ parallelPages: +e.target.value })}
              >
                {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="tune-field">
              <span>Retries per page</span>
              <select
                className="input"
                value={config.retries}
                onChange={(e) => onChange({ retries: +e.target.value })}
              >
                {[0, 1, 2, 3, 5, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="tune-field">
              <span>Retry delay</span>
              <select
                className="input"
                value={config.retryDelayMs}
                onChange={(e) => onChange({ retryDelayMs: +e.target.value })}
              >
                {DELAY_OPTS.map((ms) => (
                  <option key={ms} value={ms}>{delayLabel(ms)}</option>
                ))}
              </select>
              <span className="cap">doubles each attempt</span>
            </label>
          </div>
          {risky && (
            <Note kind="bad">
              Parallel chapters trigger rate limits — refusals cascade. 1 is reliable.
            </Note>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Task card                                                           */
/* ------------------------------------------------------------------ */

interface ChapterView {
  ch: TaskChapter;
  idx: number;
  fail: Failure | null;
}

function taskStats(task: DownloadTask) {
  const views: ChapterView[] = task.chapters.map((ch, idx) => ({
    ch,
    idx,
    fail: ch.status === "failed" ? classifyError(ch.error) : null,
  }));
  let done = 0, partial = 0, cold = 0, badOther = 0, active = 0, queued = 0, cancelled = 0;
  let pagesDone = 0, pagesTotal = 0;
  let run = 0, maxRun = 0;
  for (const v of views) {
    pagesDone += v.ch.pagesDownloaded;
    pagesTotal += v.ch.pagesTotal;
    switch (v.ch.status) {
      case "completed": done++; break;
      case "downloading": active++; break;
      case "queued": queued++; break;
      case "cancelled": cancelled++; break;
      case "failed":
        if (v.fail && v.fail.kind === "partial") partial++;
        else if (v.fail && COLD_KINDS.includes(v.fail.kind)) cold++;
        else badOther++;
        break;
    }
    // Longest consecutive run of refusals — the rate-limit signature.
    if (v.ch.status === "failed" && v.fail && COLD_KINDS.includes(v.fail.kind)) {
      run++;
      if (run > maxRun) maxRun = run;
    } else if (v.ch.status !== "queued") {
      run = 0;
    }
  }
  const failed = partial + cold + badOther;
  return { views, done, partial, cold, badOther, failed, active, queued, cancelled, pagesDone, pagesTotal, maxRun };
}

function cellClass(v: ChapterView): string {
  switch (v.ch.status) {
    case "completed": return "c-ok";
    case "downloading": return "c-run";
    case "queued": return "c-q";
    case "cancelled": return "c-x";
    case "failed":
      if (v.fail?.kind === "partial") return "c-warn";
      if (v.fail && COLD_KINDS.includes(v.fail.kind)) return "c-cold";
      return "c-bad";
    default: return "c-q";
  }
}

function TaskCard({
  task,
  refresh,
  onSequentialRetry,
}: {
  task: DownloadTask;
  refresh: () => void;
  onSequentialRetry: (id: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [logMode, setLogMode] = useState<"auto" | "problems" | "all" | "hidden">("auto");
  const [busy, setBusy] = useState(false);

  const s = useMemo(() => taskStats(task), [task]);
  const running = task.status === "downloading" || task.status === "queued";
  const terminal = !running;
  const rateLimited = s.maxRun >= 3;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch {}
    setBusy(false);
    refresh();
  };

  const problems = s.views.filter((v) => v.ch.status === "failed" || v.ch.status === "downloading");
  const AUTO_CAP = 8;
  const logRows =
    logMode === "all" ? s.views
    : logMode === "hidden" ? []
    : logMode === "problems" ? problems
    : problems.slice(0, AUTO_CAP);
  const logMore = logMode === "auto" ? problems.length - logRows.length : 0;
  const sel = selected !== null ? s.views[selected] : null;

  return (
    <article className={`task task-${task.status}`}>
      <header className="task-head">
        <div className="task-id">
          <h4 className="task-title">{task.mangaTitle}</h4>
          <span className="task-meta">
            {task.sourceName} · {timeAgo(task.updatedAt)}
          </span>
        </div>
        <div className="task-side">
          <Stamp status={task.status} />
          <span className="task-btns">
            {running && (
              <button className="btn btn-mini" disabled={busy} onClick={() => act(() => post(`${API}/downloads/${task.id}/cancel`))}>
                Cancel
              </button>
            )}
            {task.status === "failed" && (
              <button className="btn btn-mini" disabled={busy} onClick={() => act(() => post(`${API}/downloads/${task.id}/retry`))}>
                Retry {fmt(s.failed)}
              </button>
            )}
            {terminal && (
              <button className="btn btn-mini btn-quiet" disabled={busy} onClick={() => act(() => j(`${API}/downloads/${task.id}`, { method: "DELETE" }))}>
                Clear
              </button>
            )}
          </span>
        </div>
      </header>

      <div className="task-line">
        <span className="task-count">
          {fmt(s.done)}<span className="dim">/{fmt(task.chapters.length)} chapters</span>
        </span>
        {s.pagesTotal > 0 && (
          <span className="task-count dim">
            {fmt(s.pagesDone)}/{fmt(s.pagesTotal)} pages
          </span>
        )}
        <span className="task-chips">
          {s.partial > 0 && <span className="chip chip-warn">{s.partial} partial</span>}
          {s.cold > 0 && <span className="chip chip-cold">{s.cold} refused</span>}
          {s.badOther > 0 && <span className="chip chip-bad">{s.badOther} failed</span>}
          {s.cancelled > 0 && <span className="chip chip-x">{s.cancelled} cancelled</span>}
        </span>
      </div>

      {task.chapters.length > 1 && (
        <div className="strip" role="img" aria-label={`${task.chapters.length} chapters: ${s.done} done, ${s.failed} failed`}>
          {s.views.map((v) => (
            <button
              key={v.idx}
              className={`cell ${cellClass(v)}${selected === v.idx ? " cell-sel" : ""}`}
              title={`${v.ch.name} — ${v.fail ? v.fail.label : v.ch.status}`}
              onClick={() => setSelected(selected === v.idx ? null : v.idx)}
            />
          ))}
        </div>
      )}

      {sel && (
        <div className="cell-detail">
          <span className="cell-detail-name">{sel.ch.name}</span>
          <span className="cell-detail-state">
            {sel.fail
              ? sel.fail.label
              : sel.ch.status === "downloading"
                ? `page ${sel.ch.pagesDownloaded + 1} of ${sel.ch.pagesTotal || "?"}`
                : sel.ch.status === "completed"
                  ? `${fmt(sel.ch.pagesTotal)} pages`
                  : sel.ch.status}
          </span>
          {sel.fail && <span className="cell-detail-hint">{sel.fail.hint}</span>}
        </div>
      )}

      {rateLimited && (task.status === "failed" || task.status === "downloading") && (
        <div className="advisory">
          <p>
            <b>{s.maxRun} refusals in a row</b> — the rate-limit signature. It clears on its own;
            nothing was written, existing copies kept.
          </p>
          {task.status === "failed" ? (
            <div className="advisory-act">
              <button className="btn btn-cold" disabled={busy} onClick={() => act(() => onSequentialRetry(task.id))}>
                Retry sequentially
              </button>
              <span className="cap">sets chapters at once to 1, then retries</span>
            </div>
          ) : (
            <span className="cap">Still running — if refusals continue, cancel and retry sequentially.</span>
          )}
        </div>
      )}

      {task.error && <Note kind="bad">{task.error}</Note>}

      {(problems.length > 0 || logMode === "all") && (
        <div className="log">
          <div className="log-bar">
            <span className="cap">
              {logMode === "all" ? "all chapters" : `${problems.length} needing attention`}
            </span>
            <span>
              <button className="btn btn-mini btn-quiet" onClick={() => setLogMode(logMode === "all" ? "auto" : "all")}>
                {logMode === "all" ? "Problems only" : "Show all"}
              </button>
              {logMode !== "hidden" && (
                <button className="btn btn-mini btn-quiet" onClick={() => setLogMode("hidden")}>
                  Hide
                </button>
              )}
              {logMode === "hidden" && (
                <button className="btn btn-mini btn-quiet" onClick={() => setLogMode("auto")}>
                  Show
                </button>
              )}
            </span>
          </div>
          {logRows.map((v) => (
            <div key={v.idx} className={`log-row lr-${cellClass(v)}`}>
              <span className="log-name">{v.ch.name}</span>
              <span className="log-pages">
                {v.ch.pagesTotal > 0 ? `${v.ch.pagesDownloaded}/${v.ch.pagesTotal}` : "—"}
              </span>
              <span className="log-state">
                {v.fail
                  ? v.fail.label
                  : v.ch.status === "downloading"
                    ? `fetching ${v.ch.pagesDownloaded}/${v.ch.pagesTotal || "?"}`
                    : v.ch.status}
              </span>
            </div>
          ))}
          {logMore > 0 && (
            <button className="btn btn-mini btn-quiet log-more" onClick={() => setLogMode("problems")}>
              and {fmt(logMore)} more
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Sources panel                                                       */
/* ------------------------------------------------------------------ */

function SourcesPanel({
  sources,
  onPulled,
}: {
  sources: ScriptInfo[];
  onPulled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [pulling, setPulling] = useState(false);

  const pull = async () => {
    setPulling(true);
    try { await post(`${API}/scripts/pull`); } catch {}
    setPulling(false);
    onPulled();
  };

  const shown = filter
    ? sources.filter(
        (s) =>
          s.name.toLowerCase().includes(filter.toLowerCase()) ||
          hostOf(s.rootUrl).includes(filter.toLowerCase())
      )
    : sources;

  return (
    <section className="srcs">
      <div className="srcs-head">
        <h3>
          Sources <span className="dim">{fmt(sources.length)}</span>
        </h3>
        <p className="cap">Site adapters — one per supported site.</p>
        <span className="srcs-btns">
          <button className="btn btn-mini" onClick={pull} disabled={pulling}>
            {pulling ? "Updating…" : "Update scripts"}
          </button>
          <button className="btn btn-mini btn-quiet" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Browse"}
          </button>
        </span>
      </div>
      {open && (
        <div className="srcs-body">
          <input
            className="input"
            placeholder="Filter sources…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="srcs-list">
            {shown.map((s) => (
              <div key={s.id} className="srcs-row">
                <span className="srcs-name">{s.name}</span>
                <span className="srcs-host">{hostOf(s.rootUrl)}</span>
                <span className="srcs-cat">{s.category}</span>
              </div>
            ))}
            {shown.length === 0 && <p className="cap">No source matches.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Queue view                                                          */
/* ------------------------------------------------------------------ */

function QueueView({
  tasks,
  refreshTasks,
  resource,
  onClearResource,
}: {
  tasks: DownloadTask[];
  refreshTasks: () => void;
  resource: ResourceReq | null;
  onClearResource: () => void;
}) {
  const [sources, setSources] = useState<ScriptInfo[] | null>(null);
  const [config, setConfig] = useState<DlConfig | null>(null);

  const loadSources = useCallback(() => {
    j<{ data: ScriptInfo[] }>(`${API}/scripts`)
      .then((d) => setSources(d.data || []))
      .catch(() => setSources([]));
  }, []);

  useEffect(() => {
    loadSources();
    j<DlConfig>(`${API}/downloads/config`).then(setConfig).catch(() => {});
  }, [loadSources]);

  const updateConfig = async (p: Partial<DlConfig>) => {
    try {
      const next = await j<DlConfig>(`${API}/downloads/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      setConfig(next);
    } catch {}
  };

  const sequentialRetry = async (id: string) => {
    await updateConfig({ parallelChapters: 1 });
    await post(`${API}/downloads/${id}/retry`);
  };

  const firstRun = sources !== null && sources.length === 0;

  return (
    <div className="wrap">
      <div className="view-head">
        <h2>Queue</h2>
        <p className="cap">Chapters being fetched to disk.</p>
      </div>

      {firstRun ? (
        <div className="firstrun">
          <h3>No sources installed</h3>
          <p className="cap">Sources are site adapters (FMD2 Lua scripts). Pull them once.</p>
          <ol className="firstrun-steps">
            <li>
              Pull the source scripts
              <SourcesInlinePull onPulled={loadSources} />
            </li>
            <li>Paste a series URL from a supported site</li>
            <li>Queue chapters — they land in the library, on disk</li>
          </ol>
        </div>
      ) : (
        <>
          <AddSeries
            sources={sources || []}
            onQueued={refreshTasks}
            resource={resource}
            onClearResource={onClearResource}
          />
          {config && <Tuning config={config} onChange={updateConfig} />}

          <section className="tasks">
            {tasks.length === 0 ? (
              <div className="empty">
                <p className="empty-main">Nothing in the queue.</p>
                <p className="cap">
                  Search the web for a series, copy its URL from a supported site, paste it above.
                </p>
                <p className="cap">Downloads land in the library; your phone reads from there.</p>
              </div>
            ) : (
              tasks.map((t) => (
                <TaskCard key={t.id} task={t} refresh={refreshTasks} onSequentialRetry={sequentialRetry} />
              ))
            )}
          </section>

          {sources && <SourcesPanel sources={sources} onPulled={loadSources} />}
        </>
      )}
    </div>
  );
}

function SourcesInlinePull({ onPulled }: { onPulled: () => void }) {
  const [pulling, setPulling] = useState(false);
  return (
    <button
      className="btn btn-primary firstrun-pull"
      disabled={pulling}
      onClick={async () => {
        setPulling(true);
        try { await post(`${API}/scripts/pull`); } catch {}
        setPulling(false);
        onPulled();
      }}
    >
      {pulling ? "Pulling…" : "Pull scripts"}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Library view                                                        */
/* ------------------------------------------------------------------ */

function LibraryView({
  onSelect,
  onGoQueue,
  onRead,
  readEpoch,
}: {
  onSelect: (id: string) => void;
  onGoQueue: () => void;
  onRead: (t: ReadTarget) => void;
  readEpoch: number;
}) {
  const [cont, setCont] = useState<ContinueRec | null>(() => store.get<ContinueRec>("pb:continue"));
  useEffect(() => {
    setCont(store.get<ContinueRec>("pb:continue"));
  }, [readEpoch]);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [items, setItems] = useState<Manga[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(
    async (p: number, append: boolean) => {
      setLoading(true);
      try {
        const q = debounced ? `&search=${encodeURIComponent(debounced)}` : "";
        const d = await j<{ data: Manga[]; total: number }>(`${API}/manga?limit=100&page=${p}${q}`);
        setItems((prev) => (append ? [...prev, ...d.data] : d.data));
        setTotal(d.total);
        setPage(p);
      } catch {}
      setLoading(false);
    },
    [debounced]
  );

  useEffect(() => {
    load(1, false);
  }, [load]);

  const rescan = async () => {
    setScanning(true);
    try { await post(`${API}/scan`); } catch {}
    setScanning(false);
    load(1, false);
  };

  return (
    <div className="wrap">
      <div className="view-head">
        <h2>Library</h2>
        <p className="cap">On disk — the phone app reads from here.</p>
      </div>
      {cont && (
        <div className="continue">
          <button
            className="continue-go"
            onClick={() => onRead({ mangaId: cont.mangaId, chapterId: cont.chapterId })}
          >
            <span className="continue-tag">Continue</span>
            <span className="continue-title">{cont.mangaTitle}</span>
            <span className="continue-sub">
              {cont.chapterTitle} · p {cont.p + 1}/{cont.n} · {timeAgo(cont.at)}
            </span>
          </button>
          <button
            className="btn btn-mini btn-quiet"
            aria-label="Dismiss continue reading"
            onClick={() => { store.del("pb:continue"); setCont(null); }}
          >
            ✕
          </button>
        </div>
      )}
      <div className="lib-bar">
        <input
          className="input lib-search"
          placeholder="Filter series…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn" onClick={rescan} disabled={scanning}>
          {scanning ? "Scanning…" : "Rescan disk"}
        </button>
      </div>

      {loading && items.length === 0 ? (
        <div className="empty"><p className="cap">Reading the shelf…</p></div>
      ) : items.length === 0 ? (
        <div className="empty">
          {debounced ? (
            <p className="empty-main">No series matches “{debounced}”.</p>
          ) : (
            <>
              <p className="empty-main">Nothing on disk yet.</p>
              <p className="cap">Queue a download first — finished chapters appear here.</p>
              <button className="btn btn-primary" onClick={onGoQueue}>Go to queue</button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="grid">
            {items.map((m) => (
              <button key={m.id} className="card" onClick={() => onSelect(m.id)}>
                {m.coverUrl ? (
                  <img className="card-img" src={m.coverUrl} alt="" loading="lazy" />
                ) : (
                  <span className="card-img card-noimg" aria-hidden>▪</span>
                )}
                <span className="card-body">
                  <span className="card-title">{m.title}</span>
                  <span className="card-sub">
                    {fmt(m.chapterCount)} ch
                    {m.meta.status ? ` · ${m.meta.status.toLowerCase()}` : ""}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="lib-foot">
            <span className="cap">{fmt(total)} series</span>
            {items.length < total && (
              <button className="btn btn-mini" onClick={() => load(page + 1, true)} disabled={loading}>
                Load more
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Detail view — provenance ledger                                     */
/* ------------------------------------------------------------------ */

const SRC_HUES = ["s0", "s1", "s2", "s3", "s4", "s5"];

function DetailView({
  id,
  onBack,
  onQueued,
  onResource,
  onRead,
}: {
  id: string;
  onBack: () => void;
  onQueued: () => void;
  onResource: (req: ResourceReq) => void;
  onRead: (chapterId: string) => void;
}) {
  const [manga, setManga] = useState<MangaDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  const [filter, setFilter] = useState<string | null>(null); // module id | "unrecorded" | "resourced"
  const [expanded, setExpanded] = useState<string | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  const [repull, setRepull] = useState<{ dir: string; arm: boolean } | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    j<MangaDetail>(`${API}/manga/${id}`)
      .then((d) => { setManga(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
    j<{ data: ScriptInfo[] }>(`${API}/scripts`).then((d) => setScripts(d.data || [])).catch(() => {});
  }, [load]);

  const modName = useCallback(
    (mod: string) => scripts.find((s) => s.id === mod)?.name || mod.replace(/^mod-/, ""),
    [scripts]
  );

  const derived = useMemo(() => {
    if (!manga) return null;
    const recOf = (ch: Chapter) => manga.series.chapters?.[ch.dir];
    const provOf = (ch: Chapter) => recOf(ch)?.provenance;

    const moduleOrder: string[] = [];
    const counts = new Map<string, number>();
    let unrecorded = 0;
    let resourced = 0;
    for (const ch of manga.chapters) {
      const p = provOf(ch);
      if (p?.module) {
        if (!counts.has(p.module)) moduleOrder.push(p.module);
        counts.set(p.module, (counts.get(p.module) || 0) + 1);
      } else unrecorded++;
      if ((recOf(ch)?.history?.length || 0) > 0) resourced++;
    }

    // Page-count medians per module: sources differ wildly (8 stitched strips
    // vs 70 pages is normal), so anomalies only mean anything within a source.
    const medians = new Map<string, number>();
    for (const mod of moduleOrder) {
      const pages = manga.chapters
        .filter((c) => provOf(c)?.module === mod && c.pageCount > 0)
        .map((c) => c.pageCount)
        .sort((a, b) => a - b);
      if (pages.length >= 5) medians.set(mod, pages[Math.floor(pages.length / 2)]!);
    }
    const isOdd = (ch: Chapter) => {
      const mod = provOf(ch)?.module;
      const med = mod ? medians.get(mod) : undefined;
      if (!med || ch.pageCount === 0) return false;
      return ch.pageCount < med * 0.35 || ch.pageCount > med * 2.8;
    };

    const hueOf = new Map<string, string>();
    moduleOrder.forEach((m, i) => hueOf.set(m, SRC_HUES[i % SRC_HUES.length]!));

    return { recOf, provOf, moduleOrder, counts, unrecorded, resourced, medians, isOdd, hueOf };
  }, [manga]);

  if (loading) return <div className="wrap"><div className="empty"><p className="cap">Opening…</p></div></div>;
  if (!manga || !derived) return <div className="wrap"><div className="empty"><p className="empty-main">Series not found.</p></div></div>;

  const { recOf, provOf, moduleOrder, counts, unrecorded, resourced, isOdd, hueOf, medians } = derived;

  const shown = manga.chapters.filter((ch) => {
    if (!filter) return true;
    if (filter === "unrecorded") return !provOf(ch)?.module;
    if (filter === "resourced") return (recOf(ch)?.history?.length || 0) > 0;
    return provOf(ch)?.module === filter;
  });

  const ordered = sortChapters(manga.chapters);
  const firstCh = ordered[0];
  const last = store.get<ContinueRec>(`pb:last:${manga.id}`);
  const lastCh = last ? manga.chapters.find((c) => c.id === last.chapterId) : undefined;

  const doRepull = async (ch: Chapter) => {
    const p = provOf(ch);
    if (!p?.chapterUrl || !p.module) return;
    try {
      await post(`${API}/downloads`, {
        mangaTitle: manga.dir,
        sourceId: p.module,
        mangaUrl: p.seriesUrl || manga.meta.link || "",
        chapters: [{ name: ch.dir, url: p.chapterUrl }],
      });
      setMsg({ kind: "ok", text: `${ch.title} queued for re-pull — see the Queue tab.` });
      setRepull(null);
      onQueued();
    } catch (e: any) {
      setMsg({ kind: "bad", text: e?.message || "Could not queue the re-pull" });
    }
  };

  const desc = manga.meta.description || "";

  return (
    <div className="wrap">
      <button className="back" onClick={onBack}>← Library</button>

      <div className="detail">
        <div className="detail-side">
          {manga.coverUrl ? (
            <img className="detail-cover" src={manga.coverUrl} alt="" />
          ) : (
            <div className="detail-cover card-noimg">▪</div>
          )}
          {manga.meta.link && (
            <a className="detail-link" href={manga.meta.link} target="_blank" rel="noopener noreferrer">
              {hostOf(manga.meta.link)} ↗
            </a>
          )}
        </div>

        <div className="detail-main">
          <h2 className="detail-title">{manga.title}</h2>
          <p className="detail-by">
            {[manga.meta.author, manga.meta.artist !== manga.meta.author ? manga.meta.artist : ""]
              .filter(Boolean)
              .join(" · ")}
            {manga.meta.status ? ` · ${manga.meta.status.toLowerCase()}` : ""}
            {` · ${fmt(manga.chapters.length)} chapters`}
          </p>
          {manga.meta.tags && manga.meta.tags.length > 0 && (
            <p className="detail-tags">{manga.meta.tags.join(" / ")}</p>
          )}
          {desc && (
            <p className={`detail-desc${descOpen ? " open" : ""}`} onClick={() => setDescOpen(!descOpen)}>
              {desc}
            </p>
          )}

          {firstCh && (
            <div className="readbar">
              {lastCh ? (
                <>
                  <button className="btn btn-primary" onClick={() => onRead(lastCh.id)}>
                    Continue — {lastCh.title}
                    {last && last.p > 0 ? ` · p ${last.p + 1}` : ""}
                  </button>
                  {firstCh.id !== lastCh.id && (
                    <button className="btn" onClick={() => onRead(firstCh.id)}>From the start</button>
                  )}
                  <span className="cap">position kept on this device only</span>
                </>
              ) : (
                <button className="btn btn-primary" onClick={() => onRead(firstCh.id)}>
                  Read — {firstCh.title}
                </button>
              )}
            </div>
          )}

          {msg && <Note kind={msg.kind}>{msg.text}</Note>}

          <section className="ledger-sec">
            <div className="ledger-head">
              <h3>Chapters &amp; provenance</h3>
              <p className="cap">Tap a chapter to read; tap its source for history.</p>
            </div>
            <div className="ledger-chips">
              {moduleOrder.map((mod) => (
                <button
                  key={mod}
                  className={`srcchip ${hueOf.get(mod)}${filter === mod ? " on" : ""}`}
                  onClick={() => setFilter(filter === mod ? null : mod)}
                >
                  <i />{modName(mod)} <b>{counts.get(mod)}</b>
                </button>
              ))}
              {unrecorded > 0 && (
                <button
                  className={`srcchip sx${filter === "unrecorded" ? " on" : ""}`}
                  onClick={() => setFilter(filter === "unrecorded" ? null : "unrecorded")}
                >
                  <i />unrecorded <b>{unrecorded}</b>
                </button>
              )}
              {resourced > 0 && (
                <button
                  className={`srcchip sh${filter === "resourced" ? " on" : ""}`}
                  onClick={() => setFilter(filter === "resourced" ? null : "resourced")}
                >
                  ↺ re-sourced <b>{resourced}</b>
                </button>
              )}
            </div>
            {filter && (
              <div className="ledger-filterbar">
                <p className="cap">
                  Showing {fmt(shown.length)} of {fmt(manga.chapters.length)} chapters.{" "}
                  <button className="linklike" onClick={() => setFilter(null)}>Clear filter</button>
                </p>
                {filter !== "resourced" && shown.length > 0 && (
                  <button
                    className="btn btn-mini"
                    onClick={() =>
                      onResource({
                        dir: manga.dir,
                        title: manga.title,
                        numbers: shown.map((c) => c.number).filter((n) => !isNaN(n)),
                      })
                    }
                  >
                    Re-source these {fmt(shown.length)} from another site
                  </button>
                )}
              </div>
            )}

            <div className="ledger">
              {shown.map((ch) => {
                const p = provOf(ch);
                const rec = recOf(ch);
                const hist = rec?.history || [];
                const odd = isOdd(ch);
                const open = expanded === ch.dir;
                const med = p?.module ? medians.get(p.module) : undefined;
                return (
                  <div key={ch.id} className={`led-row${open ? " open" : ""}`}>
                    <div className="led-line">
                      <button className="led-read" onClick={() => onRead(ch.id)} title={`Read ${ch.title}`}>
                        <span className="led-num">{isNaN(ch.number) ? "·" : ch.number}</span>
                        <span className="led-name">{ch.title}</span>
                        <span className={`led-pages${odd ? " odd" : ""}`} title={odd && med ? `Unusual page count for this source (median ${med})` : undefined}>
                          {fmt(ch.pageCount)}p{odd ? " ⚑" : ""}
                        </span>
                      </button>
                      <button
                        className="led-prov"
                        onClick={() => setExpanded(open ? null : ch.dir)}
                        aria-expanded={open}
                        title="Source history"
                      >
                        {p?.module ? (
                          <span className={`led-src ${hueOf.get(p.module) || "sx"}`}>
                            <i />{modName(p.module)}
                          </span>
                        ) : (
                          <span className="led-src sx"><i />unrecorded</span>
                        )}
                        <span className="led-when">{p ? timeAgo(p.fetchedAt) : ""}</span>
                        <span className="led-hist">{hist.length > 0 ? `↺${hist.length}` : ""}</span>
                        <span className="led-caret">{open ? "▴" : "▾"}</span>
                      </button>
                    </div>
                    {open && (
                      <div className="led-more">
                        {(() => {
                          // The chapter's source timeline: history (oldest
                          // first), then the current record. Order is the data.
                          const entries: Provenance[] = [...hist, ...(p ? [p] : [])];
                          if (entries.length === 0)
                            return <p className="cap">Downloaded before provenance tracking, or added by hand.</p>;
                          return (
                            <div className="tl">
                              {entries.map((e, i) => {
                                const current = !!p && i === entries.length - 1;
                                return (
                                  <div key={i} className={`tl-item${current ? " tl-cur" : ""}`}>
                                    <span className="tl-rail" aria-hidden><i /></span>
                                    <div className="tl-body">
                                      <span className={`tl-mod ${hueOf.get(e.module) || "sx"}`}>
                                        <i />{modName(e.module)}
                                      </span>
                                      <span className="tl-when">
                                        {e.fetchedAt
                                          ? new Date(e.fetchedAt).toLocaleDateString(undefined, {
                                              year: "numeric", month: "short", day: "numeric",
                                            })
                                          : "date unknown"}
                                      </span>
                                      <span className={`tl-tag${current ? "" : " tl-old"}`}>
                                        {current ? "current" : "superseded"}
                                      </span>
                                      {e.group && <span className="tl-group">{e.group}</span>}
                                      {e.chapterUrl && (
                                        <a className="tl-url" href={e.chapterUrl} target="_blank" rel="noopener noreferrer">
                                          {hostOf(e.chapterUrl)} ↗
                                        </a>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                        {p?.chapterUrl && (
                          <div className="led-actions">
                            {repull?.dir === ch.dir && repull.arm ? (
                              <>
                                <button className="btn btn-mini btn-danger" onClick={() => doRepull(ch)}>
                                  Confirm — replaces pages
                                </button>
                                <button className="btn btn-mini btn-quiet" onClick={() => setRepull(null)}>
                                  Keep
                                </button>
                              </>
                            ) : (
                              <button
                                className="btn btn-mini"
                                disabled={!scripts.some((sc) => sc.id === p.module)}
                                title={scripts.some((sc) => sc.id === p.module) ? undefined : "Source script not installed"}
                                onClick={() => setRepull({ dir: ch.dir, arm: true })}
                              >
                                Re-pull from {modName(p.module)}
                              </button>
                            )}
                            <span className="cap">Fetches this chapter again from its recorded source.</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <ManageSource manga={manga} scripts={scripts} onSaved={load} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Manage source + metadata refresh                                    */
/* ------------------------------------------------------------------ */

function ManageSource({
  manga,
  scripts,
  onSaved,
}: {
  manga: MangaDetail;
  scripts: ScriptInfo[];
  onSaved: () => void;
}) {
  const [srcId, setSrcId] = useState(manga.meta.sourceId || "");
  const [url, setUrl] = useState(manga.meta.link || "");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [report, setReport] = useState<{ fetched: Record<string, any>; coverSaved: boolean } | null>(null);

  const changed = srcId !== (manga.meta.sourceId || "") || url !== (manga.meta.link || "");

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await j(`${API}/manga/${manga.id}/source`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: srcId, url }),
      });
      setMsg({ kind: "ok", text: "Source saved." });
      onSaved();
    } catch (e: any) {
      setMsg({ kind: "bad", text: e?.message || "Could not save" });
    }
    setSaving(false);
  };

  const refresh = async () => {
    if (!srcId || !url) {
      setMsg({ kind: "bad", text: "Set a source and URL first." });
      return;
    }
    setRefreshing(true);
    setMsg(null);
    setReport(null);
    try {
      const d = await j<{ fetched: Record<string, any>; coverSaved: boolean }>(
        `${API}/manga/${manga.id}/refresh`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId: srcId, url }),
        }
      );
      setReport({ fetched: d.fetched, coverSaved: d.coverSaved });
      setMsg({ kind: "ok", text: "Metadata refreshed." });
      onSaved();
    } catch (e: any) {
      setMsg({ kind: "bad", text: e?.message || "Refresh failed" });
    }
    setRefreshing(false);
  };

  const rows: [string, string | null][] = report
    ? [
        ["title", report.fetched.title],
        ["authors", report.fetched.authors],
        ["status", report.fetched.status],
        ["genres", report.fetched.genres],
        ["chapters listed", report.fetched.chapters > 0 ? String(report.fetched.chapters) : null],
        ["description", report.fetched.description ? `${report.fetched.description.length} chars` : null],
        ["cover", report.coverSaved ? "saved" : report.fetched.coverLink ? "found, not saved" : null],
      ]
    : [];

  return (
    <section className="manage">
      <div className="manage-head">
        <h3>Metadata source</h3>
        <p className="cap">Where cover, description and chapter list refresh from.</p>
      </div>
      <div className="manage-row">
        <select className="input" value={srcId} onChange={(e) => setSrcId(e.target.value)}>
          <option value="">no source</option>
          {scripts.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <input
          className="input manage-url"
          placeholder="Series URL on that source…"
          value={url}
          onChange={(e) => {
            const u = e.target.value;
            setUrl(u);
            const host = hostOf(u);
            const m = scripts.find((s) => hostOf(s.rootUrl) === host);
            if (m) setSrcId(m.id);
          }}
        />
        {changed && (
          <button className="btn" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        <button className="btn" onClick={refresh} disabled={refreshing || !srcId || !url}>
          {refreshing ? "Refreshing…" : "Refresh metadata"}
        </button>
      </div>
      {msg && <Note kind={msg.kind}>{msg.text}</Note>}
      {report && (
        <div className="report">
          {rows.map(([k, v]) => (
            <div key={k} className="report-row">
              <span className="report-k">{k}</span>
              <span className={`report-v${v ? "" : " missing"}`}>{v || "not found"}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Reader — the reading room                                           */
/*                                                                     */
/* One continuous vertical scroll. Page shapes vary wildly between     */
/* sources — 70 pages at 940x1824 from one, 8 stitched strips up to    */
/* ~20,000px tall from another — and a vertical column is the only     */
/* layout that reads both. Images mount only when near the viewport.   */
/* ------------------------------------------------------------------ */

function RdImage({ src, i }: { src: string; i: number }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (failed)
    return (
      <button
        className="rd-ph rd-err"
        onClick={(e) => {
          e.stopPropagation();
          setFailed(false);
          setAttempt(attempt + 1);
        }}
      >
        page {i + 1} didn’t load — tap to retry
      </button>
    );
  return (
    <img
      className="rd-img"
      src={attempt ? `${src}${src.includes("?") ? "&" : "?"}r=${attempt}` : src}
      alt={`Page ${i + 1}`}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function ReaderView({
  target,
  onClose,
  onNavigate,
}: {
  target: ReadTarget;
  onClose: () => void;
  onNavigate: (chapterId: string) => void;
}) {
  const { mangaId, chapterId } = target;
  const [manga, setManga] = useState<MangaDetail | null>(null);
  const [pages, setPages] = useState<Page[] | null>(null);
  const [error, setError] = useState("");
  const [near, setNear] = useState<Set<number>>(() => new Set([0, 1, 2]));
  const [cur, setCur] = useState(0);
  const [chrome, setChrome] = useState(true);
  const [wide, setWide] = useState(false);
  const [resume, setResume] = useState<SavedPos | null>(null);
  const [frac, setFrac] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rafRef = useRef(0);

  const chapters = useMemo(() => (manga ? sortChapters(manga.chapters) : []), [manga]);
  const idx = chapters.findIndex((c) => c.id === chapterId);
  const chapter = idx >= 0 ? chapters[idx] : undefined;
  const prev = idx > 0 ? chapters[idx - 1] : undefined;
  const next = idx >= 0 ? chapters[idx + 1] : undefined;

  useEffect(() => {
    j<MangaDetail>(`${API}/manga/${mangaId}`)
      .then(setManga)
      .catch(() => setError("Could not open the series."));
  }, [mangaId]);

  useEffect(() => {
    setPages(null);
    setError("");
    setNear(new Set([0, 1, 2]));
    setCur(0);
    setFrac(0);
    setResume(null);
    pageRefs.current = [];
    scrollRef.current?.scrollTo(0, 0);
    j<{ data: Page[] }>(`${API}/manga/${mangaId}/chapters/${encodeURIComponent(chapterId)}/pages`)
      .then((d) => {
        setPages(d.data);
        const saved = store.get<SavedPos>(posKey(mangaId, chapterId));
        if (saved && saved.p > 1 && saved.p < d.data.length - 1) setResume(saved);
      })
      .catch(() => setError("Could not load this chapter’s pages."));
  }, [mangaId, chapterId]);

  // Lazy mounting: mark pages "near" well before they scroll in. A chapter
  // can be 128 pages and hundreds of MB — never fetch it all up front.
  useEffect(() => {
    if (!pages || pages.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        setNear((prevSet) => {
          let grew = false;
          const nextSet = new Set(prevSet);
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const i = Number((e.target as HTMLElement).dataset.i);
            if (!nextSet.has(i)) {
              nextSet.add(i);
              grew = true;
            }
          }
          return grew ? nextSet : prevSet;
        });
      },
      { root: scrollRef.current, rootMargin: "200% 0px 300% 0px" }
    );
    for (const el of pageRefs.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, [pages]);

  const onScroll = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      const st = el.scrollTop;
      const vh = el.clientHeight;
      setFrac(el.scrollHeight > vh ? Math.min(1, st / (el.scrollHeight - vh)) : 0);
      const mark = st + vh * 0.35;
      let c = 0;
      pageRefs.current.forEach((p, i) => {
        if (p && p.offsetTop <= mark) c = i;
      });
      setCur(c);
    });
  };

  // Keep position — on this device only. The server discards read position,
  // so localStorage is the honest store, not a degraded one.
  useEffect(() => {
    if (!pages || pages.length === 0 || !manga || !chapter) return;
    const t = setTimeout(() => {
      const now = Date.now();
      store.set(posKey(mangaId, chapterId), { p: cur, n: pages.length, at: now } satisfies SavedPos);
      const rec: ContinueRec = {
        mangaId,
        mangaTitle: manga.title,
        chapterId,
        chapterTitle: chapter.title,
        number: chapter.number,
        p: cur,
        n: pages.length,
        at: now,
      };
      store.set(`pb:last:${mangaId}`, rec);
      store.set("pb:continue", rec);
    }, 600);
    return () => clearTimeout(t);
  }, [cur, pages, manga, chapter, mangaId, chapterId]);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "[" && prev) onNavigate(prev.id);
      else if (e.key === "]" && next) onNavigate(next.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onClose, onNavigate]);

  const doResume = () => {
    if (!resume) return;
    // Mount everything up to the target so placeholder heights settle less.
    setNear((s) => {
      const n = new Set(s);
      for (let i = Math.max(0, resume.p - 1); i <= resume.p + 1; i++) n.add(i);
      return n;
    });
    requestAnimationFrame(() => pageRefs.current[resume.p]?.scrollIntoView({ block: "start" }));
    setResume(null);
  };

  // Focus the scroll pane so space/PageDown page through natively.
  useEffect(() => {
    scrollRef.current?.focus({ preventScroll: true });
  }, [pages]);

  const srcOf = (pg: Page) =>
    manga && chapter ? pageSrc(manga.dir, chapter.dir, pg.filename) : pg.url;

  const chLabel = (c: Chapter) => (isNaN(c.number) ? c.title : `Ch ${c.number}`);

  return (
    <div className="reader" role="dialog" aria-modal="true" aria-label={`Reading ${manga?.title || "chapter"}`}>
      <div className="rd-progress" style={{ transform: `scaleX(${frac})` }} aria-hidden />

      <div className={`rd-bar rd-top${chrome ? "" : " rd-hide"}`}>
        <button className="rd-btn" onClick={onClose} aria-label="Back to series">←</button>
        <div className="rd-id">
          <span className="rd-series">{manga?.title || "…"}</span>
          <span className="rd-ch">{chapter?.title || ""}</span>
        </div>
        <button
          className="rd-btn"
          onClick={() => setWide(!wide)}
          aria-pressed={wide}
          title={wide ? "Comfortable width" : "Fill the screen width"}
        >
          {wide ? "fit" : "fill"}
        </button>
      </div>

      <div className="rd-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={-1}>
        <div className={`rd-pages${wide ? " rd-fullw" : ""}`} onClick={() => setChrome(!chrome)}>
          {!pages && !error && <div className="rd-note">Opening…</div>}
          {error && (
            <div className="rd-note">
              {error}{" "}
              <button className="linklike" onClick={(e) => { e.stopPropagation(); onClose(); }}>
                Back
              </button>
            </div>
          )}
          {pages && pages.length === 0 && (
            <div className="rd-note">No pages on disk for this chapter.</div>
          )}
          {pages?.map((pg, i) => (
            <div
              key={pg.filename}
              className="rd-page"
              data-i={i}
              ref={(el) => { pageRefs.current[i] = el; }}
            >
              {near.has(i) ? (
                <RdImage src={srcOf(pg)} i={i} />
              ) : (
                <div className="rd-ph">{i + 1}</div>
              )}
            </div>
          ))}
          {pages && pages.length > 0 && (
            <footer className="rd-end" onClick={(e) => e.stopPropagation()}>
              <p className="rd-end-title">End of {chapter?.title || "chapter"}</p>
              {next ? (
                <button className="btn btn-primary" onClick={() => onNavigate(next.id)}>
                  Next — {next.title}
                </button>
              ) : (
                <p className="cap">Last chapter on disk.</p>
              )}
              <button className="btn btn-quiet" onClick={onClose}>Back to series</button>
            </footer>
          )}
        </div>
      </div>

      {resume && (
        <button className="rd-resume" onClick={doResume}>
          Resume at page {resume.p + 1}
          <span className="rd-resume-sub">kept on this device</span>
        </button>
      )}

      <div className={`rd-bar rd-bot${chrome ? "" : " rd-hide"}`}>
        <button className="rd-btn" disabled={!prev} onClick={() => prev && onNavigate(prev.id)}>
          ‹ {prev ? chLabel(prev) : "first"}
        </button>
        <span className="rd-count">{pages && pages.length > 0 ? `${cur + 1} / ${pages.length}` : "· / ·"}</span>
        <button className="rd-btn" disabled={!next} onClick={() => next && onNavigate(next.id)}>
          {next ? chLabel(next) : "latest"} ›
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sync diagnostics — the diff engine, exercised by hand               */
/*                                                                     */
/* The model: the client says what it holds, the server says what      */
/* changed or what to fetch. This view exists to make the tiering      */
/* visible — an 80-byte "nothing moved" next to a 2.5MB cold plan —    */
/* so every exchange is logged with exactly what it cost.              */
/* ------------------------------------------------------------------ */

type SyncKind = "root" | "series" | "block" | "chapter" | "page";

interface SyncNode {
  id: string;
  kind: SyncKind;
  hash: string;
  n: number;
  label: string;
}

interface SyncImage {
  id: string;
  chapterId: string;
  file: string;
  size: number;
  url: string;
  hash: string;
}

interface SyncDiff {
  root: string;
  changed: SyncNode[];
  images: SyncImage[];
  gone: string[];
  truncated: boolean;
}

interface SyncTree {
  root: string;
  blockSize: number;
  children: SyncNode[];
}

type HoldMode = "nothing" | "current" | "stale";

interface ScopeRef {
  id: string;
  label: string;
  kind: SyncKind;
}

interface Exchange {
  seq: number;
  at: number;
  title: string;
  scope: ScopeRef;
  depth?: number;
  resolve: "nodes" | "pages";
  haveN: number;
  reqBytes: number;
  respBytes: number;
  ms: number;
  res: SyncDiff;
}

const ROOT_SCOPE: ScopeRef = { id: "root", label: "entire library", kind: "root" };

/** Flip the last hex char: an honest way to fake an out-of-date copy. */
const staleize = (h: string) => h.slice(0, -1) + (h.endsWith("0") ? "1" : "0");

const DEPTH_LABEL: Record<number, string> = {
  1: "series",
  2: "blocks",
  3: "chapters",
  4: "pages",
};

function buildDiffBody(
  have: { id: string; hash: string }[],
  resolve: "nodes" | "pages",
  depth: number,
  scopeId: string
): string {
  const body: Record<string, unknown> = {};
  if (have.length) body.have = have;
  if (resolve === "pages") body.resolve = "pages";
  else body.depth = depth;
  if (scopeId !== "root") body.scope = scopeId;
  return JSON.stringify(body);
}

function KindTag({ kind }: { kind: SyncKind }) {
  return <span className={`ktag k-${kind}`}><i />{kind}</span>;
}

function ExchangeCard({
  ex,
  open,
  onToggle,
  onDrill,
  onRepair,
  busy,
}: {
  ex: Exchange;
  open: boolean;
  onToggle: () => void;
  onDrill: (n: SyncNode) => void;
  onRepair: (ex: Exchange) => void;
  busy: boolean;
}) {
  const imgBytes = useMemo(
    () => ex.res.images.reduce((a, im) => a + im.size, 0),
    [ex.res.images]
  );
  const nothing =
    ex.res.changed.length === 0 && ex.res.images.length === 0 && ex.res.gone.length === 0;
  const NODE_CAP = 30;
  const IMG_CAP = 10;
  const canRepair = ex.resolve === "pages" && ex.scope.id.startsWith("c:") && ex.res.images.length > 1;

  return (
    <article className={`ex${open ? " open" : ""}`}>
      <button className="ex-line" onClick={onToggle} aria-expanded={open}>
        <span className="ex-seq">#{ex.seq}</span>
        <span className="ex-title">{ex.title}</span>
        <span className="ex-cost">
          {fmtBytes(ex.reqBytes)} → <b>{fmtBytes(ex.respBytes)}</b>
        </span>
        <span className="ex-when">{timeAgo(ex.at)}</span>
        <span className="ex-caret">{open ? "\u25b4" : "\u25be"}</span>
      </button>
      {open && (
        <div className="ex-body">
          <div className="ex-meter">
            <span>1 request</span>
            <span>sent {fmtBytes(ex.reqBytes)}</span>
            <span>got <b>{fmtBytes(ex.respBytes)}</b></span>
            <span>{ex.ms < 1 ? "<1" : Math.round(ex.ms)} ms</span>
            <span>{fmt(ex.res.changed.length)} nodes</span>
            <span>{fmt(ex.res.images.length)} image records</span>
            {ex.res.truncated && <span className="ex-trunc">truncated at 20,000 images</span>}
          </div>

          {nothing && (
            <p className="ex-quiet">
              Nothing changed — the whole answer fit in {fmtBytes(ex.respBytes)}.
            </p>
          )}

          {ex.res.changed.length > 0 && (
            <div className="ex-nodes">
              <p className="cap">Where the difference is:</p>
              {ex.res.changed.slice(0, NODE_CAP).map((n) => (
                <div key={n.id} className="ex-node">
                  <KindTag kind={n.kind} />
                  <span className="ex-node-label">{n.label}</span>
                  <span className="ex-node-n">{fmt(n.n)} {n.kind === "chapter" ? "pages" : n.kind === "series" ? "blocks" : n.kind === "block" ? "chapters" : "series"}</span>
                  <span className="ex-node-hash">{n.hash}</span>
                  {(n.kind === "series" || n.kind === "block" || n.kind === "chapter") && (
                    <button className="btn btn-mini" disabled={busy} onClick={() => onDrill(n)}>
                      Drill in
                    </button>
                  )}
                </div>
              ))}
              {ex.res.changed.length > NODE_CAP && (
                <p className="cap">and {fmt(ex.res.changed.length - NODE_CAP)} more nodes.</p>
              )}
            </div>
          )}

          {ex.res.images.length > 0 && (
            <div className="ex-imgs">
              <p className="ex-plan-line">
                <b>{fmt(ex.res.images.length)}</b> images · <b>{fmtBytes(imgBytes)}</b> to fetch
                <span className="cap"> — the plan a cold client would follow</span>
              </p>
              {ex.res.images.slice(0, IMG_CAP).map((im) => (
                <div key={im.id} className="ex-img">
                  <span className="ex-img-file">{im.file}</span>
                  <span className="ex-img-ch">{im.chapterId}</span>
                  <span className="ex-img-size">{fmtBytes(im.size)}</span>
                </div>
              ))}
              {ex.res.images.length > IMG_CAP && (
                <p className="cap">and {fmt(ex.res.images.length - IMG_CAP)} more image records.</p>
              )}
              {canRepair && (
                <div className="ex-repair">
                  <button className="btn btn-mini" disabled={busy} onClick={() => onRepair(ex)}>
                    Simulate repairing one page
                  </button>
                  <span className="cap">re-sends this chapter’s hashes minus one — expect 1 image back</span>
                </div>
              )}
            </div>
          )}

          {ex.res.gone.length > 0 && (
            <p className="cap ex-gone">
              {fmt(ex.res.gone.length)} held id{ex.res.gone.length === 1 ? "" : "s"} no longer on the
              server — the client would drop these.
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function SyncView() {
  const [tree, setTree] = useState<SyncTree | null>(null);
  const [treeErr, setTreeErr] = useState("");
  const [scope, setScope] = useState<ScopeRef>(ROOT_SCOPE);
  const [extraScopes, setExtraScopes] = useState<ScopeRef[]>([]);
  const [depth, setDepth] = useState(1);
  const [resolve, setResolve] = useState<"nodes" | "pages">("nodes");
  const [hold, setHold] = useState<HoldMode>("nothing");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const [firing, setFiring] = useState(false);
  const [err, setErr] = useState("");
  const [armed, setArmed] = useState(false); // full cold plan needs a second press
  const hashes = useRef(new Map<string, string>());
  const seqRef = useRef(0);

  const loadTree = useCallback(() => {
    setTreeErr("");
    j<SyncTree>(`${API}/sync/tree`)
      .then((t) => {
        setTree(t);
        hashes.current.set("root", t.root);
        for (const c of t.children) hashes.current.set(c.id, c.hash);
      })
      .catch((e) => setTreeErr(e?.message || "Sync endpoints unreachable."));
  }, []);
  useEffect(loadTree, [loadTree]);

  // Any control change disarms the big-response confirmation.
  useEffect(() => setArmed(false), [scope, depth, resolve, hold]);

  const knownHash = hashes.current.get(scope.id);

  const makeHave = (sc: ScopeRef, hm: HoldMode): { id: string; hash: string }[] | null => {
    if (hm === "nothing") return [];
    const h = hashes.current.get(sc.id);
    if (!h) return null;
    return [{ id: sc.id, hash: hm === "stale" ? staleize(h) : h }];
  };

  const fire = async (over?: {
    scope?: ScopeRef;
    depth?: number;
    resolve?: "nodes" | "pages";
    hold?: HoldMode;
    have?: { id: string; hash: string }[];
    title?: string;
  }) => {
    const sc = over?.scope ?? scope;
    const rv = over?.resolve ?? resolve;
    const dp = over?.depth ?? depth;
    const hm = over?.hold ?? hold;
    const have = over?.have ?? makeHave(sc, hm);
    if (have === null) {
      setErr("No hash held for this scope yet — drill into it first so the client has one.");
      return;
    }
    const payload = buildDiffBody(have, rv, dp, sc.id);
    setFiring(true);
    setErr("");
    const t0 = performance.now();
    try {
      const r = await fetch(`${API}/sync/diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      const text = await r.text();
      const ms = performance.now() - t0;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const res = JSON.parse(text) as SyncDiff;
      hashes.current.set("root", res.root);
      for (const n of res.changed) hashes.current.set(n.id, n.hash);
      setTree((t) => (t && t.root !== res.root ? { ...t, root: res.root } : t));
      const holdLabel =
        hm === "nothing" ? "holding nothing" : hm === "current" ? "holding current" : "holding stale";
      const ex: Exchange = {
        seq: ++seqRef.current,
        at: Date.now(),
        title:
          over?.title ??
          `${holdLabel} · ${rv === "pages" ? "resolve pages" : `depth ${dp}`}${sc.id !== "root" ? ` · ${sc.label}` : ""}`,
        scope: sc,
        depth: rv === "nodes" ? dp : undefined,
        resolve: rv,
        haveN: have.length,
        reqBytes: new Blob([payload]).size,
        respBytes: new Blob([text]).size,
        ms,
        res,
      };
      setExchanges((p) => [ex, ...p]);
      setOpenSeq(ex.seq);
    } catch (e: any) {
      setErr(e?.message || "Diff failed.");
    }
    setFiring(false);
    setArmed(false);
  };

  const drill = (n: SyncNode) => {
    const sc: ScopeRef = { id: n.id, label: n.label, kind: n.kind };
    setScope(sc);
    setExtraScopes((xs) => (xs.some((x) => x.id === sc.id) ? xs : [...xs, sc]));
    fire({ scope: sc, resolve: "nodes", depth: 1, hold: "nothing", title: `drill · ${n.label}` });
  };

  const repair = (ex: Exchange) => {
    const imgs = ex.res.images;
    const drop = Math.floor(Math.random() * imgs.length);
    const have = imgs.filter((_, i) => i !== drop).map((im) => ({ id: im.id, hash: im.hash }));
    fire({
      scope: ex.scope,
      resolve: "pages",
      hold: "current",
      have,
      title: `repair one page · ${ex.scope.label}`,
    });
  };

  const bigAsk = resolve === "pages" && scope.id === "root" && hold === "nothing";
  const previewBytes = useMemo(() => {
    const have = makeHave(scope, hold);
    if (have === null) return null;
    return new Blob([buildDiffBody(have, resolve, depth, scope.id)]).size;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, hold, resolve, depth, tree, exchanges.length]);

  const scopeOptions: ScopeRef[] = useMemo(() => {
    const base: ScopeRef[] = [ROOT_SCOPE];
    if (tree) for (const c of tree.children) base.push({ id: c.id, label: c.label, kind: c.kind });
    for (const x of extraScopes) if (!base.some((b) => b.id === x.id)) base.push(x);
    return base;
  }, [tree, extraScopes]);

  return (
    <div className="wrap">
      <div className="view-head">
        <h2>Sync</h2>
        <p className="cap">The diff engine, exercised by hand.</p>
      </div>

      {treeErr ? (
        <Note kind="bad">
          {treeErr}{" "}
          <button className="linklike" onClick={loadTree}>Retry</button>
        </Note>
      ) : !tree ? (
        <div className="empty"><p className="cap">Hashing the shelf…</p></div>
      ) : (
        <>
          <section className="pulse">
            <div className="pulse-hash">
              <span className="cap">root hash</span>
              <span className="hashv">{tree.root}</span>
            </div>
            <span className="pulse-facts cap">
              {fmt(tree.children.length)} series · blocks of {tree.blockSize} chapters
            </span>
            <div className="pulse-act">
              <button
                className="btn"
                disabled={firing}
                onClick={() =>
                  fire({ scope: ROOT_SCOPE, resolve: "nodes", depth: 1, hold: "current", title: "anything changed?" })
                }
              >
                Anything changed?
              </button>
              <span className="cap">one request; ~80 bytes when nothing moved</span>
            </div>
          </section>

          <section className="con">
            <div className="con-head">
              <h3>Ask the engine</h3>
              <p className="cap">Say what you hold; it says what changed.</p>
            </div>
            <div className="con-grid">
              <label className="con-field">
                <span>Scope</span>
                <select
                  className="input"
                  value={scope.id}
                  onChange={(e) => {
                    const sc = scopeOptions.find((s) => s.id === e.target.value);
                    if (sc) setScope(sc);
                  }}
                >
                  {scopeOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.kind === "root" ? s.label : `${s.kind} · ${s.label}`}
                    </option>
                  ))}
                </select>
                <span className="cap">one subtree, or everything</span>
              </label>
              <label className="con-field">
                <span>Client holds</span>
                <select className="input" value={hold} onChange={(e) => setHold(e.target.value as HoldMode)}>
                  <option value="nothing">nothing — a cold client</option>
                  <option value="current" disabled={!knownHash}>the current hash — expect silence</option>
                  <option value="stale" disabled={!knownHash}>a stale hash — watch it locate</option>
                </select>
                <span className="cap">
                  {knownHash ? `holding ${scope.id} @ ${knownHash}` : "no hash held for this scope yet"}
                </span>
              </label>
              <label className="con-field">
                <span>Answer as</span>
                <select
                  className="input"
                  value={resolve}
                  onChange={(e) => setResolve(e.target.value as "nodes" | "pages")}
                >
                  <option value="nodes">nodes — where did it change</option>
                  <option value="pages">pages — what do I fetch</option>
                </select>
              </label>
              {resolve === "nodes" && (
                <label className="con-field">
                  <span>Depth</span>
                  <select className="input" value={depth} onChange={(e) => setDepth(+e.target.value)}>
                    {[1, 2, 3, 4].map((d) => (
                      <option key={d} value={d}>{d} — down to {DEPTH_LABEL[d]}</option>
                    ))}
                  </select>
                  <span className="cap">how far down the report descends</span>
                </label>
              )}
            </div>
            <div className="con-fire">
              {bigAsk && armed ? (
                <>
                  <button className="btn btn-danger" disabled={firing} onClick={() => fire()}>
                    Yes — fetch the full plan
                  </button>
                  <span className="cap cap-warn">
                    Cold plan for the whole library: thousands of image records, a multi-MB response.
                    That’s the demonstration.
                  </span>
                  <button className="btn btn-mini btn-quiet" onClick={() => setArmed(false)}>Never mind</button>
                </>
              ) : (
                <>
                  <button
                    className="btn btn-primary"
                    disabled={firing}
                    onClick={() => (bigAsk ? setArmed(true) : fire())}
                  >
                    {firing ? "Asking…" : "Fire diff"}
                  </button>
                  {previewBytes !== null && (
                    <span className="cap">request will weigh {fmtBytes(previewBytes)}</span>
                  )}
                </>
              )}
            </div>
            {err && <Note kind="bad">{err}</Note>}
          </section>

          <div className="plan-note">
            <span className="plan-stamp">plan</span>
            <p>
              A diff is a <b>plan, never permission</b> — it reports difference, not correctness.
              Nothing is downloaded or replaced from this screen.
            </p>
          </div>

          <section className="exs">
            <div className="exs-head">
              <h3>Exchanges <span className="dim">{fmt(exchanges.length)}</span></h3>
              <p className="cap">Every request this session, with what it cost.</p>
            </div>
            {exchanges.length === 0 ? (
              <div className="empty">
                <p className="empty-main">Nothing asked yet.</p>
                <p className="cap">Fire a diff above — each exchange lands here with its byte cost.</p>
              </div>
            ) : (
              exchanges.map((ex) => (
                <ExchangeCard
                  key={ex.seq}
                  ex={ex}
                  open={openSeq === ex.seq}
                  onToggle={() => setOpenSeq(openSeq === ex.seq ? null : ex.seq)}
                  onDrill={drill}
                  onRepair={repair}
                  busy={firing}
                />
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App shell                                                           */
/* ------------------------------------------------------------------ */

type Tab = "queue" | "library" | "sync";

function NavButtons({
  tab,
  go,
  active,
  attention,
  count,
}: {
  tab: Tab;
  go: (t: Tab) => void;
  active: number;
  attention: number;
  count: number | null;
}) {
  return (
    <>
      <button className={`tabbtn${tab === "queue" ? " on" : ""}`} onClick={() => go("queue")}>
        Queue
        {active > 0 && <span className="badge badge-run">{active}</span>}
        {active === 0 && attention > 0 && <span className="badge badge-bad">{attention}</span>}
      </button>
      <button className={`tabbtn${tab === "library" ? " on" : ""}`} onClick={() => go("library")}>
        Library
        {count !== null && <span className="badge">{count}</span>}
      </button>
      <button className={`tabbtn${tab === "sync" ? " on" : ""}`} onClick={() => go("sync")}>
        Sync
      </button>
    </>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("queue");
  const [selected, setSelected] = useState<string | null>(null);
  const [reading, setReading] = useState<ReadTarget | null>(null);
  const [readEpoch, setReadEpoch] = useState(0);
  const [resource, setResource] = useState<ResourceReq | null>(null);
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshTasks = useCallback(() => {
    j<{ data: DownloadTask[] }>(`${API}/downloads`)
      .then((d) => setTasks(d.data || []))
      .catch(() => {});
  }, []);

  const refreshStatus = useCallback(() => {
    j<ServerStatus>(`${API}/status`).then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    refreshTasks();
    refreshStatus();
    const start = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(refreshTasks, 2000);
    };
    start();
    const statusTimer = setInterval(refreshStatus, 30000);
    const onVis = () => {
      if (document.hidden) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      } else {
        refreshTasks();
        start();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      clearInterval(statusTimer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshTasks, refreshStatus]);

  const active = tasks.filter((t) => t.status === "downloading" || t.status === "queued").length;
  const attention = tasks.filter((t) => t.status === "failed").length;

  const go = (t: Tab) => {
    setTab(t);
    setSelected(null);
  };

  return (
    <>
      <header className="hdr">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <h1>Paperbox</h1>
          <span className="brand-sub">ledger &amp; reading room</span>
        </div>
        <nav className="tabs" aria-label="Views">
          <NavButtons tab={tab} go={go} active={active} attention={attention} count={status ? status.mangaCount : null} />
        </nav>
        <div className="hdr-status">
          {status && (
            <span className="cap">
              {status.mangaDir} · scanned {timeAgo(status.lastScan) || "never"}
            </span>
          )}
        </div>
      </header>

      {tab === "queue" ? (
        <QueueView
          tasks={tasks}
          refreshTasks={refreshTasks}
          resource={resource}
          onClearResource={() => setResource(null)}
        />
      ) : tab === "sync" ? (
        <SyncView />
      ) : selected ? (
        <DetailView
          id={selected}
          onBack={() => setSelected(null)}
          onQueued={() => { refreshTasks(); }}
          onResource={(req) => { setResource(req); setTab("queue"); }}
          onRead={(chapterId) => setReading({ mangaId: selected, chapterId })}
        />
      ) : (
        <LibraryView
          onSelect={setSelected}
          onGoQueue={() => setTab("queue")}
          onRead={setReading}
          readEpoch={readEpoch}
        />
      )}

      <nav className="bnav" aria-label="Views">
        <NavButtons tab={tab} go={go} active={active} attention={attention} count={status ? status.mangaCount : null} />
      </nav>

      {reading && (
        <ReaderView
          target={reading}
          onClose={() => { setReading(null); setReadEpoch((e) => e + 1); }}
          onNavigate={(chapterId) => setReading({ ...reading, chapterId })}
        />
      )}
    </>
  );
}
