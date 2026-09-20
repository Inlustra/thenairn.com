import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STATE,
  extractRecentTurns,
  normalizeCorrelationText,
  parseDirectorResult,
  redactAndBoundText,
  SessionDeliveryStore,
  withTimeout,
} from "./director.mjs";

test("correlation normalization removes delivery directives but preserves words", () => {
  assert.equal(
    normalizeCorrelationText("[[reply_to_current]] Hello   there. [[audio_as_voice]]"),
    "Hello there.",
  );
});

test("context is redacted and bounded", () => {
  const text = redactAndBoundText("Email me@example.com at https://example.com/secret " + "x".repeat(400), 90);
  assert.match(text, /\[email\]/u);
  assert.match(text, /\[url\]/u);
  assert.ok(text.length <= 90);
});

test("recent turns keep only bounded user and assistant text", () => {
  const turns = extractRecentTurns([
    { role: "system", content: "hidden" },
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: [{ type: "text", text: "two" }] },
    { role: "user", content: "three" },
  ], 2, 80);
  assert.deepEqual(turns, [{ role: "assistant", text: "two" }, { role: "user", text: "three" }]);
});

test("director result validates state enums and one-line instruction", () => {
  const parsed = parseDirectorResult(JSON.stringify({
    state: { mood: "reassuring", energy: "low", pace: "measured", stance: "supportive", emphasis: "gentle-reassurance" },
    instruct: "Speak gently, with measured pacing and quiet reassurance.",
  }));
  assert.deepEqual(parsed, {
    state: { mood: "reassuring", energy: "low", pace: "measured", stance: "supportive", emphasis: "gentle-reassurance" },
    instruct: "Speak gently, with measured pacing and quiet reassurance.",
  });
  assert.equal(parseDirectorResult("not json"), null);
  assert.equal(parseDirectorResult(JSON.stringify({ state: DEFAULT_STATE, instruct: "x".repeat(241) })), null);
});

test("session store is per-session, correlated by exact normalized response, and bounded", () => {
  let now = 1000;
  const store = new SessionDeliveryStore({ maxSessions: 2, ttlMs: 1000, now: () => now });
  store.captureTurn("s1", "user", "context one");
  store.correlate("s1", "[[audio_as_voice]] Exact response");
  store.captureTurn("s2", "user", "context two");
  assert.equal(store.resolve("Exact response")?.sessionKey, "s1");
  assert.equal(store.resolve("Different response"), null);
  store.captureTurn("s3", "user", "context three");
  assert.equal(store.sessions.size, 2);
  now = 3000;
  store.prune();
  assert.equal(store.sessions.size, 0);
});

test("timeout aborts director work", async () => {
  let aborted = false;
  await assert.rejects(
    withTimeout((signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    }), 15),
    /timed out/u,
  );
  assert.equal(aborted, true);
});
