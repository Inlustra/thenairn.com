/**
 * The workbench — the machinery room. The one place the server may speak
 * at length, because you walked in and asked. Sources, registries, scan,
 * the far-lane activity, and diagnosis. Administration lives here and
 * nowhere else.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { api, jobsAdapterActive } from "../api";
import type {
  DownloadTask,
  ServerStatus,
  ScanProgress,
  Job,
  JobsEnvelope,
  SourceHealth,
  SourceInfo,
  IdentityBinding,
  SyncRule,
  TreeChild,
} from "../api/contract";
import { Line, Weather, NeedsYou, AsOf } from "../ui";
import { timeAgo, clock, fmt, fmtBytes, hostOf } from "../lib";

type Tab = "activity" | "sources" | "registries" | "rules" | "diagnosis";

/* ------------------------------------------------------------------ */
/* Activity — the far lane, plus the scan errand                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Background work — the server's own housekeeping                     */
/*                                                                     */
/* scheduler.md §3: background scanning, cover generation and spine-   */
/* art extraction are not an errand — nothing arrives, nobody asked.   */
/* So: no spinner, no ticking number, no ambient presence. Dated       */
/* sentences answer "is anything happening?"; "is it stuck?" is        */
/* answered the same way — each job's last movement is tracked across  */
/* polls, and a running job that hasn't moved for a while turns amber  */
/* (weather: it rights itself, no retry lever). Percentages appear     */
/* only on the user-invoked scan above, because asking made it theirs. */
/* ------------------------------------------------------------------ */

/** Amber when the trouble reads as weather; red means a person is needed. */
function healsItself(error: string | null): boolean {
  return /rate|429|too many|block|cloudflare|timeout|timed out|temporar|busy|502|503|connection|network/i.test(
    error ?? "",
  );
}

const STUCK_AFTER_MS = 4 * 60_000;

/** Track when each job last changed shape, across poll responses. */
function useJobMovement(env: JobsEnvelope | null): Map<string, number> {
  const moved = useRef<Map<string, { key: string; at: number }>>(new Map());
  const out = new Map<string, number>();
  if (env) {
    const seen = new Set<string>();
    for (const jb of env.jobs) {
      seen.add(jb.id);
      const key = `${jb.state}:${jb.done}:${jb.total ?? ""}`;
      const prev = moved.current.get(jb.id);
      if (!prev || prev.key !== key) moved.current.set(jb.id, { key, at: Date.now() });
    }
    for (const id of [...moved.current.keys()]) if (!seen.has(id)) moved.current.delete(id);
  }
  for (const [id, v] of moved.current) out.set(id, v.at);
  return out;
}

function BackgroundWork({
  env,
  movedAt,
  hideScan,
}: {
  env: JobsEnvelope | null;
  movedAt: Map<string, number>;
  hideScan: boolean;
}) {
  if (!env) return null;

  const jobs = env.jobs.filter((jb) => !(hideScan && jb.kind === "scan"));
  const running = jobs.filter((jb) => jb.state === "running");
  const queuedN = jobs.filter((jb) => jb.state === "queued").length;
  const failed = jobs.filter((jb) => jb.state === "failed");
  const finished = jobs
    .filter((jb) => jb.state === "done" || jb.state === "cancelled")
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const last = finished[0];

  return (
    <section className="wb-section">
      <h3>In the background</h3>
      <p className="cap">
        The server keeps the library looked-at and cuts spine art and covers on its own.
        Nothing here needs watching, and nothing it does touches your files.
      </p>

      {failed.map((jb) =>
        healsItself(jb.error) ? (
          <Weather key={jb.id}>
            {jb.label} didn't finish — the source or the disk was busy. It will be tried
            again by itself.
          </Weather>
        ) : (
          <NeedsYou key={jb.id} verb="Look again" onVerb={() => api.scan.start().catch(() => {})}>
            {jb.label} stopped{jb.error ? ` — ${jb.error}` : ""}. Nothing already on your
            shelf was touched.
          </NeedsYou>
        ),
      )}

      {running.map((jb) => {
        const at = movedAt.get(jb.id);
        const stuck = at != null && Date.now() - at > STUCK_AFTER_MS;
        return (
          <div key={jb.id} className="job-row">
            <p className="job-line">
              {jb.label}
              {jb.startedAt ? ` · started ${timeAgo(jb.startedAt)}` : ""}
            </p>
            {stuck && (
              <Weather>
                Running behind — nothing has moved since {clock(at!)}. The library is busy;
                it rights itself.
              </Weather>
            )}
          </div>
        );
      })}

      {queuedN > 0 && (
        <p className="cap">
          {queuedN} more waiting {running.length > 0 ? "behind it" : "their turn"}.
        </p>
      )}

      {running.length === 0 && queuedN === 0 && failed.length === 0 && (
        <p className="cap">
          Nothing is running.
          {last?.finishedAt
            ? ` Last finished: ${last.label} · ${timeAgo(last.finishedAt)}${
                last.state === "cancelled" ? " · stopped by you" : ""
              }.`
            : ""}
        </p>
      )}

      {jobsAdapterActive && (
        <p className="cap">
          The jobs route hasn't landed on this server yet — this section shows only what the
          scan envelope can attest.
        </p>
      )}
    </section>
  );
}

