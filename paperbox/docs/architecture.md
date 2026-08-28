# Architecture — structure is truth

## The premise

Drop a folder into the library and it appears. No import step, no file generated
first, no configuration. This is how Plex, Jellyfin, Komga and Kavita all work, and
the reason is not laziness — a library that requires a sidecar in order to *exist*
has a bootstrap problem on every path into it.

An earlier design put identity in `paperbox.json`, which made that file a
prerequisite. It is now an **override**. Delete every one of them and the library
is unchanged; you lose metadata, not your books.

## Three layers

A value should live in the lowest layer that can hold it.

### 1. Structure — the folder tree

```
Series/Chapter/pages
```

Defines what exists and, by default, what everything is called. **The only layer
that cannot be regenerated.**

### 2. Sidecar — `paperbox.json`, one per series

Pinned identity, upstream bindings, per-chapter provenance. Lives *inside* the
series folder, so it travels when the folder is renamed or moved. Absent for a
hand-managed library, and that is a valid state rather than a gap.

### 3. Index — fingerprints, node hashes, scan times

Pure derived cache. **Rebuildable, but expensive to rebuild** — losing it costs a
full deep scan, which is why it must be persisted properly rather than treated as
disposable.

Measured for a 5,000-series projection (710,000 chapters):

| | |
|---|---|
| On disk | 104 MB |
| Build from scratch | 4.3 s |
| Read all series hashes (cold start) | 2.87 ms |
| One series' chapters | 0.28 ms |
| Chapter by apiId | 0.08 ms |

~147 bytes per chapter including indexes. It belongs in SQLite off the FUSE layer,
not scattered through the tree. **Not yet built** — the index currently lives in
the sidecars, which at scale means thousands of FUSE reads before a single gate can
be evaluated.

## Identity

Derived from the path by default; pinned in the sidecar when it must survive a
rename.

```
uid   = meta.uid        ?? pathUid(seriesDir)
cuid  = chapterMeta.uid ?? pathUid(seriesDir, chapterDir)
apiId = meta.apiId      ?? allocate(uid)      // = hash31(uid) unless collided
```

`pathUid` is two FNV-1a-derived words rendered as 16 hex characters. Same path,
same id, on any machine, with no state anywhere. `hash31` folds to 31 bits so the
result is always a positive signed Int32, which the Suwayomi-compatible API
requires.

**Identity is only ever written to disk on a hash collision** — about 0.6% at 5,000
series, so roughly thirty series in a very large library carry a pinned id and the
rest need no file at all.

### The verified property

A test deletes every `paperbox.json` in a library and rescans. Every series id and
every chapter id comes back identical. That is what makes the sidecar optional, so
it is asserted rather than assumed.

### The accepted trade

Renaming a folder without a pinned uid changes identity, and clients treat the
chapter as new. That is the cost of zero configuration, and it is what Plex does
too. Reorganising should be something Paperbox *performs* — moving and renaming
while carrying identity — rather than something it detects afterwards.

Rename detection by fingerprint was designed and then **dropped**: it works, but it
answers a question the product should not be asking.

### Series renames are already safe

`paperbox.json` lives inside the series folder, so the uid travels with it. Rename
the directory or move it between shares and identity survives for free. That is a
real argument for keeping identity in the tree even after the performance index
moves to SQLite.

## The environment is hostile to metadata, and the design assumes it

The library sits on `fuse.shfs` — a union layer over several filesystems. This is
not bad luck; it is the **majority case** for the target audience. Unraid, mergerfs,
SnapRAID pools, NFS and SMB mounts. A self-hoster with a large library is very
likely behind exactly this kind of layer, because that is how you get a big pooled
array in the first place.

Three consequences, all measured on the real box:

- **No filesystem watching.** fsnotify does not work with FUSE — the filesystem
  never learns a watch was set. At 5,000 series that would be ~715,000 directories
  anyway (inotify is not recursive), roughly 770 MB of unswappable kernel memory,
  above the default watch limit on most kernels.
- **No bulk metadata reads.** There is no MFT to read, no `btrfs find-new`, no XFS
  bulkstat, because the mount is a composite of several filesystems.
- **~17,500 stats/sec ceiling**, with the FUSE daemon as the queue. Parallelism caps
  at about 7×, the knee is 8–16, and past 64 it is noise.

This constraint is *why* the index persists, why scans are tiered, and why a request
must never trigger a filesystem sweep. Those read as separate decisions but they are
one constraint with several consequences.

**The storage layer is chosen for durability and the sync layer adapts to it**, not
the other way round. Moving the library to unparitied cache for scan speed would
trade parity for milliseconds.

## Format constraints worth knowing

- **WebP cannot exceed 16,383 pixels in either dimension.** Stitched vertical pages
  run to 14,000 px in this library and ~19,000 px in libraries built by other
  pipelines — the latter *cannot* be stored as WebP, which is almost certainly why
  those pipelines emit JPEG. Any format policy needs a fallback, not a preference.
- **Shrink-on-load is not available** on the ImageMagick build in the container; it
  silently ignores `webp:decoding-scale`. Full decode is the floor for tall pages,
  and that sets the per-chapter cost of anything analysing images at ingest.
- Page widths are effectively standardised (800, 940, 1200) with height varying, so
  reasoning in fractions of page width is portable across series.
