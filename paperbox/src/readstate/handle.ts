/**
 * The process-wide read-state handle.
 *
 * Separate from index.ts so that modules which need the handle (the compat
 * adapter) can import it without importing everything index.ts re-exports.
 */
import { ReadStateStore } from "./store";
import { dbPathNote } from "./schema";

/**
 * Null until something opens one.
 *
 * The compat routes degrade to their old behaviour when there is no store --
 * `isRead: false` everywhere -- rather than failing a request. Losing a read
 * marker is annoying; a chapter list that 500s is a library that will not open.
 */
let store: ReadStateStore | null = null;

export function getReadState(): ReadStateStore | null {
  return store;
}

/** Tests and the bench supply their own. Returns the previous handle. */
export function configureReadState(next: ReadStateStore | null): ReadStateStore | null {
  const prev = store;
  store = next;
  return prev;
}

/**
 * Open the store for a running server.
 *
 * `READSTATE_DB` is required rather than defaulted, on purpose. This is the
 * first table that cannot be rebuilt by rescanning, and the container currently
 * mounts no state volume at all -- so any default this function invented would
 * be a path that a `--force-recreate` deletes, chosen by a module rather than
 * by whoever has to restore it. Unset means read state is not persisted, said
 * out loud at boot, which is a visible gap rather than a silent one.
 */
export function initReadState(): ReadStateStore | null {
  const path = process.env.READSTATE_DB;
  if (!path) {
    console.warn(`[readstate] READSTATE_DB is not set — read state will not be persisted. ${dbPathNote}`);
    return null;
  }
  try {
    store = new ReadStateStore(path);
    console.log(`[readstate] open at ${path}`);
  } catch (e) {
    console.error(`[readstate] could not open ${path}; read state is disabled for this run`, e);
    store = null;
  }
  return store;
}
