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
  let total = 0;
  for (const file of files) {
    try {
      const m = await sharp(join(dir, file)).metadata();
      if (m.height && m.width) total += Math.round((m.height * NORMAL_WIDTH) / m.width);
    } catch {
      // A page sharp cannot read contributes nothing; the rest still count.
    }
  }
  return total;
}
