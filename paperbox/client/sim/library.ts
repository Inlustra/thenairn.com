// A fake library, and the server's half of the sync contract over it.
//
// This is a re-implementation of `src/hashes.ts`, not an import of it: the
// point of the simulator is to be mutable mid-run and to have no filesystem, no
// scanner and no Bun crypto behind it. What it does copy exactly is the
// SEMANTICS that the client depends on, because a simulator that is easier than
// the real thing tests nothing:
//
//   - a leaf is hash(name + byte size), never mtime;
//   - a parent hashes (child id, child hash) pairs, so a membership swap moves it;
//   - blocks are keyed by chapter NUMBER / 25, never by position;
//   - chapter 0 with a mark belongs in 1-25; an empty mark belongs in `unnumbered`;
//   - a ranged chapter is filed into every block it spans and visited once;
//   - provenance sits under the chapter, so re-sourcing moves the chapter hash
//     while every page hash stays put. That asymmetry is scenario 4.

import type { DiffReply, DiffRequest, ImageRef, NodeKind, NodeSummary, TreeReply } from "../types";

const BLOCK = 25;
const MAX_IMAGES = 20_000;

// ---------------------------------------------------------------------------
// hashing -- portable, deterministic, and 16 hex characters like the real one
// ---------------------------------------------------------------------------

const M = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function digest(parts: string[]): string {
  let h = 0xcbf29ce484222325n;
  const s = parts.join(" ") + " ";
  for (let i = 0; i < s.length; i++) {
    h = ((h ^ BigInt(s.charCodeAt(i))) * M) & MASK;
  }
  return h.toString(16).padStart(16, "0");
}

export function pageFingerprint(file: string, size: number): string {
  return digest([file, String(size)]);
}

function combine(children: Array<{ id: string; hash: string }>): string {
  return digest(children.flatMap((c) => [c.id, c.hash]));
}

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

export interface SimPage { file: string; size: number }

export interface SimChapter {
  uid: string;
  title: string;
  sequence: string;
  /** 0 with a non-empty mark means "chapter zero"; with an empty mark, unnumbered. */
  sortKey: number;
  sortKeyEnd?: number;
  mark: string;
  pages: SimPage[];
  /** Where it came from. Moves the chapter hash without moving a page hash. */
  provenance?: string;
}

export interface SimSeries {
  uid: string;
  title: string;
  chapters: SimChapter[];
}

interface Node {
  id: string;
  kind: NodeKind;
  hash: string;
  n: number;
  label: string;
  children: Node[];
  image?: ImageRef;
}

function blockStart(num: number): number {
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor((Math.ceil(num) - 1) / BLOCK) * BLOCK + 1;
}

function firstBlock(sortKey: number, mark: string): number {
  if (sortKey === 0 && mark !== "") return 1;
  return blockStart(sortKey);
}

function blocksFor(ch: SimChapter): number[] {
  const start = firstBlock(ch.sortKey, ch.mark);
  const end = ch.sortKeyEnd;
  if (start === 0 || end === undefined || end <= ch.sortKey) return [start];
  const last = blockStart(end);
  if (last <= start) return [start];
  const out: number[] = [];
  for (let s = start; s <= last; s += BLOCK) out.push(s);
  return out;
}

export interface SimLibraryOptions {
  treeVersion?: number;
}

export class SimLibrary {
  series: SimSeries[] = [];
  treeVersion: number;
  /** Bumped by every mutation. The cache key, exactly as the real scanner's is. */
  generation = 0;
  private cache: { at: number; version: number; root: Node } | null = null;

  constructor(opts: SimLibraryOptions = {}) {
    this.treeVersion = opts.treeVersion ?? 2;
  }

  // ---- mutation -----------------------------------------------------------

  private touched() { this.generation++; this.cache = null; }

  addSeries(uid: string, title: string): SimSeries {
    const s: SimSeries = { uid, title, chapters: [] };
    this.series.push(s);
    this.touched();
    return s;
  }

