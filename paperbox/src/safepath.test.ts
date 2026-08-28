import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { safeSegment, resolveWithin, isDirectChild, UnsafeNameError } from "./safepath";

describe("safeSegment", () => {
  test("leaves legitimate titles exactly as they were", () => {
    // These must not change: existing series live in directories named by the
    // old implementation, and a different answer strands them.
    expect(safeSegment("SSS-Class Suicide Hunter")).toBe("SSS-Class Suicide Hunter");
    expect(safeSegment("Nano Machine")).toBe("Nano Machine");
    expect(safeSegment("Chapter 071")).toBe("Chapter 071");
    expect(safeSegment("Re:Zero")).toBe("Re_Zero");
    expect(safeSegment("What/Where")).toBe("What_Where");
    expect(safeSegment("  padded  ")).toBe("padded");
  });

  test("rejects the names that reached rename() and rm -rf", () => {
    for (const bad of ["..", ".", "", "   ", "  ..  ", "../..", "./."]) {
      expect(() => safeSegment(bad)).toThrow(UnsafeNameError);
    }
  });

  test("rejects dot-prefixed names, which the scanner cannot see anyway", () => {
    expect(() => safeSegment(".hidden")).toThrow(UnsafeNameError);
    expect(() => safeSegment(".staging-Chapter 001")).toThrow(UnsafeNameError);
  });

  test("strips control characters", () => {
    expect(safeSegment("Chapter\u0000001")).toBe("Chapter_001");
    expect(safeSegment("a\u001fb")).toBe("a_b");
  });

  test("never returns a value containing a separator", () => {
    for (const name of ["a/b", "a\\b", "../../etc/passwd", "x/../y"]) {
      let out: string | null = null;
      try {
        out = safeSegment(name);
      } catch {
        continue;
      }
      expect(out).not.toContain("/");
      expect(out).not.toContain("\\");
    }
  });
});

describe("isDirectChild", () => {
  test("accepts a direct child only", () => {
    expect(isDirectChild("/manga/Series", "/manga/Series/Chapter 001")).toBe(true);
    expect(isDirectChild("/manga/Series", "/manga/Series/.staging-Chapter 001")).toBe(true);
  });

  test("rejects the base itself, ancestors, and deeper descendants", () => {
    expect(isDirectChild("/manga/Series", "/manga/Series")).toBe(false);
    expect(isDirectChild("/manga/Series", "/manga")).toBe(false);
    expect(isDirectChild("/manga/Series", "/")).toBe(false);
    expect(isDirectChild("/manga/Series", "/manga/Other/Chapter")).toBe(false);
    expect(isDirectChild("/manga/Series", "/manga/Series/a/b")).toBe(false);
  });
});

describe("resolveWithin", () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), "paperbox-safepath-"));
    root = join(base, "manga");
    await mkdir(join(root, "Series", "Chapter 001"), { recursive: true });
    await writeFile(join(root, "Series", "Chapter 001", "001.jpg"), "page");
    outside = join(base, "secret.txt");
    await writeFile(outside, "SECRET");
    await symlink(outside, join(root, "Series", "escape.jpg"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  test("resolves a legitimate page", async () => {
    const r = await resolveWithin(root, "Series/Chapter 001/001.jpg");
    expect(r).not.toBeNull();
    expect(r!.endsWith("001.jpg")).toBe(true);
  });

  test("blocks the encodings that returned 200 against the live server", async () => {
    // Verified against the running container before the fix: each of these
    // served a file from outside the library with HTTP 200.
    for (const attack of [
      "../secret.txt",
      "%2e%2e%2fsecret.txt",
      "%2E%2E%2Fsecret.txt",
      "..%2fsecret.txt",
      "Series/../../secret.txt",
      "../../etc/passwd",
      "/etc/passwd",
    ]) {
      const decoded = decodeURIComponent(attack);
      expect(await resolveWithin(root, decoded)).toBeNull();
    }
  });

  test("blocks a symlink escaping the library", async () => {
    // Neither the old check nor @elysiajs/static catches this one: the string
    // is entirely well-behaved and the escape happens in the filesystem.
    expect(await resolveWithin(root, "Series/escape.jpg")).toBeNull();
  });

  test("returns null for a missing file rather than throwing", async () => {
    expect(await resolveWithin(root, "Series/Chapter 001/999.jpg")).toBeNull();
  });

  test("rejects empty input and NUL bytes", async () => {
    expect(await resolveWithin(root, "")).toBeNull();
    expect(await resolveWithin(root, "Series/\u0000.jpg")).toBeNull();
  });
});
