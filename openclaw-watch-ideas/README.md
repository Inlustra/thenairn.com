# Watch Ideas

Gives Milo (agent `concierge`) a way to help people find films and series they'd
like, by searching the web and reading what comes back, without giving a
WhatsApp guest any way to point him at a link. Added 2026-09-24 at Thomas's
request.

## What Milo gets

- **`find_watch_ideas`** - a search through the Gateway's configured provider
  (DuckDuckGo, `uk-en`, `moderate`). Refuses a query carrying a URL, hostname,
  IP, search operator (`site:` ...), control characters, or nothing about film
  or TV. Returns titles, snippets and each result's own address; links inside
  snippets are stripped.
- **`web_fetch`**, gated. Search snippets rarely name the shows ("every isekai
  airing this season...") - the list is on the page. A `before_tool_call` hook
  lets `web_fetch` through only for a URL that `find_watch_ideas` returned in
  the **same session** (canonicalised, 6 h TTL, in memory). A pasted link was
  never a search result, and neither is a link inside a fetched page, so both
  are refused in code as well as by the skill. Core `web_fetch` keeps its own
  private-network blocking.
- **`find_anime`** - AniList's public GraphQL API (no key). `season` mode lists
  a season's shows by popularity, filterable by genre and tags (`Isekai`);
  `similar` mode returns AniList users' recommendations for a title. Endpoint
  and queries are fixed in `anilist.mjs`; the model supplies checked variables
  only. The AniList *website* is JavaScript-only, so `web_fetch` cannot read it.

- **`check_library`** and library labels on every `find_anime` result
  (added 2026-09-24). `library.mjs` reads Sonarr, AnimeSonarr, Radarr and
  AnimeRadarr (fixed addresses, keys read from their `config.xml`, lists cached
  10 min) and returns one plain line per title: ready to watch, already set to
  download with the next episode or release date, or not in the library. So
  Milo tells people what is already coming instead of pitching it, and the
  library's date wins over AniList's. Read-only; Milo never sees keys or IDs.
  Matching is by normalised title and alternate titles, so an odd spelling can
  miss and read as "not in the library".

The same hook refuses `web_search`, `x_search`, `browser*`, `firecrawl_*`,
`tavily_*`, `exa_*` and `canvas` for guarded agents (config `agents`, default
`["concierge"]`), whatever their allowlist says.

Why not plain `web_search` + `web_fetch`: `web_fetch` has a hostname blocklist
but no allowlist, so ungated it opens any link a guest sends; `web_search`
takes any query, making Milo a general web search for the approved list.

## Wiring

- `plugins.load.paths` includes this directory; `plugins.entries.watch-ideas`
  is enabled.
- `agents.entries.concierge.tools.allow` includes `find_watch_ideas`, `find_anime`, `check_library` and `web_fetch`.
- `agents.entries.concierge.skills` is `["find-something-to-watch"]`, which
  lives at `/mnt/user/HQ/concierge/skills/find-something-to-watch/SKILL.md`
  and is gated on this plugin being enabled.
- Milo's briefs (`concierge/AGENTS.md`, `agent-policy/roles/milo.md`) list it as
  live; `concierge/tests/conversation-cases.md` has the cases.

Gateway log lines: `watch-ideas: "<query>" -> N result(s)`, `refused query (...)`,
`web_fetch allowed for <agent>: <url>`, `web_fetch refused ... (not a search result)`,
`anilist <mode> "<label>"`.

## Tests

`node search.test.mjs` - query checks, result sanitising, the per-session URL gate and AniList input checks; no Gateway needed.

## Rollback

Remove `web_fetch` from Milo's `tools.allow` to go back to snippets only; remove
all three tools and the skill to remove the capability. Config backups:
`${OPENCLAW_CONFIG_DIR}/openclaw.json.bak-watch-ideas-*` (before any of it) and
`...bak-watch-ideas-fetch-*` (before web_fetch and find_anime), `...bak-watch-ideas-library-*` (before check_library).
