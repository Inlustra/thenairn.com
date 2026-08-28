import { describe, expect, test } from "bun:test";
import { summariseDownloads } from "./manager";

describe("downloads summary", () => {
  test("returns a content signature, not a counter", () => {
    const a = summariseDownloads();
    const b = summariseDownloads();
    // Nothing changed between calls, so the signal must not move. A counter
    // would have incremented here and forced a needless refetch.
    expect(a.sig).toBe(b.sig);
    expect(typeof a.sig).toBe("string");
  });

  test("exposes the progress that counts alone cannot express", () => {
    const s = summariseDownloads();
    expect(s).toHaveProperty("pagesDone");
    expect(s).toHaveProperty("pagesTotal");
    expect(s).not.toHaveProperty("rev");
  });
});
