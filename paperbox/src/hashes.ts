// The sync tree.
//
// One job: given what a client already holds, say which images it needs -- in
// one request. The tree exists so the server can skip unchanged subtrees while
// working that out, not so the client has to walk it in N round trips. The
// client may walk it (see `depth`) when a screen wants to *show* where a change
// is, but a downloader never needs to.
//
// A brand-new series is not a special case: a client that holds nothing gets
// every image back from the same call that repairs a single changed page.
//
// SCALE. The tree is built down to chapter level from persisted fingerprints,
// so it touches no image files at all. Pages are expanded only for chapters the
// walk actually descends into. Walking the filesystem eagerly instead cost 17
// seconds for 12 series here, which is ~2 hours at 5,000 series -- and it was
// paid again after every scan.

import { readdir } from "fs/promises";
import { join, extname } from "path";
import { getMangaList, getManga, getMangaDir, getScanGeneration } from "./scanner";
import { digest, pageFingerprint, statPages } from "./fingerprint";

export { chapterFingerprint } from "./fingerprint";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"]);
const BLOCK = 25;
const MAX_IMAGES = 20_000;
const PAGE_CACHE_MAX = 400;

export type NodeKind = "root" | "series" | "block" | "chapter" | "page";

export interface ImageRef {
  id: string;
  chapterId: string;
  file: string;
  size: number;
  url: string;
  hash: string;
}

export interface TreeNode {
  id: string;
  kind: NodeKind;
  hash: string;
  n: number;
  label: string;
  children: TreeNode[];
  image?: ImageRef;
  /** Set on chapter nodes so pages can be expanded on demand. */
  src?: { seriesDir: string; chapterDir: string };
}

/** Blocks are keyed by chapter number so an insertion dirties one block, not all. */
function blockStart(num: number): number {
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor((Math.ceil(num) - 1) / BLOCK) * BLOCK + 1;
}

/**
 * A parent covers each child's IDENTITY as well as its content.
 *
 * Hashing only the child hashes means a membership change can be invisible:
 * swap one chapter for another whose pages happen to hash the same and the
 * parent is unmoved. Including ids makes any add, removal or replacement
 * propagate to the root, which is the whole point of the structure.
 */
function combine(children: Array<{ id: string; hash: string }>): string {
  return digest(children.flatMap((c) => [c.id, c.hash]));
}

