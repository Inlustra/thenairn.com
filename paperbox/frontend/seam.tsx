/**
 * The seam — the one continuously-updated status surface.
 *
 * Two parts, one vocabulary:
 *
 *   The MARK is a single glyph that is always there, in the same place,
 *   on every screen. Its weave is the whole ambient message: solid ink at
 *   rest, pencil dash while something moves, amber hatch when something
 *   is weather, red ring-dot when a person is needed. It never animates,
 *   never ticks, never grows a number — the ambient seam's animation is
 *   reserved for the near lane (ui.md), and the web client has none.
 *
 *   The LEDGER is what opens when you press the mark: the same facts as
 *   dated sentences, on any screen, without walking to the workbench.
 *   It answers and closes; every lever stays in the workbench.
 *
 * What tints the mark, and what does not:
 *   - far-lane fetching, and art/cover housekeeping → pencil
 *   - a background scan → nothing (scheduler.md §3: no ambient presence)
 *   - stuck work, weather failures, scan running behind, a server that
 *     stopped answering → amber
 *   - a fetch out of retries, art that stopped and needs a look → red
 *
 * The ledger derives everything from state App already polls; it adds no
 * request of its own.
 */

import { useEffect, useRef } from "react";
import type { DownloadTask, Job, JobsEnvelope, ServerStatus } from "./api/contract";
import { Glyph, type GlyphState, Line } from "./ui";
import { clock, healsItself, timeAgo } from "./lib";

/** A running job whose shape hasn't changed for this long is stuck. */
export const STUCK_AFTER_MS = 4 * 60_000;

/**
 * Track when each job last changed shape, across poll responses. Shared
 * by the seam and the workbench so "stuck" means one thing everywhere.
 */