  addChapter(seriesUid: string, ch: Partial<SimChapter> & { uid: string; sortKey: number; pages: SimPage[] }): SimChapter {
    const s = this.series.find((x) => x.uid === seriesUid);
    if (!s) throw new Error(`no series ${seriesUid}`);
    const full: SimChapter = {
      sequence: "main",
      mark: String(ch.sortKey),
      title: ch.title ?? `Chapter ${String(ch.sortKey).padStart(3, "0")}`,
      ...ch,
    };
    s.chapters.push(full);
    this.touched();
    return full;
  }

  removeChapter(chapterUid: string): void {
    for (const s of this.series) {
      const i = s.chapters.findIndex((c) => c.uid === chapterUid);
      if (i >= 0) { s.chapters.splice(i, 1); this.touched(); return; }
    }
  }

  removeSeries(seriesUid: string): void {
    const i = this.series.findIndex((s) => s.uid === seriesUid);
    if (i >= 0) { this.series.splice(i, 1); this.touched(); }
  }

  /**
   * Re-source a chapter: identical bytes, different origin.
   *
   * The chapter hash moves. Not one page hash does. docs/sync.md admits this
   * plainly -- "the chapter changed" stops meaning "the bytes changed" -- and a
   * client that reconciles at chapter granularity would re-download the lot.
   */
  resource(chapterUid: string, provenance: string): void {
    for (const s of this.series) {
      for (const c of s.chapters) {
        if (c.uid === chapterUid) { c.provenance = provenance; this.touched(); return; }
      }
    }
    throw new Error(`no chapter ${chapterUid}`);
  }

  /** A page genuinely changes: new byte size, so its leaf hash moves. */
  repage(chapterUid: string, file: string, size: number): void {
    for (const s of this.series) {
      for (const c of s.chapters) {
        if (c.uid !== chapterUid) continue;
        const p = c.pages.find((x) => x.file === file);
        if (p) p.size = size; else c.pages.push({ file, size });
        this.touched();
        return;
      }
    }
  }

  dropPage(chapterUid: string, file: string): void {
    for (const s of this.series) {
      for (const c of s.chapters) {
        if (c.uid !== chapterUid) continue;
        c.pages = c.pages.filter((p) => p.file !== file);
        this.touched();
        return;
      }
    }
  }

  /**
   * Bump the id spelling without moving a byte -- the v1 -> v2 event, exactly.
   * Every block id the client holds lands in `gone`; no content moved.
   */
  bumpTreeVersion(): void { this.treeVersion++; this.touched(); }

  chapter(uid: string): SimChapter | undefined {
    for (const s of this.series) for (const c of s.chapters) if (c.uid === uid) return c;
    return undefined;
  }

  seriesOf(chapterUid: string): SimSeries | undefined {
    return this.series.find((s) => s.chapters.some((c) => c.uid === chapterUid));
  }

  // ---- tree ---------------------------------------------------------------

  private blockId(seriesUid: string, sequence: string, start: number): string {
    // Version 3 spells block ids differently and nothing else changes. That is
    // the whole shape of a treeVersion bump.
    return this.treeVersion >= 3
      ? `b:${seriesUid}:v${this.treeVersion}:${sequence}:${start}`
      : `b:${seriesUid}:${sequence}:${start}`;
  }

