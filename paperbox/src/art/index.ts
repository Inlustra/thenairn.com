/**
 * Derived artefacts: covers, spine art, dominant colour.
 *
 * One pipeline, one store, one invalidation rule. See `store.ts` for why the
 * store lives outside the library and why a stale artefact is unaddressable
 * rather than merely detectable.
 */
export { ART_VERSION } from "./version";
export { artKey, artPath, derivedDir, find, has, put, readJson } from "./store";
export type { ArtKind, StoredArt } from "./store";
export { extractSpine, ensureSpine, spineKey, candidatePages, SPINE_W, SPINE_H } from "./spine";
export type { Tint, SpineResult, SpineWriteResult } from "./spine";
export { ensureCover, adoptCoverBytes, coverKey, resolveCoverSource } from "./cover";
export type { CoverSource, CoverWriteResult } from "./cover";
