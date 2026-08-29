// The client's mirror of what exists on the server, down to chapter level.
//
// It is built from the `changed` stream of `/api/sync/diff`, which is a
// PRE-ORDER walk. That is the only structural information on the wire -- the
// reply is a flat array with a `kind` on each entry and no parent pointers --
// so parentage is reconstructed from the kind hierarchy and the order.
//
// The catalog is INCREMENTAL by design. A diff only reports what moved, so an
// unchanged block never appears; the client already holds it. That is the whole
// point of sending a `have` set, and it means the catalog must survive being
// updated from a reply that mentions three nodes out of four thousand.

import type { Catalog, CatalogChapter, CatalogSeries, DiffReply, NodeSummary } from "./types";

const RANK: Record<NodeSummary["kind"], number> = {
  root: 0, series: 1, block: 2, chapter: 3, page: 4,
};

export function emptyCatalog(treeVersion = 0): Catalog {
  return { root: "", treeVersion, series: new Map(), blockArity: new Map(), blockHash: new Map() };
}

/**
 * The lower bound of a block, from its id.
 *
 * `b:<uid>:<sequence>:<start>` -- the sequence segment is what treeVersion 2
 * added, and a client that split on the first colon would read the uid as the
 * start. Split from the right. Falls back to the label (`1-25`, `unnumbered`,
 * `Spin-off 26-50`) if the id is spelled some way we do not know, because a
 * shape we cannot parse must degrade to "unnumbered", never to `NaN`.
 */
export function blockStartOf(id: string, label: string): number {
  const tail = id.slice(id.lastIndexOf(":") + 1);
  const n = Number(tail);
  if (Number.isFinite(n)) return n;
  const m = /(\d+)\s*-\s*\d+$/.exec(label);
  return m?.[1] ? Number(m[1]) : 0;
}

interface Frame { kind: NodeSummary["kind"]; id: string; seriesId?: string }

export interface CatalogUpdate {
  addedSeries: number;
  addedChapters: number;
  pruned: number;
  /** Blocks whose reported child count exceeds what the stream contained. */
  partialBlocks: string[];
}

/**
 * Fold one diff reply into the catalog.
 *
 * `gone` is applied ONLY when the reply's treeVersion matches the catalog's.
 * Across a version change `gone` is a renaming, not a deletion -- see
 * `dropForTreeVersion`, which is the correct response and is the caller's job.
 */
export function applyDiff(cat: Catalog, reply: DiffReply): CatalogUpdate {
  const update: CatalogUpdate = { addedSeries: 0, addedChapters: 0, pruned: 0, partialBlocks: [] };
  const stack: Frame[] = [];
  const seenUnderBlock = new Map<string, number>();

  for (const node of reply.changed) {
    const rank = RANK[node.kind];
    while (stack.length && RANK[stack[stack.length - 1]!.kind] >= rank) stack.pop();
    const parent = stack[stack.length - 1];

    if (node.kind === "series") {
      const existing = cat.series.get(node.id);
      if (existing) {
        existing.label = node.label;
        existing.hash = node.hash;
      } else {
        cat.series.set(node.id, { id: node.id, label: node.label, hash: node.hash, chapters: new Map() });
        update.addedSeries++;
      }
      stack.push({ kind: "series", id: node.id, seriesId: node.id });
      continue;
    }

    if (node.kind === "block") {
      cat.blockArity.set(node.id, node.n);
      cat.blockHash.set(node.id, node.hash);
      seenUnderBlock.set(node.id, 0);
      stack.push({ kind: "block", id: node.id, seriesId: parent?.seriesId });
      continue;
    }

    if (node.kind === "chapter") {
      // A scoped diff can start at a chapter, with no series node above it, so
      // the series id has to be recoverable from the scope. When it is not, the
      // chapter is skipped rather than filed under a guess.
      const seriesId = parent?.seriesId;
      if (!seriesId) { stack.push({ kind: "chapter", id: node.id }); continue; }
      const series = cat.series.get(seriesId);
      if (!series) { stack.push({ kind: "chapter", id: node.id, seriesId }); continue; }

      const blockId = parent?.kind === "block" ? parent.id : undefined;
      if (blockId) seenUnderBlock.set(blockId, (seenUnderBlock.get(blockId) ?? 0) + 1);

      const prior = series.chapters.get(node.id);
      const slot = blockId ? (seenUnderBlock.get(blockId) ?? 1) - 1 : (prior?.order ?? 0);
      const chapter: CatalogChapter = {
        id: node.id,
        seriesId,
        blockIds: prior ? [...new Set([...prior.blockIds, ...(blockId ? [blockId] : [])])] : blockId ? [blockId] : [],
        label: node.label,
        hash: node.hash,
        pageCount: node.n,
        order: prior?.order ?? 0,
        blockStart: blockId ? blockStartOf(blockId, "") : (prior?.blockStart ?? 0),
      };
      // A chapter reached again through a second block keeps its first slot --
      // its reading position is where its range starts, not where it ends.
      chapter.order = prior ? prior.order : slot;
      if (!prior) update.addedChapters++;
      series.chapters.set(node.id, chapter);
      stack.push({ kind: "chapter", id: node.id, seriesId });
      continue;
    }

    if (node.kind === "root") stack.push({ kind: "root", id: node.id });
  }

  for (const [blockId, seen] of seenUnderBlock) {
    const arity = cat.blockArity.get(blockId) ?? 0;
    if (seen < arity) update.partialBlocks.push(blockId);
  }

  if (reply.treeVersion === cat.treeVersion) {
    for (const id of reply.gone) update.pruned += prune(cat, id);
  }

  cat.root = reply.root;
  reorder(cat);
  return update;
}

