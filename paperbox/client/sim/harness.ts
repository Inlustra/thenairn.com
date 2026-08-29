// One call that wires a whole fake world together.

import { SyncEngine } from "../engine";
import type { EvictionPolicy } from "../engine";
import { ArrayLogger, ManualClock, MemoryContentStore, MemoryStateStore, StaticConditions } from "../memory";
import type { Rule } from "../types";
import { SimLibrary } from "./library";
import { buildLibrary, SimTransport } from "./server";
import type { NetworkConditions } from "./server";

export interface WorldOptions {
  library?: SimLibrary;
  capacityBytes?: number;
  network?: NetworkConditions;
  policy?: EvictionPolicy;
  rules?: Rule[];
  reserveBytes?: number;
  wifi?: boolean;
  charging?: boolean;
  backoff?: number[];
}

export interface World {
  lib: SimLibrary;
  net: SimTransport;
  content: MemoryContentStore;
  state: MemoryStateStore;
  clock: ManualClock;
  log: ArrayLogger;
  conditions: StaticConditions;
  engine: SyncEngine;
  /** Rebuild the engine over the same durable stores: a process restart. */
  restart(): SyncEngine;
}

export function makeWorld(opts: WorldOptions = {}): World {
  const lib = opts.library ?? buildLibrary();
  const clock = new ManualClock(1_700_000_000_000);
  const net = new SimTransport(lib, clock, opts.network ?? {});
  const content = new MemoryContentStore({ capacityBytes: opts.capacityBytes });
  const state = new MemoryStateStore();
  const log = new ArrayLogger();
  const conditions = new StaticConditions(opts.wifi ?? true, opts.charging ?? true);

  const build = () => new SyncEngine({
    transport: net, content, state, clock, logger: log, conditions,
    policy: opts.policy, reserveBytes: opts.reserveBytes,
    backoff: opts.backoff ?? [1_000, 2_000, 4_000],
  });

  const world: World = {
    lib, net, content, state, clock, log, conditions,
    engine: build(),
    restart: () => (world.engine = build()),
  };
  return world;
}

/**
 * Run to settlement, walking the clock past any backoff.
 *
 * `patience` is how many offline waits we will sit through before giving up.
 * Deterministic: the clock only moves because this function moves it.
 */
export async function settle(world: World, patience = 20): Promise<void> {
  for (let i = 0; i < patience; i++) {
    const r = await world.engine.run();
    if (r.state === "offline" && r.waitMs) { world.clock.advance(r.waitMs); continue; }
    return;
  }
}
