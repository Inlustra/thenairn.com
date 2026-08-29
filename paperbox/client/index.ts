// The client sync engine. Pure TypeScript: no DOM, no Node, no React.
//
// Drop this directory into a React Native app, a web client or a test process
// and supply five adapters (SyncTransport, ContentStore, StateStore, Clock and
// optionally DeviceConditions). `client/memory.ts` implements all of them, and
// is what the tests and the demo run against.
//
// See docs/client-sync.md for the state machine and the failure modes.

export { SyncEngine } from "./engine";
export type { EngineDeps, EngineState, EvictionPolicy, TickResult } from "./engine";

export { evaluate, retire, approxNumber } from "./rules";
export type { EvalInput } from "./rules";

export { buildPlan, estimatePageBytes, freeable } from "./plan";
export type { PlanInput } from "./plan";

export { applyDiff, blockStartOf, chaptersInOrder, countChapters, dropForTreeVersion, emptyCatalog } from "./catalog";
export type { CatalogUpdate } from "./catalog";

export { NetworkError, ServerError, StorageFullError, silentLogger } from "./ports";
export type {
  Bytes, Clock, ContentStore, DeviceConditions, FetchedImage, Logger, StateStore, SyncEvent, SyncTransport,
} from "./ports";

export { ArrayLogger, ManualClock, MemoryContentStore, MemoryStateStore, StaticConditions } from "./memory";

export type * from "./types";
