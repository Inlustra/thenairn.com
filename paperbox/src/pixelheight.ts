// Reading length, measured in pixels rather than files.
//
// Page count is a poor measure of how much chapter there is: in this library
// one page is 46,564 px tall and another 800, so a 50-page chapter is often
// far more reading than a 128-page one. The honest analogue of a book's paper
// is pixel height — and because the reader renders fit-width, height is
// normalized to a common width first, so a wide spread does not count as more
// reading than the tall strip it sits next to.
//
// `sharp().metadata()` reads image headers only (no pixel decode), so this
// costs one small read per page and runs only when the scanner would already
// be re-fingerprinting the chapter.

import sharp from "sharp";
import { join } from "path";

/** The width every page height is normalized to. */
export const NORMAL_WIDTH = 1000;

/**
 * Total normalized pixel height of a chapter's pages. Unreadable pages are
 * skipped; a chapter with no readable page returns 0, which callers treat as
 * "unknown" (never divide a spine by it).
 */
export async function chapterPixelHeight(dir: string, files: string[]): Promise<number> {
  // Concurrently, because the cost here is not reading a header -- it is the
  // FUSE round trip to open each file, and awaiting them one at a time pays that
  // in full every time. Measured on this box: 7.9 ms/page sequential against
  // 1.6 ms/page at this width, on the same pages. A raw 64 KB read is 0.3 ms, so
  // the remainder is sharp's own per-call overhead and not worth chasing.
  //
  // 8, not 32: R-01's stat throughput plateaus around 32, but this shares the
  // FUSE queue with whoever is reading a comic, and `docs/scheduler.md` argues
  // for leaving them room.
  const WIDTH = 8;
  let total = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(WIDTH, files.length) }, async () => {
    while (next < files.length) {
      const file = files[next++];
      if (file === undefined) return;
      try {
        const m = await sharp(join(dir, file)).metadata();
        if (m.height && m.width) total += Math.round((m.height * NORMAL_WIDTH) / m.width);
      } catch {
        // A page sharp cannot read contributes nothing; the rest still count.
      }
    }
  });
  await Promise.all(workers);
  return total;
}
