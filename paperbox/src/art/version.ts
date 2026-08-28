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
 */
export const ART_VERSION = 1;