function naturalSort(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

let cached: { builtAt: number; root: TreeNode } | null = null;

/**
 * Root down to chapter level, entirely from metadata the scanner already holds.
 * No image file is opened or stat-ed here.
 */
export function buildTree(): TreeNode {
  const generation = getScanGeneration();
  if (cached && cached.builtAt === generation) return cached.root;

  const seriesNodes: TreeNode[] = [];

  for (const listed of getMangaList()) {
    const manga = getManga(listed.id);
    if (!manga) continue;

    const byBlock = new Map<string, TreeNode[]>();

    for (const ch of manga.chapters) {
      const chapterNode: TreeNode = {
        id: `c:${ch.uid}`,
        kind: "chapter",
        // Falls back to a shape-only hash if the scanner has not fingerprinted
        // this chapter yet; it is replaced on the next scan.
        // Identity + content, so two chapters with identical pages still differ.
        hash: digest([`c:${ch.uid}`, ch.fingerprint ?? `shape:${ch.dir}:${ch.pageCount}`]),
        n: ch.pageCount,
        label: ch.title,
        children: [],
        src: { seriesDir: manga.dir, chapterDir: ch.dir },
      };
      // Keyed by (sequence, chapter number). A series can hold several runs --
      // `Episode 001` and `Spin-off #001` are both legitimately "1" -- so the
      // sequence has to be part of the key or they collide into one block.
      const key = `${ch.sequence}:${blockStart(ch.sortKey)}`;
      const bucket = byBlock.get(key);
      if (bucket) bucket.push(chapterNode);
      else byBlock.set(key, [chapterNode]);
    }

    const blockNodes: TreeNode[] = [...byBlock.entries()]
      // Sort by sequence, then by block start NUMERICALLY. Sorting the composite
      // key as a string puts "main:101" before "main:26", which is both wrong for
      // any consumer walking blocks in order and, because combine() is
      // order-sensitive, bakes that order into the series hash.
      .sort((a, b) => {
        const [aSeq = "", aStart = "0"] = a[0].split(":");
        const [bSeq = "", bStart = "0"] = b[0].split(":");
        return aSeq === bSeq ? Number(aStart) - Number(bStart) : aSeq < bSeq ? -1 : 1;
      })
      .map(([key, chapters]) => {
        const [sequence = "main", startStr = "0"] = key.split(":");
        const start = Number(startStr);
        const range = start === 0 ? "unnumbered" : `${start}-${start + BLOCK - 1}`;
        return {
          id: `b:${manga.uid}:${key}`,
          kind: "block" as const,
          hash: combine(chapters),
          n: chapters.length,
          label: sequence === "main" ? range : `${sequence} ${range}`,
          children: chapters,
        };
      });

    seriesNodes.push({
      id: `s:${manga.uid}`,
      kind: "series",
      hash: combine(blockNodes),
      n: blockNodes.length,
      label: manga.title,
      children: blockNodes,
    });
  }

  const root: TreeNode = {
    id: "root",
    kind: "root",
    hash: combine(seriesNodes),
    n: seriesNodes.length,
    label: "library",
    children: seriesNodes,
  };

  cached = { builtAt: generation, root };
  return root;
}

// Expanded pages, keyed by chapter id and validated against the chapter hash so
// a re-pulled chapter is never served from a stale expansion.
const pageCache = new Map<string, { hash: string; pages: TreeNode[] }>();

async function expandPages(node: TreeNode): Promise<TreeNode[]> {
  if (!node.src) return [];
  const hit = pageCache.get(node.id);
  if (hit && hit.hash === node.hash) return hit.pages;

  const dir = join(getMangaDir(), node.src.seriesDir, node.src.chapterDir);
  let names: string[] = [];
  try {
    names = (await readdir(dir))
      .filter((f) => !f.startsWith(".") && IMAGE_EXTS.has(extname(f).toLowerCase()))
      .sort(naturalSort);
  } catch {
    return [];
  }

  const stats = await statPages(dir, names);
  const pages: TreeNode[] = stats.map(({ file, size }) => {
    const hash = pageFingerprint(file, size);
    const id = `p:${node.id.slice(2)}:${file}`;
    return {
      id,
      kind: "page" as const,
      hash,
      n: 0,
      label: file,
      children: [],
      image: {
        id,
        chapterId: node.id,
        file,
        size,
        url: `/api/images/${encodeURIComponent(node.src!.seriesDir)}/${encodeURIComponent(node.src!.chapterDir)}/${encodeURIComponent(file)}`,
        hash,
      },
    };
  });

  if (pageCache.size >= PAGE_CACHE_MAX) pageCache.clear();
  pageCache.set(node.id, { hash: node.hash, pages });
  return pages;
}

export interface HaveEntry { id: string; hash: string }

export interface NodeSummary {
  id: string;
  kind: NodeKind;
  hash: string;
  /** Child count. A display value only -- see `state` for what actually changed. */
  n: number;
  label: string;
  /**
   * Authoritative, because it is derived from what the client actually sent:
   * "added" means the client never mentioned this id, "modified" means it did
   * and the hash differs. Inferring this from `n` cannot work -- one chapter
   * added and one removed leaves the count identical.
   */
  state: "added" | "modified";
}

export interface DiffResult {
  root: string;
  changed: NodeSummary[];
  images: ImageRef[];
  gone: string[];
  truncated: boolean;
  /** Pass back as `after` to continue a plan that hit the cap. */
  nextCursor?: string;
}

function findNode(node: TreeNode, id: string): TreeNode | undefined {
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return undefined;
}

function collectIds(node: TreeNode, into: Set<string>) {
  into.add(node.id);
  for (const c of node.children) collectIds(c, into);
}

/**
 * Compare what the client holds against the tree.
 *
 * `resolve: "pages"` descends all the way and returns the images to fetch --
 * the downloader's call, one round trip. `resolve: "nodes"` stops at `depth`
 * and reports where the change is, for a screen that wants to say "something in
 * chapters 51-75 changed" without pulling 800 image records.
 */
export async function diff(
  have: HaveEntry[],
  opts: { depth?: number; resolve?: "nodes" | "pages"; scope?: string; after?: string } = {},
): Promise<DiffResult> {
  const depth = Math.min(Math.max(opts.depth ?? 1, 1), 4);
  const resolve = opts.resolve ?? "nodes";
  const root = buildTree();
  const start = opts.scope ? findNode(root, opts.scope) : root;

  const known = new Map(have.map((h) => [h.id, h.hash]));
  const changed: NodeSummary[] = [];
  const images: ImageRef[] = [];
  let truncated = false;
  // Tree order is deterministic, so a cursor is just "skip until past this id".
  let skipping = Boolean(opts.after);

  const takePage = (page: TreeNode) => {
    if (!page.image) return;
    if (known.get(page.id) === page.hash) return;
    if (skipping) {
      if (page.id === opts.after) skipping = false;
      return;
    }
    if (images.length >= MAX_IMAGES) truncated = true;
    else images.push(page.image);
  };

  const walk = async (node: TreeNode, level: number): Promise<void> => {
    if (known.get(node.id) === node.hash) return; // subtree proven identical
    changed.push({
      id: node.id, kind: node.kind, hash: node.hash, n: node.n, label: node.label,
      state: known.has(node.id) ? "modified" : "added",
    });

    const descend = resolve === "pages" || level < depth;
    if (!descend) return;

    if (node.kind === "chapter") {
      // The only place image files are touched, and only for a chapter that
      // already failed its hash comparison.
      for (const page of await expandPages(node)) takePage(page);
      return;
    }
    for (const c of node.children) await walk(c, level + 1);
  };

  if (start) await walk(start, 0);

  const live = new Set<string>();
  collectIds(start ?? root, live);
  // Page ids are not in the chapter-level tree, so only judge what it can see.
  const gone = have
    .filter((h) => !h.id.startsWith("p:") && !live.has(h.id))
    .map((h) => h.id);

  return {
    root: root.hash,
    changed,
    images,
    gone,
    truncated,
    ...(truncated && images.length ? { nextCursor: images[images.length - 1]!.id } : {}),
  };
}

export function blockSize() {
  return BLOCK;
}