function taskLine(t: DownloadTask): string {
  const done = t.chapters.filter((c) => c.status === "completed").length;
  const dl = t.chapters.find((c) => c.status === "downloading");
  if (t.status === "downloading" && dl)
    return `Inking ${dl.name} from ${t.sourceName} · ${dl.pagesDownloaded} of ${dl.pagesTotal || "?"} pages · ${done} of ${t.chapters.length} chapters done`;
  if (t.status === "queued") return `Queued · ${t.chapters.length} chapters from ${t.sourceName}`;
  if (t.status === "completed") return `${t.chapters.length} chapters inked from ${t.sourceName}`;
  if (t.status === "cancelled") return `Stopped by you · ${done} of ${t.chapters.length} landed first`;
  return `Stopped · ${done} of ${t.chapters.length} chapters landed and read fine`;
}

function isWeatherTask(t: DownloadTask): boolean {
  const errs = t.chapters.map((c) => c.error ?? "").join(" ");
  return t.status === "downloading" && /rate|429|too many|block|cloudflare/i.test(errs);
}

function ActivityTab({
  tasks,
  refreshTasks,
}: {
  tasks: DownloadTask[];
  refreshTasks: () => void;
}) {
  const [scan, setScan] = useState<ScanProgress | null>(null);
  const [scanAsked, setScanAsked] = useState(false);
  const [jobsEnv, setJobsEnv] = useState<JobsEnvelope | null>(null);
  const [stopNote, setStopNote] = useState("");
  const movedAt = useJobMovement(jobsEnv);

  // Poll scan progress only while a scan the user asked for is running.
  useEffect(() => {
    if (!scanAsked) return;
    const t = setInterval(() => {
      api.scan.progress().then((p) => {
        setScan(p);
        if (!p.active) setScanAsked(false);
      }).catch(() => {});
    }, 800);
    return () => clearInterval(t);
  }, [scanAsked]);

  // Poll the jobs envelope on its ETag — a 304 costs nothing to serve.
  useEffect(() => {
    let live = true;
    const tick = () => api.jobs.list().then((e) => { if (live) setJobsEnv(e); }).catch(() => {});
    tick();
    const t = setInterval(tick, 2500);
    return () => { live = false; clearInterval(t); };
  }, []);

  const lookNow = () => {
    setScanAsked(true);
    setStopNote("");
    api.scan.start().then(refreshTasks).catch(() => setScanAsked(false));
  };

  // The un-ask. Yours to stop because you started it. Only offered when a
  // real job row exists to cancel — the fallback has no route to stop
  // anything, and a lever that can only refuse is theatre.
  const yourScanJob: Job | undefined = scanAsked && !jobsAdapterActive
    ? jobsEnv?.jobs.find((jb) => jb.kind === "scan" && (jb.state === "running" || jb.state === "queued"))
    : undefined;
  const stopScan = () => {
    if (!yourScanJob) return;
    api.jobs.cancel(yourScanJob.id)
      .then(() => setScanAsked(false))
      .catch((e: any) => setStopNote(e?.message || "Could not stop it."));
  };

  const ordered = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        const rank = (t: DownloadTask) =>
          t.status === "failed" ? 0 : t.status === "downloading" ? 1 : t.status === "queued" ? 2 : 3;
        return rank(a) - rank(b) || b.updatedAt - a.updatedAt;
      }),
    [tasks],
  );

  return (
    <div>
      <section className="wb-section">
        <h3>The library</h3>
        <p className="cap">
          Anything Paperbox downloads appears at once. Anything you add yourself is found within
          six hours — sooner for series you've been reading.
        </p>
        <div className="wb-row">
          <button className="btn" onClick={lookNow} disabled={scanAsked}>
            {scanAsked ? "Looking…" : "Look now"}
          </button>
          {/* You asked, so the errand is yours — it earns numbers and a Stop. */}
          {scanAsked && scan?.active && (
            <span className="cap">
              {scan.seriesDone} of {scan.seriesTotal} series · {fmt(scan.chaptersSeen)} chapters seen
              {scan.currentSeries ? ` · ${scan.currentSeries}` : ""}
            </span>
          )}
          {yourScanJob && (
            <button className="btn" onClick={stopScan}>
              Stop
            </button>
          )}
          {scanAsked === false && scan && !scan.active && scan.durationMs != null && (
            <span className="cap">
              Looked at {scan.seriesTotal} series · nothing was touched
            </span>
          )}
        </div>
        {stopNote && <Line tone="amber">{stopNote}</Line>}
      </section>

      <BackgroundWork env={jobsEnv} movedAt={movedAt} hideScan={scanAsked} />

      <section className="wb-section">
        <h3>On its way</h3>
        {ordered.length === 0 && (
          <p className="cap">Nothing on its way. The shelf is yours.</p>
        )}
        {ordered.map((t) => {
          const done = t.chapters.filter((c) => c.status === "completed").length;
          const failedCh = t.chapters.filter((c) => c.status === "failed");
          return (
            <div key={t.id} className={`task task-${t.status}`}>
              <div className="task-head">
                <strong>{t.mangaTitle}</strong>
                <span className="cap">{timeAgo(t.updatedAt)}</span>
              </div>
              <p className="task-line">{taskLine(t)}</p>
              {isWeatherTask(t) && (
                <Weather>
                  {t.sourceName} asked us to slow down. The queue resumes itself — nothing needed
                  from you.
                </Weather>
              )}
              {t.status === "failed" && (
                <NeedsYou
                  verb="Retry"
                  onVerb={() => api.downloads.retry(t.id).then(refreshTasks)}
                >
                  Retries used up on {failedCh.length} chapter{failedCh.length === 1 ? "" : "s"}.
                  The {done} that landed are safe and readable. Nothing already on your shelf was
                  touched.
                </NeedsYou>
              )}
              <div className="task-verbs">
                {(t.status === "queued" || t.status === "downloading") && (
                  <button className="btn" onClick={() => api.downloads.cancel(t.id).then(refreshTasks)}>
                    Stop
                  </button>
                )}
                {(t.status === "completed" || t.status === "cancelled" || t.status === "failed") && (
                  <button className="btn" onClick={() => api.downloads.remove(t.id).then(refreshTasks)}>
                    Clear
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sources — health, modules, and the Get door                         */
/* ------------------------------------------------------------------ */

function AddFromUrl({ refreshTasks }: { refreshTasks: () => void }) {
  const [url, setUrl] = useState("");
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [info, setInfo] = useState<{ title: string; names: string[]; links: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [tail, setTail] = useState("");

  const look = async () => {
    setBusy(true);
    setNote("");
    setInfo(null);
    try {
      const s = await api.sources.detect(url.trim());
      setSource(s);
      if (!s) {
        setNote("No configured source answers to that address.");
        return;
      }
      const r = await api.sources.info(s.id, url.trim());
      setInfo({
        title: r.manga.title || "(untitled)",
        names: r.manga.chapterNames ?? [],
        links: r.manga.chapterLinks ?? [],
      });
    } catch (e: any) {
      setNote(e?.message || "The source didn't answer.");
    } finally {
      setBusy(false);
    }
  };

  const get = async (n?: number) => {
    if (!source || !info) return;
    const all = info.names.map((name, i) => ({ name, url: info.links[i] ?? "" })).filter((c) => c.url);
    const want = n ? all.slice(-n) : all;
    if (want.length === 0) return;
    setBusy(true);
    try {
      await api.downloads.create({
        mangaTitle: info.title,
        sourceId: source.id,
        mangaUrl: url.trim(),
        chapters: want,
      });
      setNote(`Queued ${want.length} — fetching takes a while, no need to watch.`);
      setInfo(null);
      setUrl("");
      refreshTasks();
    } catch (e: any) {
      setNote(e?.message || "Could not queue.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="add-url">
      <p className="cap">
        Find a series at a source outside the app, then paste its address here. Paperbox fetches
        slowly and politely, so the source doesn't mind.
      </p>
      <div className="wb-row">
        <input
          className="search"
          type="url"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Series address at a source"
        />
        <button className="btn" onClick={look} disabled={busy || !url.trim()}>
          {busy ? "Asking…" : "Look"}
        </button>
      </div>
      {info && source && (
        <div className="wb-row add-found">
          <span>
            <strong>{info.title}</strong> · {info.names.length} chapters at {source.name}
          </span>
          <button className="btn btn-primary" onClick={() => get()} disabled={busy}>
            Get all {info.names.length}
          </button>
          <input
            className="tail-n"
            type="number"
            min={1}
            placeholder="N"
            value={tail}
            onChange={(e) => setTail(e.target.value)}
            aria-label="Get only the last N"
          />
          <button
            className="btn"
            onClick={() => get(Math.max(1, Number(tail) || 1))}
            disabled={busy || !tail}
          >
            Get last {tail || "N"}
          </button>
        </div>
      )}
      {note && <Line tone="pencil">{note}</Line>}
    </div>
  );
}

function SourcesTab({ refreshTasks }: { refreshTasks: () => void }) {
  const [health, setHealth] = useState<SourceHealth[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [pulling, setPulling] = useState(false);

  const load = () => {
    api.sourceHealth.all().then(setHealth).catch(() => {});
    api.sources.list().then((s) => setCount(s.length)).catch(() => {});
  };
  useEffect(load, []);

  return (
    <div>
      <section className="wb-section">
        <h3>Get something new</h3>
        <AddFromUrl refreshTasks={refreshTasks} />
      </section>

      <section className="wb-section">
        <h3>Sources in use</h3>
        {health.length === 0 && <p className="cap">No source is bound to anything yet.</p>}
        {health.map((h) => (
          <div key={h.sourceId} className="health-row">
            <strong>{h.sourceName}</strong>
            <span className="cap">
              {h.seriesBound} series
              {h.lastFetchAt ? ` · fetched ${timeAgo(h.lastFetchAt)}` : ""}
              {h.waitingChapters > 0 ? ` · ${h.waitingChapters} waiting` : ""}
            </span>
            {h.state !== "healthy" && <Weather>{h.detail}</Weather>}
          </div>
        ))}
        <p className="cap">
          {count != null && <>{fmt(count)} source modules installed. </>}
          <button className="linkish" disabled={pulling} onClick={() => {
            setPulling(true);
            api.sources.pull().then(load).finally(() => setPulling(false));
          }}>
            {pulling ? "Refreshing…" : "Refresh modules"}
          </button>
        </p>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Registries — providers and the identity queue                        */
/* ------------------------------------------------------------------ */

function RegistriesTab({ onOpenSeries }: { onOpenSeries: (id: string) => void }) {
  const [bindings, setBindings] = useState<Record<string, IdentityBinding>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    api.identity.all().then(setBindings).catch(() => {});
    api.library.list({ limit: 100 }).then((d) => {
      const t: Record<string, string> = {};
      for (const m of d.data) t[m.id] = m.title;
      setTitles(t);
    }).catch(() => {});
  }, []);

  const all = Object.values(bindings);
  const connected = new Map<string, number>();
  const suggested = new Map<string, number>();
  for (const b of all) {
    if (b.registry) connected.set(b.registry.provider, (connected.get(b.registry.provider) ?? 0) + 1);
    if (b.alsoConfirmedBy) connected.set(b.alsoConfirmedBy, (connected.get(b.alsoConfirmedBy) ?? 0) + 1);
    if (b.suggestedProvider) suggested.set(b.suggestedProvider, (suggested.get(b.suggestedProvider) ?? 0) + 1);
  }
  const queue = all.filter((b) => b.state === "guess" || b.state === "contradicted" || b.state === "unconfigured");

  return (
    <div>
      <section className="wb-section">
        <h3>Registries</h3>
        <p className="cap">
          A registry says what exists — it is never fetched from. One identity binding per series.
        </p>
        {[...connected.entries()].map(([name, n]) => (
          <div key={name} className="health-row">
            <strong>{name}</strong>
            <span className="cap">{n} series identified · no key needed</span>
          </div>
        ))}
        {[...suggested.entries()].map(([name, n]) => (
          <div key={name} className="health-row">
            <strong>{name}</strong>
            <span className="cap">
              Not connected · free key · would likely identify {n} of your series
            </span>
          </div>
        ))}
        {connected.size === 0 && suggested.size === 0 && (
          <p className="cap">Nothing to report yet.</p>
        )}
      </section>

      <section className="wb-section">
        <h3>Identity {queue.length > 0 && `· ${queue.length} need a look`}</h3>
        {queue.length === 0 && <p className="cap">Every series is settled.</p>}
        {queue.map((b) => (
          <button key={b.seriesId} className="queue-row" onClick={() => onOpenSeries(b.seriesId)}>
            <strong>{titles[b.seriesId] ?? b.seriesId}</strong>
            <span className={`cap ${b.state === "contradicted" ? "cap-red" : ""}`}>
              {b.state === "contradicted"
                ? "The evidence contradicts its match"
                : b.state === "guess"
                  ? `Best guess ready · ${b.candidate?.title ?? ""}`
                  : `Wants ${b.suggestedProvider ?? "a registry"} — not connected`}
            </span>
          </button>
        ))}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rules — read-only sentences                                          */
/* ------------------------------------------------------------------ */

function ruleSentence(r: SyncRule): string {
  const scope =
    r.scope.kind === "window" ? `the next ${r.scope.n} unread of ${r.scope.ref}`
    : r.scope.kind === "series" ? `all of ${r.scope.ref}`
    : r.scope.kind === "collection" ? `each series on ${r.scope.ref}`
    : r.scope.kind === "range" ? `chapters ${r.scope.ref}`
    : `chapter ${r.scope.ref}`;
  const retention =
    r.retention.kind === "release-after-read"
      ? `, and let a read chapter go after ${r.retention.afterN ?? 0} more`
      : "";
  return `Keep ${scope}${retention}.`;
}

function RulesTab() {
  const [list, setList] = useState<SyncRule[]>([]);
  useEffect(() => {
    api.rules.list().then(setList).catch(() => {});
  }, []);
  return (
    <section className="wb-section">
      <h3>Standing intent</h3>
      <p className="cap">
        Rules are authored on devices; the web reads them. An imperative Get is a rule with a
        lifetime of one evaluation.
      </p>
      {list.map((r) => (
        <div key={r.id} className="rule-row">
          <p>{ruleSentence(r)}</p>
          <span className="cap">
            Right now this means {r.resolved.chapters} chapters · {fmtBytes(r.resolved.bytes)} ·{" "}
            {r.deviceName}
          </span>
        </div>
      ))}
      {list.length === 0 && <p className="cap">No standing rules.</p>}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Diagnosis — server facts, and what is adapter-backed                 */
/* ------------------------------------------------------------------ */

function DiagnosisTab({ status }: { status: ServerStatus | null }) {
  const [tree, setTree] = useState<{ root: string; treeVersion: number; blockSize: number; children: TreeChild[] } | null>(null);
  useEffect(() => {
    api.sync.tree().then(setTree).catch(() => {});
  }, []);

  return (
    <div>
      <section className="wb-section">
        <h3>The server</h3>
        {status ? (
          <dl className="facts">
            <div><dt>Library</dt><dd>{status.library.dir}</dd></div>
            <div><dt>Holds</dt><dd>{fmt(status.library.series)} series · {fmt(status.library.chapters)} chapters</dd></div>
            <div><dt>Last scan</dt><dd>{timeAgo(status.library.lastScan) || "never"}</dd></div>
            <div><dt>Up</dt><dd>since {new Date(status.server.startedAt).toLocaleString()}</dd></div>
            <div><dt>Library signature</dt><dd className="mono">{status.library.sig}</dd></div>
          </dl>
        ) : (
          <p className="cap">Waiting for the status envelope.</p>
        )}
      </section>

      <section className="wb-section">
        <h3>The sync tree</h3>
        {tree ? (
          <dl className="facts">
            <div><dt>Root</dt><dd className="mono">{tree.root}</dd></div>
            <div><dt>Tree version</dt><dd>{tree.treeVersion} — a version change means re-diff, never delete</dd></div>
            <div><dt>Block size</dt><dd>{tree.blockSize} chapters</dd></div>
            <div><dt>Series nodes</dt><dd>{tree.children.length}</dd></div>
          </dl>
        ) : (
          <p className="cap">Waiting for the tree.</p>
        )}
      </section>

      <section className="wb-section">
        <h3>What this client is honest about</h3>
        <p className="cap">
          These surfaces run on the pending adapter, not the server — see{" "}
          <span className="mono">docs/api-gaps.md</span>. Deleting the adapter entry when each
          route lands is the whole change.
        </p>
        <ul className="gaps">
          <li>Read state — this browser only; positions do not reach other devices yet</li>
          <li>Identity — registry bindings are the recorded 2026-08-28 harvest, not live lookups</li>
          <li>Source health — derived from this session's download tasks; no history, no stall detection</li>
          <li>Look elsewhere — the survey rows are representative, not asked of sources</li>
          <li>Rules — a sample sentence; no rule store exists</li>
          <li>Freshness — the library-wide scan stamp, applied per series</li>
          <li>
            Background jobs — the real route when the server answers; until it lands, only
            the scan envelope, so art and cover work is invisible here
          </li>
          <li>Flags — this browser only; the household does not see them</li>
        </ul>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The workbench shell                                                  */
/* ------------------------------------------------------------------ */

export function WorkbenchView({
  tasks,
  status,
  refreshTasks,
  onOpenSeries,
  initialTab,
}: {
  tasks: DownloadTask[];
  status: ServerStatus | null;
  refreshTasks: () => void;
  onOpenSeries: (id: string) => void;
  initialTab?: string;
}) {
  const [tab, setTab] = useState<Tab>(
    (["activity", "sources", "registries", "rules", "diagnosis"].includes(initialTab ?? "")
      ? (initialTab as Tab)
      : "activity"),
  );
  const needsYou = tasks.filter((t) => t.status === "failed").length;

  return (
    <main className="workbench">
      <nav className="wb-tabs" aria-label="Workbench">
        {(
          [
            ["activity", `Activity${needsYou ? ` · ${needsYou} need you` : ""}`],
            ["sources", "Sources"],
            ["registries", "Registries"],
            ["rules", "Rules"],
            ["diagnosis", "Diagnosis"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === "activity" && <ActivityTab tasks={tasks} refreshTasks={refreshTasks} />}
      {tab === "sources" && <SourcesTab refreshTasks={refreshTasks} />}
      {tab === "registries" && <RegistriesTab onOpenSeries={onOpenSeries} />}
      {tab === "rules" && <RulesTab />}
      {tab === "diagnosis" && <DiagnosisTab status={status} />}

      {status && (
        <footer className="wb-foot cap">
          {status.library.dir} · {fmt(status.library.series)} series ·{" "}
          {fmt(status.library.chapters)} chapters · last scan {timeAgo(status.library.lastScan)}{" "}
          <AsOf t={Date.now()} />
        </footer>
      )}
    </main>
  );
}
