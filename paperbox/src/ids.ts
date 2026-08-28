// Stable, content-derived identifiers.
//
// The Suwayomi/Tachidesk contract types manga.id and chapter.id as Int, so
// clients cache small integers and reuse them forever. Deriving those from scan
// position (the old `list.indexOf(m)`) meant any added, removed or renamed
// directory silently repointed every cached id on every device -- a client
// holding id 3 for one series would later resolve it to a different series
// entirely, and no amount of refreshing could correct it, because refreshing
// re-fetches the *wrong* id faithfully.
//
// Ids are now derived from a uid that lives in the series metadata file, and the
// resulting Int is pinned there too, so it survives renames and any future
// change to collision handling.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a folded to 31 bits: always positive, always fits a signed Int32. */
export function hash31(input: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return (h >>> 0) & 0x7fffffff;
}

/**
 * Assigns ids, honouring ones already pinned in metadata and probing forward
 * when two uids hash to the same slot. Ownership is tracked by uid so a pinned
 * id is only rejected when a *different* series already holds it.
 */
export class IdAllocator {
  private used = new Map<number, string>();

  /** Take a pinned id. False means another owner already holds it. */
  claim(id: number, owner: string): boolean {
    if (!Number.isInteger(id) || id <= 0 || id > 0x7fffffff) return false;
    const held = this.used.get(id);
    if (held !== undefined && held !== owner) return false;
    this.used.set(id, owner);
    return true;
  }

  /** Allocate a fresh id for `owner`, probing past collisions. */
  allocate(owner: string): number {
    let id = hash31(owner) || 1; // 0 is reserved -- the default category uses it
    let guard = 0;
    while (!this.claim(id, owner)) {
      id = (id + 1) & 0x7fffffff || 1;
      if (++guard > 1_000_000) throw new Error(`id space exhausted for ${owner}`);
    }
    return id;
  }

  /** Pinned id if valid and free, otherwise a freshly allocated one. */
  resolve(pinned: number | undefined, owner: string): number {
    if (pinned !== undefined && this.claim(pinned, owner)) return pinned;
    return this.allocate(owner);
  }
}

/**
 * Identity derived from where a thing sits on disk.
 *
 * The folder structure IS the library: drop a directory in and it must appear
 * immediately, with a stable id, without any sidecar file being generated
 * first. Every mature library server works this way -- structure is truth,
 * metadata is enrichment layered on afterwards.
 *
 * A pinned uid in paperbox.json overrides this when identity needs to survive a
 * rename. Absent that, renaming a folder is a new identity, which is the
 * accepted trade for zero-configuration.
 */
export function pathUid(...parts: string[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const input = parts.join("\u0000");
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) ^ (h1 >>> 13);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `p${hex(h1)}${hex(h2)}`;
}

/**
 * Time-ordered unique id. Not a strict ULID -- it needs no dependency and is
 * only ever compared for equality, never parsed.
 */
export function newUid(): string {
  const time = Date.now().toString(36).padStart(9, "0");
  let rand = "";
  for (let i = 0; i < 16; i++) rand += Math.floor(Math.random() * 36).toString(36);
  return `${time}${rand}`;
}
