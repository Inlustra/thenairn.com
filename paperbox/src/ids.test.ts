import { describe, expect, test } from "bun:test";
import { hash31, IdAllocator, newUid } from "./ids";

describe("hash31", () => {
  test("is deterministic", () => {
    expect(hash31("sss-class-suicide-hunter")).toBe(hash31("sss-class-suicide-hunter"));
  });

  test("always fits a positive signed Int32", () => {
    for (const s of ["", "a", "Nano Machine", "x".repeat(500), "文字化け"]) {
      const h = hash31(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0x7fffffff);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  test("separates similar inputs", () => {
    expect(hash31("Chapter 071")).not.toBe(hash31("Chapter 072"));
  });
});

describe("IdAllocator", () => {
  test("gives the same uid the same id every time", () => {
    expect(new IdAllocator().allocate("uid-a")).toBe(new IdAllocator().allocate("uid-a"));
  });

  test("never returns 0 -- the default category owns it", () => {
    const a = new IdAllocator();
    expect(a.allocate("uid-a")).not.toBe(0);
  });

  test("probes past a collision instead of overwriting", () => {
    const a = new IdAllocator();
    const first = a.allocate("uid-a");
    expect(a.claim(first, "uid-b")).toBe(false);   // taken by a different owner
    expect(a.claim(first, "uid-a")).toBe(true);    // idempotent for the owner
    const second = a.resolve(first, "uid-b");      // pinned but unavailable
    expect(second).not.toBe(first);
  });

  test("honours a pinned id that is free", () => {
    expect(new IdAllocator().resolve(12345, "uid-a")).toBe(12345);
  });

  test("rejects out-of-range pinned ids", () => {
    const a = new IdAllocator();
    expect(a.claim(0, "uid-a")).toBe(false);
    expect(a.claim(-1, "uid-a")).toBe(false);
    expect(a.claim(2 ** 31, "uid-a")).toBe(false);
  });
});

describe("newUid", () => {
  test("does not collide across rapid calls", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => newUid()));
    expect(seen.size).toBe(2000);
  });
});