  build(): Node {
    if (this.cache && this.cache.at === this.generation && this.cache.version === this.treeVersion) return this.cache.root;

    const seriesNodes: Node[] = [];
    for (const s of this.series) {
      const byBlock = new Map<string, Node[]>();
      for (const ch of s.chapters) {
        const fingerprint = digest(ch.pages.map((p) => pageFingerprint(p.file, p.size)));
        const node: Node = {
          id: `c:${ch.uid}`,
          kind: "chapter",
          // Provenance sits under the chapter, so it is inside the chapter hash
          // and outside every page hash.
          hash: digest([`c:${ch.uid}`, fingerprint, ch.provenance ?? ""]),
          n: ch.pages.length,
          label: ch.title,
          children: ch.pages.map((p) => {
            const hash = pageFingerprint(p.file, p.size);
            const id = `p:${ch.uid}:${p.file}`;
            return {
              id, kind: "page" as const, hash, n: 0, label: p.file, children: [],
              image: {
                id, chapterId: `c:${ch.uid}`, file: p.file, size: p.size, hash,
                url: `/api/images/${encodeURIComponent(s.title)}/${encodeURIComponent(ch.title)}/${encodeURIComponent(p.file)}`,
              },
            };
          }),
        };
        for (const start of blocksFor(ch)) {
          const key = `${ch.sequence}:${start}`;
          const bucket = byBlock.get(key);
          if (bucket) bucket.push(node); else byBlock.set(key, [node]);
        }
      }

      const blockNodes: Node[] = [...byBlock.entries()]
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
            id: this.blockId(s.uid, sequence, start),
            kind: "block" as const,
            hash: combine(chapters),
            n: chapters.length,
            label: sequence === "main" ? range : `${sequence} ${range}`,
            children: chapters,
          };
        });

      seriesNodes.push({
        id: `s:${s.uid}`, kind: "series", hash: combine(blockNodes),
        n: blockNodes.length, label: s.title, children: blockNodes,
      });
    }

    const root: Node = {
      id: "root", kind: "root", hash: combine(seriesNodes),
      n: seriesNodes.length, label: "library", children: seriesNodes,
    };
    this.cache = { at: this.generation, version: this.treeVersion, root };
    return root;
  }

  // ---- the wire -----------------------------------------------------------

  tree(): TreeReply {
    const root = this.build();
    return {
      root: root.hash,
      treeVersion: this.treeVersion,
      blockSize: BLOCK,
      children: root.children.map((c) => ({ id: c.id, kind: c.kind, hash: c.hash, n: c.n, label: c.label })),
    };
  }

  diff(req: DiffRequest): DiffReply {
    const depth = Math.min(Math.max(req.depth ?? 1, 1), 4);
    const resolve = req.resolve ?? "nodes";
    const root = this.build();
    const start = req.scope ? find(root, req.scope) : root;

    const have = req.have ?? [];
    const known = new Map(have.map((h) => [h.id, h.hash]));
    const visited = new Set<string>();
    const changed: NodeSummary[] = [];
    const images: ImageRef[] = [];
    let truncated = false;
    let skipping = Boolean(req.after);

    const takePage = (page: Node) => {
      if (!page.image) return;
      if (known.get(page.id) === page.hash) return;
      if (skipping) { if (page.id === req.after) skipping = false; return; }
      if (images.length >= MAX_IMAGES) truncated = true; else images.push(page.image);
    };

    const walk = (node: Node, level: number) => {
      if (known.get(node.id) === node.hash) return;
      if (visited.has(node.id)) return;
      visited.add(node.id);
      changed.push({
        id: node.id, kind: node.kind, hash: node.hash, n: node.n, label: node.label,
        state: known.has(node.id) ? "modified" : "added",
      });
      const descend = resolve === "pages" || level < depth;
      if (!descend) return;
      if (node.kind === "chapter") { for (const p of node.children) takePage(p); return; }
      for (const c of node.children) walk(c, level + 1);
    };

    if (start) walk(start, 0);

    const live = new Set<string>();
    collect(start ?? root, live);
    // Computed against the SCOPED subtree, bug and all. See docs/api-gaps.md
    // #13: a scoped diff reports everything outside the scope as gone. The
    // simulator reproduces it rather than fixing it, because the client is what
    // has to survive it.
    const gone = have.filter((h) => !h.id.startsWith("p:") && !live.has(h.id)).map((h) => h.id);

    return {
      root: root.hash,
      treeVersion: this.treeVersion,
      changed, images, gone, truncated,
      ...(truncated && images.length ? { nextCursor: images[images.length - 1]!.id } : {}),
    };
  }

  /** Resolve an image url to its declared size, or undefined if it is gone. */
  imageSize(url: string): number | undefined {
    const root = this.build();
    let found: number | undefined;
    const walk = (n: Node) => {
      if (n.image?.url === url) { found = n.image.size; return; }
      for (const c of n.children) { if (found === undefined) walk(c); }
    };
    walk(root);
    return found;
  }
}

function find(node: Node, id: string): Node | undefined {
  if (node.id === id) return node;
  for (const c of node.children) { const hit = find(c, id); if (hit) return hit; }
  return undefined;
}

function collect(node: Node, into: Set<string>) {
  into.add(node.id);
  for (const c of node.children) collect(c, into);
}
