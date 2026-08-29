// The fake server, and the weather between it and the device.
//
// It speaks the real `/api/sync/*` contract over a SimLibrary you can mutate
// mid-run, and it can be made to behave badly in the four ways that actually
// happen on a phone: gone, flaky, slow, and dead halfway through a body.

import { NetworkError, ServerError } from "../ports";
import type { Bytes, Clock, FetchedImage, SyncTransport } from "../ports";
import type { DiffReply, DiffRequest, TreeReply } from "../types";
import { SimLibrary } from "./library";

export interface NetworkConditions {
  mode?: "online" | "offline";
  /** 0..1. Deterministic: driven by the seeded PRNG, never Math.random. */
  failureRate?: number;
  /** Advances the injected clock on every request. Slow, without being slow. */
  latencyMs?: number;
  /** After N image bodies, every request fails. The server fell over. */
  dieAfterImages?: number;
  /** Deliver short bodies. The server died halfway through writing one. */
  truncateImages?: boolean;
  seed?: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TransportStats {
  treeCalls: number;
  diffCalls: number;
  imageCalls: number;
  /** Bytes actually delivered. The number scenario 1 is an assertion about. */
  bytesDelivered: number;
  failures: number;
  /** url -> how many times it was fetched. >1 anywhere means work was repeated. */
  perUrl: Map<string, number>;
}

export class SimTransport implements SyncTransport {
  readonly stats: TransportStats = {
    treeCalls: 0, diffCalls: 0, imageCalls: 0, bytesDelivered: 0, failures: 0, perUrl: new Map(),
  };
  private rng: () => number;
  private imagesServed = 0;
  private lastEtag = "";

  constructor(
    readonly lib: SimLibrary,
    private clock: Clock,
    public conditions: NetworkConditions = {},
  ) {
    this.rng = mulberry32(conditions.seed ?? 1);
  }

  set(conditions: Partial<NetworkConditions>) {
    this.conditions = { ...this.conditions, ...conditions };
    if (conditions.seed !== undefined) this.rng = mulberry32(conditions.seed);
  }

  goOffline() { this.conditions.mode = "offline"; }
  goOnline() { this.conditions.mode = "online"; }
  /** Bring a dead server back without resetting anything else. */
  revive() { this.imagesServed = 0; this.conditions.dieAfterImages = undefined; this.conditions.truncateImages = false; }

  private gate(what: string) {
    const c = this.conditions;
    if (c.latencyMs) this.clock.sleep(c.latencyMs);
    if (c.mode === "offline") { this.stats.failures++; throw new NetworkError(`offline (${what})`, "offline"); }
    if (c.dieAfterImages !== undefined && this.imagesServed >= c.dieAfterImages) {
      this.stats.failures++;
      throw new NetworkError(`server stopped answering (${what})`, "refused");
    }
    if (c.failureRate && this.rng() < c.failureRate) {
      this.stats.failures++;
      throw new NetworkError(`connection dropped (${what})`, "timeout");
    }
  }

  async tree(etag?: string): Promise<{ status: 200; body: TreeReply; etag?: string } | { status: 304 }> {
    this.gate("tree");
    this.stats.treeCalls++;
    const body = this.lib.tree();
    // The node hash IS the ETag, exactly as the real route does it.
    const tag = `W/"${body.root}"`;
    this.lastEtag = tag;
    if (etag && etag === tag) return { status: 304 };
    return { status: 200, body, etag: tag };
  }

  async diff(req: DiffRequest): Promise<DiffReply> {
    this.gate("diff");
    this.stats.diffCalls++;
    return this.lib.diff(req);
  }

  async image(url: string): Promise<FetchedImage> {
    this.gate("image");
    const size = this.lib.imageSize(url);
    if (size === undefined) throw new ServerError(`no such image: ${url}`, 404);
    this.stats.imageCalls++;
    this.stats.perUrl.set(url, (this.stats.perUrl.get(url) ?? 0) + 1);
    this.imagesServed++;

    const delivered = this.conditions.truncateImages ? Math.max(0, Math.floor(size / 2)) : size;
    this.stats.bytesDelivered += delivered;
    // Deterministic filler. Content is never inspected; only its length is.
    const bytes: Bytes = new Uint8Array(delivered);
    for (let i = 0; i < delivered; i += 997) bytes[i] = i & 0xff;
    return { bytes, length: delivered };
  }

  /** Every url fetched more than once. Empty is the assertion worth making. */
  refetched(): string[] {
    return [...this.stats.perUrl].filter(([, n]) => n > 1).map(([u]) => u);
  }

  etagNow(): string { return this.lastEtag; }
}

// ---------------------------------------------------------------------------

/** A library with a shape worth testing against, built deterministically. */
export function buildLibrary(opts: { seed?: number } = {}): SimLibrary {
  const lib = new SimLibrary();
  const rng = mulberry32(opts.seed ?? 7);
  const pages = (n: number, base = 100_000) =>
    Array.from({ length: n }, (_, i) => ({
      file: `${String(i + 1).padStart(3, "0")}.jpg`,
      size: base + Math.floor(rng() * 40_000),
    }));

  lib.addSeries("nano", "Nano Machine");
  for (let n = 1; n <= 30; n++) lib.addChapter("nano", { uid: `nano-${n}`, sortKey: n, pages: pages(8) });

  lib.addSeries("solo", "Solo Leveling");
  // Opens at chapter 0 -- a real case in four of the twelve live series, and
  // the one that used to be filed as "unnumbered".
  for (let n = 0; n <= 12; n++) lib.addChapter("solo", { uid: `solo-${n}`, sortKey: n, pages: pages(6) });

  lib.addSeries("orv", "Omniscient Reader's Viewpoint");
  for (let n = 20; n <= 32; n++) lib.addChapter("orv", { uid: `orv-${n}`, sortKey: n, pages: pages(5) });
  // A ranged directory across the 1-25 / 26-50 boundary.
  lib.addChapter("orv", {
    uid: "orv-24-27", sortKey: 24, sortKeyEnd: 27, title: "Chapter 24-27", pages: pages(14),
  });

  lib.addSeries("wh40k", "Warhammer 40,000");
  lib.addChapter("wh40k", {
    uid: "wh40k-full", sortKey: 0, mark: "", title: "Warhammer 40,000 Full", pages: pages(20),
  });

  return lib;
}
