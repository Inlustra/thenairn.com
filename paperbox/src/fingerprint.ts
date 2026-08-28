// Leaf hashing, kept separate so both the scanner and the sync tree can use it
// without importing each other.

import { stat } from "fs/promises";
import { join } from "path";

const HASH_LEN = 16; // 8 bytes of hex: change detection, not security

export function digest(parts: string[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const p of parts) {
    hasher.update(p);
    hasher.update(" ");
  }
  return hasher.digest("hex").slice(0, HASH_LEN);
}

/** Name plus byte size. Deliberately not mtime -- that changes on any copy. */
export function pageFingerprint(file: string, size: number): string {
  return digest([file, String(size)]);
}

export interface PageStat { file: string; size: number }

/** Stat every page in a chapter. The expensive call -- results are persisted. */
export async function statPages(dir: string, files: string[]): Promise<PageStat[]> {
  const out: PageStat[] = [];
  for (const file of files) {
    try {
      out.push({ file, size: (await stat(join(dir, file))).size });
    } catch {}
  }
  return out;
}

export function fingerprintFrom(pages: PageStat[]): string {
  return digest(pages.map((p) => pageFingerprint(p.file, p.size)));
}

/** Chapter-level hash over its pages. Called by the scanner, then persisted. */
export async function chapterFingerprint(dir: string, files: string[]): Promise<string> {
  return fingerprintFrom(await statPages(dir, files));
}
