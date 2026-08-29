// The adapter interfaces. Everything platform-specific enters the engine
// through one of these and nowhere else.
//
// The rule that keeps this honest: `grep -rn "from \"node:\|require(\|window\.\|
// react" client/*.ts` must return nothing outside `sim/`. There is no import in
// this directory that a React Native bundler cannot resolve.

import type { DiffReply, DiffRequest, HeldChapter, PageRecord, TreeReply } from "./types";

/** Bytes, in the one representation every JS runtime agrees on. */
export type Bytes = Uint8Array;

// ---------------------------------------------------------------------------

export interface Clock {
  /** Milliseconds. Injected so tests never touch the wall clock. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

// ---------------------------------------------------------------------------

/** The one error type the engine treats as "the network, not the server". */
export class NetworkError extends Error {
  override readonly name = "NetworkError";
  constructor(message: string, readonly kind: "offline" | "timeout" | "truncated" | "refused" = "offline") {
    super(message);
  }
}

/** The server answered, and said no. */
export class ServerError extends Error {
  override readonly name = "ServerError";
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface FetchedImage {
  bytes: Bytes;
  /** What the transport actually delivered. Compared against ImageRef.size. */
  length: number;
}

/**
 * The near lane's whole surface: three calls.
 *
 * `tree` carries an ETag because the server's node hash *is* its ETag, so the
 * cheapest possible "has anything moved" costs a 304 and no body.
 */
export interface SyncTransport {
  tree(etag?: string): Promise<{ status: 200; body: TreeReply; etag?: string } | { status: 304 }>;
  diff(req: DiffRequest): Promise<DiffReply>;
  image(url: string): Promise<FetchedImage>;
}

// ---------------------------------------------------------------------------

/** Raised by a ContentStore that cannot accept another byte. */
export class StorageFullError extends Error {
  override readonly name = "StorageFullError";
  constructor(readonly needed: number, readonly free: number) {
    super(`storage full: needed ${needed} bytes, ${free} free`);
  }
}

/**
 * Durable content. The only thing that makes a chapter *held* is `commit`.
 *
 * Staged pages are deliberately visible (`listStaged`) and deliberately not
 * held: a process killed mid-chapter comes back with pages on disk and no
 * chapter in the library, which is the invariant scenario 7 exists to protect.
 * Mirrors the server's own "downloads stage then swap".
 */
export interface ContentStore {
  capacityBytes(): Promise<number>;
  usedBytes(): Promise<number>;

  putStaged(chapterId: string, page: PageRecord, bytes: Bytes): Promise<void>;
  listStaged(chapterId: string): Promise<PageRecord[]>;
  /** Every chapter with staged pages, held or not. */
  stagedChapters(): Promise<string[]>;
  discardStaged(chapterId: string): Promise<void>;

  /** Atomic. After this returns the chapter is held; before it, it is not. */
  commit(record: HeldChapter): Promise<void>;
  listHeld(): Promise<HeldChapter[]>;
  remove(chapterId: string): Promise<void>;
}

// ---------------------------------------------------------------------------

/**
 * Small durable state: the `have` set, the catalog, rules, read marks, the
 * plan in flight. Written whole; the caller decides how to make that atomic.
 */
export interface StateStore {
  load(): Promise<string | null>;
  save(serialised: string): Promise<void>;
}

// ---------------------------------------------------------------------------

/** What only the device knows. Rule conditions read this and nothing else. */
export interface DeviceConditions {
  unmetered(): boolean;
  charging(): boolean;
}

// ---------------------------------------------------------------------------

export type SyncEvent =
  | { t: "state"; from: string; to: string; why?: string }
  | { t: "checked"; root: string; moved: boolean; treeVersion: number }
  | { t: "treeVersionChanged"; from: number; to: number }
  | { t: "catalog"; series: number; chapters: number; pruned: number }
  | { t: "target"; want: number; released: number; contested: number }
  | { t: "plan"; fetch: number; bytes: number; evictable: number }
  | { t: "planStale"; builtAgainst: string; now: string }
  | { t: "resolve"; chapterId: string; images: number; skippedIdentical: number }
  | { t: "page"; chapterId: string; file: string; bytes: number }
  | { t: "commit"; chapterId: string; pages: number; bytes: number }
  | { t: "staged"; chapterId: string; pages: number; why: string }
  | { t: "evict"; chapterId: string; bytes: number; reason: string }
  | { t: "vanished"; chapterId: string }
  | { t: "offline"; retryInMs: number }
  | { t: "blocked"; why: string }
  | { t: "note"; text: string };

export interface Logger {
  emit(e: SyncEvent): void;
}

export const silentLogger: Logger = { emit() {} };
