// Wire types and engine types for the client sync engine.
//
// PURE TYPESCRIPT. Nothing in `client/` may import from `src/`, from `node:`,
// from the DOM, or from React. The wire types below are hand-mirrored from
// `src/hashes.ts` on purpose: importing them would drag the server's Bun
// crypto, `fs/promises` and Elysia into a React Native bundle. They are a
// contract, and a contract copied deliberately is safer than one imported
// accidentally. `client/wire.test.ts` asserts the shapes still line up.

// ---------------------------------------------------------------------------
// Wire: what the server says
// ---------------------------------------------------------------------------

export type NodeKind = "root" | "series" | "block" | "chapter" | "page";

/** One entry of the `have` set the client sends. */
export interface HaveEntry {
  id: string;
  hash: string;
}

export interface ImageRef {
  id: string;
  chapterId: string;
  file: string;
  size: number;
  url: string;
  hash: string;
}

export interface NodeSummary {
  id: string;
  kind: NodeKind;
  hash: string;
  n: number;
  label: string;
  state: "added" | "modified";
}

export interface DiffRequest {
  have?: HaveEntry[];
  /** 1 series, 2 blocks, 3 chapters, 4 pages. Ignored when resolve=pages. */
  depth?: number;
  resolve?: "nodes" | "pages";
  scope?: string;
  after?: string;
}

export interface DiffReply {
  root: string;
  treeVersion: number;
  changed: NodeSummary[];
  images: ImageRef[];
  gone: string[];
  truncated: boolean;
  nextCursor?: string;
}

export interface TreeReply {
  root: string;
  treeVersion: number;
  blockSize: number;
  children: Array<{ id: string; kind: NodeKind; hash: string; n: number; label: string }>;
}

// ---------------------------------------------------------------------------
// Catalog: the client's mirror of what exists, down to chapter level
// ---------------------------------------------------------------------------

export interface CatalogChapter {
  id: string;
  seriesId: string;
  /** Every block this chapter hangs under. A ranged chapter spans several. */
  blockIds: string[];
  label: string;
  hash: string;
  pageCount: number;
  /** Position within the series, by tree order. Ordering only, never identity. */
  order: number;
  /** Lower bound of the first block this chapter is filed in. 0 = unnumbered. */
  blockStart: number;
}

export interface CatalogSeries {
  id: string;
  label: string;
  hash: string;
  chapters: Map<string, CatalogChapter>;
}

export interface Catalog {
  root: string;
  treeVersion: number;
  series: Map<string, CatalogSeries>;
  /** blockId -> its declared child count, so partial coverage is detectable. */
  blockArity: Map<string, number>;
  /** blockId -> hash, as last seen. */
  blockHash: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Held state: what this device actually has
// ---------------------------------------------------------------------------

export interface PageRecord {
  id: string;
  file: string;
  size: number;
  hash: string;
}

export interface HeldChapter {
  chapterId: string;
  seriesId: string;
  /** The chapter hash this content was committed against. */
  hash: string;
  pages: PageRecord[];
  bytes: number;
  completedAt: number;
}

/** Client-side read state. The server has none and is not asked for any. */
export type ReadMark = "unread" | "part" | "read";

export interface ReadRecord {
  chapterId: string;
  mark: ReadMark;
  /** Furthest page reached. Merges furthest-wins. */
  page: number;
  at: number;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type RuleScope =
  /** One chapter. The imperative "get this" is this scope with lifetime "once". */
  | { kind: "chapter"; seriesId: string; chapterId: string }
  /** An inclusive chapter-number range, resolved against block labels + order. */
  | { kind: "range"; seriesId: string; from: number; to: number }
  /** A whole series. */
  | { kind: "series"; seriesId: string }
  /** Several series named together. */
  | { kind: "collection"; seriesIds: string[] }
  /** The next N unread, in reading order. Needs read state; we have it locally. */
  | { kind: "unreadWindow"; seriesId: string; count: number }
  /** The N most recent chapters, read or not. */
  | { kind: "latest"; seriesId: string; count: number };

/** What happens to a chapter this rule wanted, once it is held. */
export type Retention =
  /** Never evicted, for any reason. Storage pressure blocks instead. */
  | { kind: "pin" }
  /** Held, but evictable under pressure, lowest priority first. */
  | { kind: "keep" }
  /** Dropped from the target set once fully read. */
  | { kind: "deleteWhenRead" }
  /** Read chapters stay in the target set, but only the last N. */
  | { kind: "keepLastRead"; count: number };

export interface RuleConditions {
  requiresUnmetered?: boolean;
  requiresCharging?: boolean;
}

export interface Rule {
  id: string;
  label: string;
  scope: RuleScope;
  retention: Retention;
  /** Higher wins a disagreement outright. */
  priority: number;
  /**
   * "An imperative action is a rule with a lifetime of one evaluation."
   * A `once` rule is retired after the evaluation in which it was satisfied.
   */
  lifetime: "standing" | "once";
  enabled?: boolean;
  conditions?: RuleConditions;
}

/** What the rule set resolved to, for one chapter. */
export interface Verdict {
  chapterId: string;
  seriesId: string;
  retention: Retention;
  priority: number;
  /** The rule that won. */
  decidedBy: string;
  /** Every rule that had an opinion, winner first. For "why is this here?". */
  contributors: string[];
  /** True when at least two enabled rules disagreed about holding it. */
  contested: boolean;
}

export interface TargetSet {
  /** chapterId -> verdict, for every chapter the rules say to hold. */
  want: Map<string, Verdict>;
  /**
   * Chapters a rule explicitly released (deleteWhenRead fired, window rolled
   * past). Named so the UI can say why, and kept distinct from "no rule ever
   * mentioned it".
   */
  released: Map<string, { chapterId: string; seriesId: string; reason: string }>;
  /** Rules that did not run, and why. Never silently skipped. */
  skipped: Array<{ ruleId: string; reason: string }>;
  /** `once` rules that resolved to a fully-held set and may now be retired. */
  satisfied: string[];
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface FetchItem {
  chapterId: string;
  seriesId: string;
  /** The chapter hash the plan was built against. */
  hash: string;
  priority: number;
  /** Estimated, from the catalog, before pages are resolved. */
  estimatedBytes: number;
  pageCount: number;
  /**
   * "repair" means we hold this chapter at a different hash; the resolve step
   * sends page-level `have` so identical bytes are never re-fetched.
   */
  reason: "missing" | "repair";
}

export interface EvictCandidate {
  chapterId: string;
  seriesId: string;
  bytes: number;
  /** Ascending: 0 goes first. */
  rank: number;
  reason: string;
}

export interface Plan {
  /** The root hash this plan was built against. Staleness is checked on it. */
  builtAgainstRoot: string;
  treeVersion: number;
  fetch: FetchItem[];
  /**
   * A LIST, not an instruction. rules.md: nothing in the code quietly picks
   * adds-only or rolling-window. The engine only acts on this under real
   * storage pressure, and only on entries the policy allows.
   */
  evictCandidates: EvictCandidate[];
  /** Bytes the fetch plan needs, minus what is already held. */
  netBytes: number;
}
