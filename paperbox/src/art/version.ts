/**
 * The extraction version.
 *
 * Every key in the derived store starts with this number, so bumping it moves
 * every key at once and the old artefacts become unreachable rather than stale.
 * That is the whole invalidation story for "we changed how spines are cut":
 * there is no purge step, no migration, and no window during which a new
 * algorithm serves an old picture.
 *
 * **Bump it whenever the pixels would come out different** -- a new saliency
 * rule, a different sliver width, a change of output format or quality, a
 * different tint derivation. Not for a refactor that provably cannot move a
 * pixel.
 *
 * The cost of bumping is regeneration, which is why nothing else in Paperbox is
 * keyed this way: the derived store is the one place where every byte is
 * reproducible from the library, so throwing all of it away is a cost in CPU
 * and never in data. Measured at ~0.2 s of CPU per chapter (R-22), so the real
 * 1,706-chapter library re-derives in about six minutes of background work.
 *
 * v1 - 2026-08-28 - first pipeline: banded saliency with a flat-white penalty,
 *                   sliver cut from a 480px-wide raster, tint by coarse
 *                   histogram mode.
 * v2 - 2026-08-29 - geometry and codec. 120x560/WebP q82 became 132x372/AVIF
 *                   q35 effort0: 9.7 KB a spine down to 2.73 KB, so a
 *                   313-chapter shelf is 855 KB rather than 3.0 MB.
 *
 *                   The geometry mattered more than the codec. A spine renders
 *                   21-44 px wide by 124 tall under `object-fit: cover`, so the
 *                   stored aspect decides what the crop keeps. 120x560 matched
 *                   neither end, and a thick spine lost ~40% of its height.
 *                   132x372 is 3x the widest slot: nothing is cropped
 *                   vertically at any width, and it is sharp on a 3x display.
 */
export const ART_VERSION = 2;
