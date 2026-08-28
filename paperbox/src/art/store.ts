/**
 * The derived store -- everything Paperbox computes *about* the library, kept
 * strictly outside it.
 *
 * -------------------------------------------------------------------------
 * Why it exists
 * -------------------------------------------------------------------------
 * The only derived artefact this project had was a cover, and it was written
 * into the user's library as `cover.webp` beside their pages. `ui.md` makes an
 * unqualified promise -- *the files belong to the user; never moved, never
 * renamed, never rewritten* -- and a generated file appearing in a folder the
 * user curates is exactly the kind of thing that promise is for. There was also
 * no invalidation rule, no serving path, and nothing that could regenerate one.
 *
 * -------------------------------------------------------------------------
 * The two properties that matter
 * -------------------------------------------------------------------------
 * **1. It is safe to delete entirely.** `rm -rf $DERIVED_DIR` costs CPU and
 * never data. Nothing here is a source of truth, nothing here is the only copy
 * of anything, and the store is rebuilt by asking for a picture that is missing.
 * That is why `DERIVED_DIR` may have a default at all, and why `READSTATE_DB`
 * (see `src/readstate/schema.ts`) may not: read state cannot be recomputed.
 *
 * **2. A stale artefact cannot be served, because it cannot be addressed.**
 * The key is a digest of every input that determines the pixels -- the
 * extraction version, the kind, the subject's uid, and the subject's
 * fingerprint. Move any of them and the key moves with it, so the reader looks
 * in a place where nothing has been written yet and gets a 404. There is no
 * "check whether this is out of date" step to forget, because being out of date
 * is not representable.
 *
 * The obvious alternative -- `spine/<chapterUid>.webp` plus a stored fingerprint
 * to compare against -- fails in the one direction that matters: if the compare
 * is skipped, or the recorded fingerprint is written before the picture, the
 * server serves the wrong artwork and nothing anywhere says so.
 */
import { mkdir, rename, unlink, stat, readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { randomUUID } from "node:crypto";
import { ART_VERSION } from "./version";

export type ArtKind = "spine" | "cover" | "tint";

/**
 * Read at call time, never bound at module load: the tests point it at a
 * temporary directory, and binding it once made the scanner's env-driven paths
 * order-dependent across suites (see `src/scanner/index.ts`).
 */
export function derivedDir(): string {
  return process.env.DERIVED_DIR || "/data/derived";
}

/**
 * 96 bits of the digest, not the 64 that `fingerprint.ts` uses for change
 * detection. A change detector compares two values it already holds; a store
 * key is looked up blind, so a collision here does not report a false change,
 * it serves one chapter's artwork under another chapter's name. At the R-12
 * target of 710k chapters with three artefacts each, 96 bits removes the
 * question and costs eight more bytes of filename.
 */
const KEY_LEN = 24;

export function artKey(kind: ArtKind, ...inputs: (string | number | undefined)[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`v${ART_VERSION}`);
  hasher.update(" ");
  hasher.update(kind);
  for (const i of inputs) {
    hasher.update(" ");
    hasher.update(i === undefined ? "" : String(i));
  }
  return hasher.digest("hex").slice(0, KEY_LEN);
}

const EXT: Record<ArtKind, string> = { spine: "webp", cover: "webp", tint: "json" };

/**
 * Fanned out two levels on the key. 710k files in one directory is a directory
 * the tooling on this box cannot list; two levels of 256 gives ~11 entries per
 * leaf at target scale, and the fan-out is derived from the key itself so it
 * needs no index of its own.
 */
export function artPath(kind: ArtKind, key: string): string {
  return join(derivedDir(), kind, key.slice(0, 2), key.slice(2, 4), `${key}.${EXT[kind]}`);
}

export interface StoredArt {
  path: string;
  key: string;
  size: number;
  /** Strong: the key identifies the bytes exactly, so equal key means equal body. */
  etag: string;
}

export async function find(kind: ArtKind, key: string): Promise<StoredArt | null> {
  const path = artPath(kind, key);
  try {
    const s = await stat(path);
    if (s.size === 0) return null;
    return { path, key, size: s.size, etag: `"${kind}-${key}"` };
  } catch {
    return null;
  }
}

export async function has(kind: ArtKind, key: string): Promise<boolean> {
  return (await find(kind, key)) !== null;
}

/**
 * Write through a unique temporary name and rename into place.
 *
 * Same reasoning as `saveMeta`: a torn file here is not a lost artefact, it is
 * a *readable* artefact of the wrong length, which the serving path would hand
 * out with a long cache lifetime. Two workers racing on one key write identical
 * bytes, so the rename is a no-op either way -- but a shared `.tmp` name would
 * have them interleave into one file.
 */
export async function put(kind: ArtKind, key: string, body: Uint8Array | string): Promise<StoredArt> {
  const path = artPath(kind, key);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, body);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  const size = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
  return { path, key, size, etag: `"${kind}-${key}"` };
}

export async function readJson<T>(kind: ArtKind, key: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(artPath(kind, key), "utf-8")) as T;
  } catch {
    return null;
  }
}
