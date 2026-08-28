/**
 * The shell. Two rooms — the library (the front door) and the workbench —
 * plus the series screen and the reader.
 *
 * One law under everything: the interface renders from local state; the
 * network updates that state, it never provides it. A tab that has painted
 * never blanks — it stamps "as of" and keeps working. Only a fresh tab
 * with nothing loaded gets the one blocking page.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { DownloadTask, JobsEnvelope, ServerStatus } from "./api/contract";
import { LibraryView } from "./views/Library";
import { SeriesView } from "./views/Series";
import { ReaderView } from "./views/Reader";
import { WorkbenchView } from "./views/Workbench";
import { Ledger, SeamMark, readSeam, useJobMovement } from "./seam";
import { clock } from "./lib";

/* ------------------------------------------------------------------ */
/* Hash routing                                                        */
/* ------------------------------------------------------------------ */

type Route =
  | { view: "library" }
  | { view: "series"; id: string; read?: string }
  | { view: "workbench"; tab?: string };

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const parts = h.split("/").map(decodeURIComponent).filter(Boolean);
  if (parts[0] === "series" && parts[1]) {
    if (parts[2] === "read" && parts[3]) return { view: "series", id: parts[1], read: parts[3] };
    return { view: "series", id: parts[1] };
  }
  if (parts[0] === "workbench") return { view: "workbench", tab: parts[1] };
  return { view: "library" };
}

function toHash(r: Route): string {
  switch (r.view) {
    case "library": return "#/";
    case "series":
      return r.read
        ? `#/series/${encodeURIComponent(r.id)}/read/${encodeURIComponent(r.read)}`
        : `#/series/${encodeURIComponent(r.id)}`;
    case "workbench": return r.tab ? `#/workbench/${r.tab}` : "#/workbench";
  }
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: Route) => {
    location.hash = toHash(r);
  }, []);
  return [route, go];
}

/* ------------------------------------------------------------------ */
/* The one blocking page                                               */
/* ------------------------------------------------------------------ */

