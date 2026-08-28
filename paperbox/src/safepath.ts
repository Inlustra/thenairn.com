/**
 * Containment for paths built from untrusted input.
 *
 * Two separate jobs, deliberately not merged:
 *
 *   safeSegment()   - a name from a POST body or a scraped page becomes exactly
 *                     one directory segment, or the caller fails loudly.
 *   resolveWithin() - a client-supplied relative path resolves to a real file
 *                     inside a root, or null.
 *
 * The write side matters more than the read side: a bad read leaks a file, a
 * bad write reaches `rename` and `rm -rf` inside the user's library.
 */
import { resolve, relative, isAbsolute, sep } from "node:path";
import { realpath } from "node:fs/promises";

export class UnsafeNameError extends Error {
  constructor(name: string, why: string) {
    super(`Unsafe path segment ${JSON.stringify(name)}: ${why}`);
    this.name = "UnsafeNameError";
  }
}

/** Characters illegal in a path segment: Windows-reserved plus C0 controls. */
const ILLEGAL_SEGMENT = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Reduce an untrusted name to one safe path segment.
 *
 * The character rewrite is what it has always been (plus control characters,
 * which have no business in a filename), so every legitimate title maps to the
 * directory it already maps to today - changing that would strand existing
 * series under their old names. What is new is that the pathological results
 * are *rejected* rather than returned: `..`, `.`, empty and dot-prefixed names
 * previously passed through untouched, and were joined straight into a path
 * that gets renamed and recursively deleted.
 */
export function safeSegment(name: string): string {
  const cleaned = name.replace(ILLEGAL_SEGMENT, "_").trim();
  if (cleaned === "") throw new UnsafeNameError(name, "empty after cleaning");
  if (cleaned === "." || cleaned === "..") throw new UnsafeNameError(name, "path traversal");
  // A dot-prefixed directory is also invisible to the scanner (isHidden), so a
  // download into one would silently never appear in the library.
  if (cleaned.startsWith(".")) throw new UnsafeNameError(name, "hidden/dot-prefixed");
  return cleaned;
}

/** True when `target` is a direct child of `base` - not `base`, not a descendant. */
export function isDirectChild(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(sep);
}

/**
 * Assert a path we are about to rename or delete sits directly inside `base`.
 * Cheap, synchronous, and the last line of defence before a destructive call.
 */
export function assertDirectChild(base: string, target: string, what: string): void {
  if (!isDirectChild(base, target)) {
    throw new UnsafeNameError(target, `${what} escapes ${base}`);
  }
}

/**
 * Resolve a client-supplied path inside `root`, or null if it escapes.
 *
 * Decodes *before* checking - the previous implementation tested the raw
 * string for ".." and then decoded, so `%2e%2e%2f` walked straight past it.
 * Also resolves symlinks: a link inside the library pointing outside it is an
 * escape that no amount of string checking catches.
 */
export async function resolveWithin(root: string, userPath: string): Promise<string | null> {
  if (!userPath || userPath.includes("\u0000")) return null;

  const base = await realpath(resolve(root)).catch(() => resolve(root));
  const target = resolve(base, userPath);

  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;

  // The file must exist to be resolved; a missing file is a 404, not an escape.
  const real = await realpath(target).catch(() => null);
  if (real === null) return null;

  const relReal = relative(base, real);
  if (relReal.startsWith("..") || isAbsolute(relReal)) return null;
  return real;
}

/** Decode a URL path segment, falling back to the raw string on bad escapes. */
export function tryDecode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}
