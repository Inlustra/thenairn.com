// node search.test.mjs - no Gateway needed.
import assert from "node:assert/strict";
import { checkQuery, sanitizeResults, formatResults, isForbiddenTool, stripLinks } from "./search.mjs";

const refused = [
  "https://example.com/film",
  "http://192.168.96.14:8123",
  "check out letterboxd.com films",
  "films on www.imdb",
  "example．com film",             // fullwidth dot
  "site:reddit.com best films",
  "site: reddit best tv series",
  "10.0.0.1 film",
  "film ftp://files",
  "cheap flights to paris",       // off topic
  "weather tomorrow",
  "hi",
  "x".repeat(200) + " film",
  "film\u0000night",
];
for (const q of refused) assert.equal(checkQuery(q).ok, false, `should refuse: ${q}`);

const allowed = [
  "best new TV series September 2026",
  "films like Knives Out",
  "Mr. Robot similar TV series",
  "M.A.S.H style comedy series",
  "critically acclaimed Korean thriller film",
  "Mission: Impossible films in order",
  "Star Wars: Andor season 2 reviews",
  "what to watch on a rainy sunday family film",
  "Se7en director other movies",
];
for (const q of allowed) assert.equal(checkQuery(q).ok, true, `should allow: ${q}`);

assert.equal(checkQuery(123).ok, false);

const payload = {
  kind: "results",
  results: [
    { title: "Best shows of 2026 - example.com", url: "https://example.com/a", snippet: "See https://evil.test/x and www.foo.bar for more. Slow Horses tops the list.", siteName: "Example", published: "2026-09-01T00:00:00Z" },
    { title: "", url: "https://x.y", snippet: "" },
    { title: "Andor review", url: "https://z.example/r", snippet: "A tense spy drama." },
  ],
};
const s = sanitizeResults(payload, 6);
assert.equal(s.ok, true);
assert.equal(s.results.length, 2);
const out = formatResults("q film", s.results);
// Result URLs are openable; links inside provider text are still stripped.
assert.ok(out.includes("https://example.com/a"), out);
assert.ok(!/evil\.test|foo\.bar/i.test(out), out);
assert.ok(out.includes("Slow Horses"));
assert.ok(out.includes("2026-09-01"));

assert.equal(sanitizeResults({ kind: "error", error: "provider_error" }, 6).ok, false);
assert.equal(sanitizeResults({ results: [{ title: "a" }, { title: "b" }, { title: "c" }] }, 2).results.length, 2);

for (const t of ["web_search", "x_search", "browser", "firecrawl_scrape", "tavily_extract"]) assert.ok(isForbiddenTool(t), t);
for (const t of ["web_fetch", "find_watch_ideas", "sessions_send", "automations", "ask_user"]) assert.ok(!isForbiddenTool(t), t);

assert.equal(stripLinks("go to https://a.b/c now", 100), "go to now");
import { SearchedUrls, canonicalUrl } from "./search.mjs";
const su = new SearchedUrls({ ttlMs: 1000 });
su.add("s1", ["https://ScreenRant.com/every-isekai/#top", "javascript:alert(1)", "file:///etc/passwd"], 0);
assert.ok(su.has("s1", "https://screenrant.com/every-isekai/", 10));
assert.ok(su.has("s1", "https://screenrant.com/every-isekai", 10));
assert.ok(!su.has("s2", "https://screenrant.com/every-isekai", 10), "other session");
assert.ok(!su.has("s1", "https://screenrant.com/every-isekai", 5000), "expired");
assert.ok(!su.has("s1", "https://evil.test/", 10));
assert.ok(!su.has("s1", "https://screenrant.com/every-isekai?x=1", 10), "query differs");
assert.ok(!su.has("", "https://screenrant.com/every-isekai", 10));
assert.equal(canonicalUrl("https://user:pw@a.com/"), "");
console.log("ok");

import { buildRequest, currentSeason, formatAnswer } from "./anilist.mjs";
assert.deepEqual(currentSeason(new Date("2026-09-24T00:00:00Z")), { season: "SUMMER", year: 2026 });
assert.deepEqual(currentSeason(new Date("2026-10-02T00:00:00Z")), { season: "FALL", year: 2026 });
const r1 = buildRequest({ mode: "season", season: "fall", year: 2026, tags: ["Isekai"] }, new Date("2026-09-24Z"));
assert.equal(r1.variables.season, "FALL");
assert.ok(buildRequest({ mode: "season", genre: "Nope" }).error);
assert.ok(buildRequest({ mode: "season", tags: ["a}{b"] }).error);
assert.ok(buildRequest({ mode: "season", tags: ["a", "b", "c", "d"] }).error);
assert.ok(buildRequest({ mode: "season", year: 3000 }).error);
assert.ok(buildRequest({ mode: "similar", title: "https://anilist.co/anime/1" }).error);
assert.ok(buildRequest({ mode: "fetch" }).error);
assert.equal(buildRequest({ mode: "similar", title: "Re:Zero" }).variables.search, "Re:Zero");
const fa = formatAnswer("similar", "like x", { Media: { title: { english: "X" }, recommendations: { nodes: [
  { rating: 5, mediaRecommendation: { title: { romaji: "A" }, isAdult: false, seasonYear: 2020 } },
  { rating: 4, mediaRecommendation: { title: { romaji: "B" }, isAdult: true } },
] } } });
assert.ok(fa.includes("A") && !fa.includes("2. B"), fa);
console.log("anilist ok");