function Unreachable({ lastTry }: { lastTry: number }) {
  return (
    <main className="unreachable">
      <h2>The server isn't answering</h2>
      <p>
        This page lives on your Paperbox server, so there's nothing to show until it's back. Your
        library is sitting safely on its disk.
      </p>
      <p className="cap">Retrying every few seconds · last try {clock(lastTry)}</p>
      <p className="cap">
        Usual suspects: the server machine is off, or you're outside the house without remote
        access on.
      </p>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* The app                                                             */
/* ------------------------------------------------------------------ */

export function App() {
  const [route, go] = useRoute();
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [jobsEnv, setJobsEnv] = useState<JobsEnvelope | null>(null);
  const [reachable, setReachable] = useState(true);
  const [lastTry, setLastTry] = useState(Date.now());
  const [asOf, setAsOf] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Jobs ride the same cadence as tasks; the ETag makes an unchanged
  // envelope cost only the header exchange. The views that render derived
  // work in place (library cards, series, shelf) all read this one state.
  const refreshJobs = useCallback(() => {
    api.jobs.list().then(setJobsEnv).catch(() => {});
  }, []);

  const refreshTasks = useCallback(() => {
    refreshJobs();
    api.downloads.list()
      .then((d) => {
        setTasks(d);
        setReachable(true);
        setAsOf(Date.now());
      })
      .catch(() => setReachable(false))
      .finally(() => setLastTry(Date.now()));
  }, [refreshJobs]);

  const refreshStatus = useCallback(() => {
    api.status.get()
      .then((s) => {
        setStatus(s);
        setReachable(true);
        setAsOf(Date.now());
      })
      .catch(() => setReachable(false))
      .finally(() => setLastTry(Date.now()));
  }, []);

  useEffect(() => {
    refreshTasks();
    refreshStatus();
    const start = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(refreshTasks, 2500);
    };
    start();
    const statusTimer = setInterval(refreshStatus, 30000);
    const onVis = () => {
      if (document.hidden) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      } else {
        refreshTasks();
        refreshStatus();
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

  const everLoaded = status !== null;
  const inking = tasks.filter((t) => t.status === "downloading" || t.status === "queued").length;
  const needsYou = tasks.filter((t) => t.status === "failed").length;

  // The seam: one reading for every screen. The mark is its constant
  // presence; the ledger opens from it and from nowhere else.
  const movedAt = useJobMovement(jobsEnv);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const reading = readSeam({ tasks, jobsEnv, status, reachable, asOf, movedAt });

  // A fresh tab with nothing loaded and no server: the one blocking state.
  if (!everLoaded && !reachable) return <Unreachable lastTry={lastTry} />;

  const openSeries = (id: string) => go({ view: "series", id });
  const toWorkbench = () => {
    setLedgerOpen(false);
    go({ view: "workbench", tab: "activity" });
  };

  return (
    <>
      <header className="hdr">
        <button className="brand" onClick={() => go({ view: "library" })}>
          <span className="brand-mark" aria-hidden />
          <h1>Paper<span>box</span></h1>
        </button>

        {/* The ambient seam: silence is the healthy state. The mark is
            always there — its stillness is the message; the chips are its
            words and appear only when there is something to say. */}
        <div className="seam" aria-live="polite">
          <SeamMark reading={reading} open={ledgerOpen} onToggle={() => setLedgerOpen((o) => !o)} />
          {inking > 0 && <span className="chip chip-pencil">{inking} on the way</span>}
          {needsYou > 0 && (
            <button
              className="chip chip-red"
              onClick={() => go({ view: "workbench", tab: "activity" })}
            >
              {needsYou === 1 ? "1 needs you" : `${needsYou} need you`}
            </button>
          )}
          {everLoaded && !reachable && asOf && (
            <span className="chip chip-amber">as of {clock(asOf)}</span>
          )}
        </div>

        <nav className="hdr-nav" aria-label="Sections">
          <button
            className={route.view !== "workbench" ? "on" : ""}
            onClick={() => go({ view: "library" })}
          >
            Shelf
          </button>
          <button
            className={route.view === "workbench" ? "on" : ""}
            onClick={() => go({ view: "workbench" })}
          >
            Workbench
          </button>
        </nav>
      </header>

      {route.view === "library" && (
        <LibraryView
          tasks={tasks}
          jobsEnv={jobsEnv}
          onOpen={openSeries}
          onRead={(seriesId, chapterId) => go({ view: "series", id: seriesId, read: chapterId })}
        />
      )}
      {route.view === "series" && (
        <SeriesView
          id={route.id}
          tasks={tasks}
          jobsEnv={jobsEnv}
          onBack={() => go({ view: "library" })}
          onRead={(chapterId) => go({ view: "series", id: route.id, read: chapterId })}
          refreshTasks={refreshTasks}
        />
      )}
      {route.view === "workbench" && (
        <WorkbenchView
          tasks={tasks}
          status={status}
          jobsEnv={jobsEnv}
          refreshTasks={refreshTasks}
          onOpenSeries={openSeries}
          initialTab={route.tab}
        />
      )}

      {route.view === "series" && route.read && (
        <ReaderView
          seriesId={route.id}
          chapterId={route.read}
          onClose={() => go({ view: "series", id: route.id })}
          onNavigate={(chapterId) => go({ view: "series", id: route.id, read: chapterId })}
          // The reader is sacred: the mark rides its own chrome (already
          // hidden until tapped) and only when something is stuck or wrong.
          // Pencil work and rest are silence while a page is open.
          seam={
            reading.tone === "amber" || reading.tone === "red" ? (
              <SeamMark
                reading={reading}
                open={ledgerOpen}
                onToggle={() => setLedgerOpen((o) => !o)}
              />
            ) : null
          }
        />
      )}

      {ledgerOpen && (
        <Ledger
          tasks={tasks}
          jobsEnv={jobsEnv}
          status={status}
          reading={reading}
          movedAt={movedAt}
          asOf={asOf}
          onClose={() => setLedgerOpen(false)}
          onWorkbench={toWorkbench}
        />
      )}
    </>
  );
}