export function useJobMovement(env: JobsEnvelope | null): Map<string, number> {
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

/* ------------------------------------------------------------------ */
/* Reading the seam                                                    */
/* ------------------------------------------------------------------ */

export type SeamTone = "ink" | "pencil" | "amber" | "red";

export interface SeamReading {
  tone: SeamTone;
  /** One flat sentence — the mark's accessible name. */
  line: string;
}

export interface SeamInputs {
  tasks: DownloadTask[];
  jobsEnv: JobsEnvelope | null;
  status: ServerStatus | null;
  reachable: boolean;
  asOf: number | null;
  movedAt: Map<string, number>;
}

function isWeatherTask(t: DownloadTask): boolean {
  const errs = t.chapters.map((c) => c.error ?? "").join(" ");
  return t.status === "downloading" && /rate|429|too many|block|cloudflare/i.test(errs);
}

function stuckJobs(env: JobsEnvelope | null, movedAt: Map<string, number>): Job[] {
  if (!env) return [];
  return env.jobs.filter((jb) => {
    if (jb.state !== "running") return false;
    const at = movedAt.get(jb.id);
    return at != null && Date.now() - at > STUCK_AFTER_MS;
  });
}

/**
 * One reading for the whole app. Person outranks weather outranks work
 * outranks rest — the same triage as everywhere else.
 */
export function readSeam(s: SeamInputs): SeamReading {
  const jobs = s.jobsEnv?.jobs ?? [];

  // Red — a person is needed.
  const failedTasks = s.tasks.filter((t) => t.status === "failed").length;
  const redJobs = jobs.filter((jb) => jb.state === "failed" && !healsItself(jb.error)).length;
  const needsYou = failedTasks + redJobs;
  if (needsYou > 0)
    return {
      tone: "red",
      line: needsYou === 1 ? "One thing needs you." : `${needsYou} things need you.`,
    };

  // Amber — weather. It rights itself; the mark says so if you look.
  if (!s.reachable && s.asOf)
    return { tone: "amber", line: `The server stopped answering · showing as of ${clock(s.asOf)}.` };
  const stuck = stuckJobs(s.jobsEnv, s.movedAt);
  if (stuck.length > 0)
    return { tone: "amber", line: `${stuck[0]!.label} hasn't moved for a while · rights itself.` };
  if (s.status?.freshness?.behind)
    return { tone: "amber", line: "Scanning is running behind. The library is busy." };
  const amberJob = jobs.find((jb) => jb.state === "failed" && healsItself(jb.error));
  if (amberJob)
    return { tone: "amber", line: `${amberJob.label} didn't finish · tried again by itself.` };
  const weather = s.tasks.find(isWeatherTask);
  if (weather)
    return { tone: "amber", line: `${weather.sourceName} asked us to slow down · resumes itself.` };

  // Pencil — something is moving. A background scan deliberately does not
  // reach here: scheduler.md §3 gives it no ambient presence at all.
  const fetching = s.tasks.filter((t) => t.status === "downloading" || t.status === "queued").length;
  if (fetching > 0)
    return {
      tone: "pencil",
      line: fetching === 1 ? "Inking — one on its way." : `Inking — ${fetching} on their way.`,
    };
  const derived = jobs.filter(
    (jb) => jb.kind !== "scan" && (jb.state === "running" || jb.state === "queued"),
  ).length;
  if (derived > 0)
    return { tone: "pencil", line: "The server is tidying — art and covers. Nothing needs you." };

  // Ink — the resting state. Still a fact, so still a mark.
  return { tone: "ink", line: "All quiet. Nothing needs you." };
}

/* ------------------------------------------------------------------ */
/* The mark                                                            */
/* ------------------------------------------------------------------ */

const glyphFor: Record<SeamTone, GlyphState> = {
  ink: "server",
  pencil: "queued",
  amber: "waiting",
  red: "needs-you",
};

export function SeamMark({
  reading,
  open,
  onToggle,
}: {
  reading: SeamReading;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={`seam-mark seam-${reading.tone}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={reading.line}
      title={reading.line}
      onClick={onToggle}
    >
      <Glyph state={glyphFor[reading.tone]} title={reading.line} />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* The ledger                                                          */
/* ------------------------------------------------------------------ */

function jobVerb(jb: Job): string {
  return jb.kind === "scan" ? "Looking over" : jb.kind === "art" ? "Cutting art" : "Cutting a cover";
}

function farLine(t: DownloadTask): { text: string; tone: "quiet" | "pencil" | "red" } {
  const done = t.chapters.filter((c) => c.status === "completed").length;
  if (t.status === "failed")
    return {
      text: `${t.mangaTitle} stopped · the ${done} that landed are safe · ${timeAgo(t.updatedAt)}`,
      tone: "red",
    };
  if (t.status === "downloading")
    return {
      text: `Inking ${t.mangaTitle} from ${t.sourceName} · ${done} of ${t.chapters.length} chapters landed`,
      tone: "pencil",
    };
  return {
    text: `${t.mangaTitle} · queued · ${t.chapters.length} chapters from ${t.sourceName}`,
    tone: "pencil",
  };
}

/**
 * The ledger panel. Dated sentences only — no percentage, no ticking
 * number, no lever. It reads what App already holds and closes.
 */
export function Ledger({
  tasks,
  jobsEnv,
  status,
  reading,
  movedAt,
  asOf,
  onClose,
  onWorkbench,
}: {
  tasks: DownloadTask[];
  jobsEnv: JobsEnvelope | null;
  status: ServerStatus | null;
  reading: SeamReading;
  movedAt: Map<string, number>;
  asOf: number | null;
  onClose: () => void;
  onWorkbench: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Defer so the opening click doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const jobs = jobsEnv?.jobs ?? [];
  const live = tasks.filter(
    (t) => t.status === "downloading" || t.status === "queued" || t.status === "failed",
  );
  const running = jobs.filter((jb) => jb.state === "running");
  const queuedN = jobs.filter((jb) => jb.state === "queued").length;
  const failedJobs = jobs.filter((jb) => jb.state === "failed");
  const finished = jobs
    .filter((jb) => jb.state === "done" || jb.state === "cancelled")
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const last = finished[0];
  const stuckIds = new Set(stuckJobs(jobsEnv, movedAt).map((jb) => jb.id));
  const atRest = live.length === 0 && running.length === 0 && queuedN === 0 && failedJobs.length === 0;

  return (
    <div ref={ref} className="ledger" role="dialog" aria-label="What the server is doing">
      <p className={`ledger-head ledger-${reading.tone}`}>{reading.line}</p>

      {live.length > 0 && (
        <section className="ledger-sec">
          <h3>On its way</h3>
          {live.map((t) => {
            const l = farLine(t);
            return (
              <Line key={t.id} tone={l.tone}>
                {l.text}
              </Line>
            );
          })}
        </section>
      )}

      {(running.length > 0 || queuedN > 0 || failedJobs.length > 0) && (
        <section className="ledger-sec">
          <h3>In the background</h3>
          {failedJobs.map((jb) => (
            <Line key={jb.id} tone={healsItself(jb.error) ? "amber" : "red"}>
              {healsItself(jb.error)
                ? `${jb.label} didn't finish — it will be tried again by itself.`
                : `${jb.label} stopped — needs a look. Nothing on your shelf was touched.`}
            </Line>
          ))}
          {running.map((jb) => (
            <Line key={jb.id} tone={stuckIds.has(jb.id) ? "amber" : "quiet"}>
              {jobVerb(jb)} · {jb.label}
              {jb.startedAt ? ` · started ${timeAgo(jb.startedAt)}` : ""}
              {stuckIds.has(jb.id) ? ` · nothing has moved since ${clock(movedAt.get(jb.id)!)}` : ""}
            </Line>
          ))}
          {queuedN > 0 && (
            <Line tone="quiet">
              {queuedN} more waiting {running.length > 0 ? "behind it" : "their turn"}.
            </Line>
          )}
        </section>
      )}

      {atRest && (
        <section className="ledger-sec">
          <Line tone="quiet">
            Nothing is happening.
            {last?.finishedAt
              ? ` Last finished: ${last.label} · ${timeAgo(last.finishedAt)}.`
              : ""}
          </Line>
        </section>
      )}

      {status && (
        <section className="ledger-sec">
          <h3>The library</h3>
          <Line tone="quiet">
            {status.library.series} series · {status.library.chapters.toLocaleString("en-US")}{" "}
            chapters · last looked over {timeAgo(status.library.lastScan) || "never"}
          </Line>
          {status.freshness?.behind && (
            <Line tone="amber">Scanning is running behind. The library is busy.</Line>
          )}
        </section>
      )}

      <footer className="ledger-foot">
        <button className="linkish" onClick={onWorkbench}>
          Levers live in the workbench
        </button>
        {asOf && <span className="cap">as of {clock(asOf)}</span>}
      </footer>
    </div>
  );
}
