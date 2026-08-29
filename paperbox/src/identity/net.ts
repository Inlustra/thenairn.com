/**
 * Being a good guest on somebody else's free API.
 *
 * Three properties, and they are the whole file:
 *
 * **Serialised, with a floor between calls.** One request in flight per
 * provider, and at least `minIntervalMs` between the *start* of one and the
 * next. Not a token bucket — a bucket permits a burst, and a burst is exactly
 * what gets an unauthenticated client blocked. Identification of a cold library
 * is naturally bursty (12 series × 4 calls), so the floor is the thing that
 * matters.
 *
 * **Cached by URL+body, with a TTL per call kind.** A card does not change
 * between two page loads. Without this, a client that re-renders re-asks, and
 * the API sees us hammering it for answers we already had.
 *
 * **Nothing here is ever reached by a render.** `GET /api/identity` and
 * `/api/identity/:id` read stored bindings and never construct a Fetcher. Only
 * an explicit identify or search does. That is the "never poll on render" rule
 * from the brief, enforced by where this module is imported rather than by
 * discipline.
 */

interface CacheEntry {
  at: number;
  ttl: number;
  value: unknown;
}

export class Fetcher {
  private queue: Promise<unknown> = Promise.resolve();
  private lastStart = 0;
  private cache = new Map<string, CacheEntry>();
  /** Requests actually sent, for the diagnosis surface and for tests. */
  calls = 0;
  /** Cache hits — the number that proves the politeness is working. */
  hits = 0;

  constructor(
    private minIntervalMs = 1000,
    private timeoutMs = 15000,
  ) {}

  /**
   * Serialise + throttle + cache one JSON call.
   *
   * `key` is what the cache is keyed on, so a POST search must fold its body
   * into the key. Caller's job, because only the caller knows what varies.
   */
  json<T>(key: string, ttlMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) {
      this.hits++;
      return Promise.resolve(hit.value as T);
    }
    const next = this.queue.then(
      () => this.execute(key, ttlMs, run),
      () => this.execute(key, ttlMs, run),
    );
    // The chain must not break on a rejection, or one failed lookup wedges
    // every later one behind a permanently rejected promise.
    this.queue = next.catch(() => {});
    return next;
  }

  private async execute<T>(key: string, ttlMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const wait = this.minIntervalMs - (Date.now() - this.lastStart);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastStart = Date.now();
    this.calls++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const value = await run(ctl.signal);
      this.cache.set(key, { at: Date.now(), ttl: ttlMs, value });
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** How long an answer stays good. Deliberately long — none of this is live. */
export const TTL = {
  /** A search for a phrase. Long enough that retyping costs nothing. */
  search: 10 * 60_000,
  /** A registry card. A chapter count moves on the scale of days, not minutes. */
  card: 24 * 3600_000,
} as const;
