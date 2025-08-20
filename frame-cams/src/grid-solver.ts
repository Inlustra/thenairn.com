export type StreamId = string;

export interface StreamInfo {
  id: StreamId;
  src: string;
  // Known or estimated aspect ratio (width / height). Use default (e.g. 16/9) until real one arrives.
  aspectRatio: number;
}

export interface GridChoice {
  rows: number;
  cols: number;
  cellWidth: number;
  cellHeight: number;
  // Sum of fitted areas across all streams (higher = less black bars)
  totalUsedArea: number;
}

export interface ItemRect {
  id: StreamId;
  src: string;
  // Size of the video element within its grid cell when using object-fit: contain
  width: number;
  height: number;
  // Grid placement indices (0-based). You'll typically map these to CSS grid-row/column.
  row: number;
  col: number;
}

export interface GridLayoutResult {
  choice: GridChoice;
  items: ItemRect[];
}

/**
 * Compute how big a video will render inside a cell with object-fit: contain.
 * @param cellW cell width
 * @param cellH cell height
 * @param ar aspect ratio (width / height)
 */
function containedSize(cellW: number, cellH: number, ar: number): { width: number; height: number } {
  const byWidth = cellW / ar;     // height if width-limited
  const byHeight = cellH * ar;    // width if height-limited
  if (byWidth <= cellH) {
    // limited by width
    return { width: cellW, height: byWidth };
  } else {
    // limited by height
    return { width: byHeight, height: cellH };
  }
}

/**
 * Try all possible (rows, cols) where rows*cols >= n and pick the grid
 * that maximizes total used area across all streams (minimizes letterboxing).
 * You can pass a gap (CSS grid-gap) to subtract spacing from each cell.
 */
export function computeBestGridLayout(
  containerWidth: number,
  containerHeight: number,
  streams: StreamInfo[],
  gapPx: number = 8
): GridLayoutResult {
  const n = streams.length;
  if (n === 0 || containerWidth <= 0 || containerHeight <= 0) {
    return {
      choice: { rows: 0, cols: 0, cellWidth: 0, cellHeight: 0, totalUsedArea: 0 },
      items: [],
    };
  }

  // To bound the search, cols from 1..n (rows derived).
  // Initialize with a default grid choice to avoid null checks
  let best: GridChoice = {
    rows: 1,
    cols: 1,
    cellWidth: containerWidth,
    cellHeight: containerHeight,
    totalUsedArea: 0
  };

  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);

    // Effective space after gaps (cols-1 vertical gaps, rows-1 horizontal gaps)
    const totalGapX = Math.max(0, cols - 1) * gapPx;
    const totalGapY = Math.max(0, rows - 1) * gapPx;
    const cellW = (containerWidth - totalGapX) / cols;
    const cellH = (containerHeight - totalGapY) / rows;
    if (cellW <= 0 || cellH <= 0) continue;

    // Compute total used area for this grid
    let totalUsedArea = 0;
    for (let i = 0; i < n; i++) {
      const ar = streams[i]!.aspectRatio > 0 ? streams[i]!.aspectRatio : 16 / 9;
      const { width, height } = containedSize(cellW, cellH, ar);
      totalUsedArea += width * height;
    }

    const candidate: GridChoice = { rows, cols, cellWidth: cellW, cellHeight: cellH, totalUsedArea };

    if (candidate.totalUsedArea > best.totalUsedArea) {
      best = candidate;
    }
  }

  // Build item rects in row-major order
  const items: ItemRect[] = streams.map((s, i) => {
    const row = Math.floor(i / best.cols);
    const col = i % best.cols;
    const ar = s.aspectRatio > 0 ? s.aspectRatio : 16 / 9;
    const size = containedSize(best.cellWidth, best.cellHeight, ar);
    return { id: s.id, src: s.src, width: size.width, height: size.height, row, col };
  });

  return { choice: best, items };
}