function prune(cat: Catalog, id: string): number {
  if (id.startsWith("s:")) {
    const series = cat.series.get(id);
    if (!series) return 0;
    for (const ch of series.chapters.values()) {
      for (const b of ch.blockIds) { cat.blockArity.delete(b); cat.blockHash.delete(b); }
    }
    cat.series.delete(id);
    return 1;
  }
  if (id.startsWith("b:")) {
    cat.blockArity.delete(id);
    cat.blockHash.delete(id);
    let n = 0;
    for (const series of cat.series.values()) {
      for (const [chId, ch] of series.chapters) {
        const left = ch.blockIds.filter((b) => b !== id);
        if (left.length === ch.blockIds.length) continue;
        // A ranged chapter loses one of several blocks and survives; a chapter
        // whose only block is gone goes with it.
        if (left.length === 0) { series.chapters.delete(chId); n++; }
        else ch.blockIds = left;
      }
    }
    return n;
  }
  if (id.startsWith("c:")) {
    for (const series of cat.series.values()) if (series.chapters.delete(id)) return 1;
  }
  return 0;
}

/**
 * Reading order, recomputed after every fold.
 *
 * Ordering, never identity. The wire carries no `sortKey` (see
 * docs/api-gaps.md) so the client orders by (block start, slot within block)
 * and files the unnumbered block last -- a chapter with no number has no
 * position on the number line, exactly as the server reasons about it.
 */
function reorder(cat: Catalog) {
  for (const series of cat.series.values()) {
    const list = [...series.chapters.values()].sort((a, b) => {
      const as = a.blockStart === 0 ? Number.MAX_SAFE_INTEGER : a.blockStart;
      const bs = b.blockStart === 0 ? Number.MAX_SAFE_INTEGER : b.blockStart;
      if (as !== bs) return as - bs;
      if (a.order !== b.order) return a.order - b.order;
      return a.label.localeCompare(b.label, undefined, { numeric: true });
    });
    list.forEach((ch, i) => { ch.order = i; });
  }
}

/** Reading order for one series. */
export function chaptersInOrder(series: CatalogSeries): CatalogChapter[] {
  return [...series.chapters.values()].sort((a, b) => a.order - b.order);
}

export function countChapters(cat: Catalog): number {
  let n = 0;
  for (const s of cat.series.values()) n += s.chapters.size;
  return n;
}

/**
 * The treeVersion contract, in one function.
 *
 * "Drop your `have` set and re-diff" -- never "delete content". The catalog's
 * *ids* are what became unreliable, so the catalog is emptied and rebuilt; the
 * held content is not touched here and is not this function's business.
 */
export function dropForTreeVersion(to: number): Catalog {
  return emptyCatalog(to);
}
