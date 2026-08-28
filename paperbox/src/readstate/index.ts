/**
 * Read state: the store, the window rule, and the process-wide handle the
 * routes use.
 *
 * See schema.ts for why rows are keyed by reader, and resolver.ts for why the
 * window has three states and defaults to `next`.
 */
export { ReadStateStore, DEFAULT_READER, classify, assertOutsideLibrary } from "./store";
export type { Progress, ProgressWrite, ReadState } from "./store";
export {
  resolveWindow,
  fromStore,
  fromMap,
  compareChapters,
  ruleSentence,
} from "./resolver";
export type { ChapterRef, RuleInput, RuleResult, WindowMode, ResolveDeps } from "./resolver";
export { importLibrary, importSeries } from "./import";
export type { SeriesChapters, ImportReport } from "./import";
export { dbPathNote, READSTATE_SCHEMA_VERSION } from "./schema";
export { getReadState, configureReadState, initReadState } from "./handle";
export { recordChapterPatch, seriesProgress, unreadCount, chapterReadFields } from "./compat";
export type { ChapterPatch } from "./compat";
