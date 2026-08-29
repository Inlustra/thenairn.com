// In-memory adapters. Reference implementations of every port, and the ones
// the tests and the demo run against.
//
// These are the whole proof that the engine is platform-agnostic: the engine
// runs unchanged against these, and a React Native app swaps in AsyncStorage,
// a filesystem and fetch without the engine noticing.

import type { Bytes, Clock, ContentStore, DeviceConditions, Logger, StateStore, SyncEvent } from "./ports";
import { StorageFullError } from "./ports";
import type { HeldChapter, PageRecord } from "./types";

/** Time is an input. Nothing in the engine reads a wall clock. */
export class ManualClock implements Clock {
  constructor(private t = 0) {}
  now(): number { return this.t; }
  /** Sleeping is instantaneous and merely advances the injected clock. */
  async sleep(ms: number): Promise<void> { this.t += ms; }
  advance(ms: number): void { this.t += ms; }
  set(ms: number): void { this.t = ms; }
}

export class MemoryStateStore implements StateStore {
  private v: string | null = null;
  writes = 0;
  async load(): Promise<string | null> { return this.v; }
  async save(s: string): Promise<void> { this.v = s; this.writes++; }
  /** Simulate a process death: state survives, in-memory engine objects do not. */
  snapshot(): string | null { return this.v; }
}

export interface MemoryContentOptions {
  /** Finite by default, so eviction is actually exercised. */
  capacityBytes?: number;
}

/**
 * The device's storage.
 *
 * Staged and held are separate maps on purpose. `commit` is the only path from
 * one to the other, and it is a single assignment -- the in-memory stand-in for
 * the rename the real thing will do.
 */
export class MemoryContentStore implements ContentStore {
  private capacity: number;
  private staged = new Map<string, Map<string, { page: PageRecord; bytes: Bytes }>>();
  private held = new Map<string, HeldChapter>();
  /** Space consumed by something other than us. Set to fake a full device. */
  foreignBytes = 0;

  constructor(opts: MemoryContentOptions = {}) {
    this.capacity = opts.capacityBytes ?? Number.MAX_SAFE_INTEGER;
  }

  setCapacity(bytes: number) { this.capacity = bytes; }
  async capacityBytes(): Promise<number> { return this.capacity; }

  async usedBytes(): Promise<number> {
    let n = this.foreignBytes;
    for (const c of this.staged.values()) for (const e of c.values()) n += e.bytes.length;
    for (const h of this.held.values()) n += h.bytes;
    return n;
  }

  async putStaged(chapterId: string, page: PageRecord, bytes: Bytes): Promise<void> {
    const used = await this.usedBytes();
    if (used + bytes.length > this.capacity) throw new StorageFullError(bytes.length, this.capacity - used);
    const c = this.staged.get(chapterId) ?? new Map();
    c.set(page.id, { page, bytes });
    this.staged.set(chapterId, c);
  }

  async listStaged(chapterId: string): Promise<PageRecord[]> {
    return [...(this.staged.get(chapterId)?.values() ?? [])].map((e) => e.page);
  }

  async stagedChapters(): Promise<string[]> { return [...this.staged.keys()]; }

  async discardStaged(chapterId: string): Promise<void> { this.staged.delete(chapterId); }

  async commit(record: HeldChapter): Promise<void> {
    this.held.set(record.chapterId, record);
    this.staged.delete(record.chapterId);
  }

  async listHeld(): Promise<HeldChapter[]> { return [...this.held.values()]; }

  async remove(chapterId: string): Promise<void> {
    this.held.delete(chapterId);
    this.staged.delete(chapterId);
  }

  // ---- inspection, for tests -------------------------------------------------

  /** Bytes physically present for a chapter, staged or held. */
  bytesFor(chapterId: string): number {
    const h = this.held.get(chapterId);
    if (h) return h.bytes;
    let n = 0;
    for (const e of this.staged.get(chapterId)?.values() ?? []) n += e.bytes.length;
    return n;
  }

  stagedCount(chapterId: string): number { return this.staged.get(chapterId)?.size ?? 0; }
  heldIds(): string[] { return [...this.held.keys()]; }
}

export class ArrayLogger implements Logger {
  readonly events: SyncEvent[] = [];
  emit(e: SyncEvent): void { this.events.push(e); }
  of<K extends SyncEvent["t"]>(t: K): Array<Extract<SyncEvent, { t: K }>> {
    return this.events.filter((e) => e.t === t) as Array<Extract<SyncEvent, { t: K }>>;
  }
  clear() { this.events.length = 0; }
}

export class StaticConditions implements DeviceConditions {
  constructor(public wifi = true, public power = true) {}
  unmetered(): boolean { return this.wifi; }
  charging(): boolean { return this.power; }
}
