/**
 * Shared helpers for the web client. No React in here.
 */

import type { Job, JobsEnvelope } from "./api/contract";

export const API = "/api";

/** A non-2xx answer, with the status kept so callers can tell 404 apart. */
export class HttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "HttpError";
  }
}

/** JSON fetch that throws on non-2xx with the server's own error line. */
export async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError((d as any)?.error || `HTTP ${r.status}`, r.status);
  return d as T;
}

/**
 * Conditional JSON fetch on a weak ETag. Sends If-None-Match with the last
 * tag seen for this URL; a 304 hands back the cached body, so polling an
 * unchanged envelope costs only the header exchange.
 */
const etagCache = new Map<string, { etag: string; body: unknown }>();
export async function jTagged<T>(url: string): Promise<T> {
  const prev = etagCache.get(url);
  const r = await fetch(url, prev ? { headers: { "If-None-Match": prev.etag } } : undefined);
  if (r.status === 304 && prev) return prev.body as T;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError((d as any)?.error || `HTTP ${r.status}`, r.status);
  const etag = r.headers.get("ETag");
  if (etag) etagCache.set(url, { etag, body: d });
  return d as T;
}

export const post = <T = unknown>(url: string, body?: unknown): Promise<T> =>
  j<T>(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

export const patch = <T = unknown>(url: string, body: unknown): Promise<T> =>
  j<T>(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const del = <T = unknown>(url: string): Promise<T> => j<T>(url, { method: "DELETE" });

/** localStorage with a safety wrapper — absence must never throw. */
export const store = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* full or unavailable — a convenience, not a store of record */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
  keys(prefix: string): string[] {
    try {
      const out: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) out.push(k);
      }
      return out;
    } catch {
      return [];
    }
  },
};

/** "3 min ago" — used for dated sentences, never for estimates. */
export function timeAgo(t?: number | string | null): string {
  if (!t) return "";
  const ms = Date.now() - new Date(t).getTime();
  if (ms < 0 || isNaN(ms)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 32) return `${d}d ago`;
  const mo = Math.floor(d / 30.4);
  if (mo < 12) return `${mo} months ago`;
  return `${Math.floor(d / 365.25)} years ago`;
}

/** Clock time for "as of" stamps. */
export function clock(t: number): string {
  const d = new Date(t);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function dateStamp(t: number): string {
  const d = new Date(t);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return clock(t);
  return d.toLocaleDateString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export const fmt = (n: number) => n.toLocaleString("en-US");

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

export function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Spine width from page count: 12px + 2.2√pages, floored 21, capped 44. */
export function spineWidth(pages: number): number {
  return Math.min(44, Math.max(21, Math.round(12 + 2.2 * Math.sqrt(Math.max(1, pages)))));
}

/* ------------------------------------------------------------------ */
/* Derived work — matching jobs to the book they belong to             */
/* ------------------------------------------------------------------ */

/** Amber when the trouble reads as weather; red means a person is needed. */
export function healsItself(error: string | null): boolean {
  return /rate|429|too many|block|cloudflare|timeout|timed out|temporar|busy|502|503|connection|network/i.test(
    error ?? "",
  );
}

/**
 * A job as a subject the user recognises. Job labels are series titles,
 * so a bare label reads as the series doing something — "Omniscient
 * Reader stopped" — when it is the artwork that stopped. Say whose
 * artwork it is instead.
 */
export function jobPhrase(jb: Job): string {
  const label = (jb.label ?? "").trim();
  if (jb.kind === "art") return label ? `Artwork for ${label}` : "Artwork";
  if (jb.kind === "cover") return label ? `The cover for ${label}` : "A cover";
  return label || "Looking through the library";
}

export type DerivedWork =
  | { kind: "red"; job: Job }
  | { kind: "amber"; job: Job }
  | { kind: "running"; job: Job }
  | { kind: "queued"; n: number }
  | null;

/**
 * What derived work (art, covers — never the scan, which is freshness and
 * has its own stamp) stands against one series. Failure outranks progress:
 * a person-needed failure first, then self-healing weather, then running,
 * then queued. Null is the resting state and renders as silence.
 *
 * `includeLibraryWide` folds in scope-null jobs — a library-wide art pass
 * genuinely covers this series, so the series screen and the shelf count
 * it. Library *cards* do not: attributing one library-wide row to every
 * card would caption the whole shelf at once, and a library at rest (or
 * mid-housekeeping) must not look busy.
 */
export function derivedWorkFor(
  env: JobsEnvelope | null,
  seriesUid: string,
  includeLibraryWide: boolean,
): DerivedWork {
  if (!env) return null;
  const mine = env.jobs.filter(
    (jb) =>
      jb.kind !== "scan" &&
      (jb.scope === seriesUid || (includeLibraryWide && jb.scope === null)),
  );
  const failed = mine.filter((jb) => jb.state === "failed");
  const person = failed.find((jb) => !healsItself(jb.error));
  if (person) return { kind: "red", job: person };
  if (failed.length > 0) return { kind: "amber", job: failed[0]! };
  const running = mine.find((jb) => jb.state === "running");
  if (running) return { kind: "running", job: running };
  const queued = mine.filter((jb) => jb.state === "queued").length;
  if (queued > 0) return { kind: "queued", n: queued };
  return null;
}
