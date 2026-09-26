# harness

Tower's agent harness: **Milo** on WhatsApp for the people Tom approves, **Thor**
on Telegram for Tom, and a **media agent** behind them both. It replaced OpenClaw
on 2026-09-26. Bun + TypeScript, ~3k lines, driving OpenAI Codex (`codex
app-server`, pinned in `package.json`) on Tom's ChatGPT subscription.

Runs as the `harness` container (`../docker-compose.harness.yml`). All state is
in `${CONFIG_DIR}/harness`; the image holds only code.

## The shape of it

- **Code decides, models talk.** Who's approved, what was requested, when
  someone is owed an update: all SQLite, all code. Models write the words.
- **Milo is fenced structurally.** His Codex threads have no execution
  environment and every optional Codex feature off (`src/milo.ts`). He can only
  call the tools defined there, and only reaches a phone through `send_message`
  / `show_poster`: his final reply text is never sent. Owner-only tools exist
  only in Tom's own thread.
- **Unknown numbers never reach a model.** They're held; Tom gets a notice and
  replies `approve` / `deny` (`src/router.ts`).
- **Requests are followed in code.** `src/jobs.ts` polls Sonarr/Radarr/Plex,
  spots stalls, swaps stalled copies (twice), then hands over to the media
  agent, and owes the person updates through a durable outbox. Nothing relies
  on a model remembering to check back.
- **Guest text never reaches a full-access agent.** Thor and the media agent see
  IDs and states, not guest-written text (except a guest's problem report,
  labelled as untrusted).

## Files

| | |
|---|---|
| `src/main.ts` | Wiring; startup self-check |
| `src/codex.ts` | `codex app-server` client (one process, per-thread lockdown, token hand-over) |
| `src/auth.ts` | ChatGPT tokens, owned by the harness, refreshed one at a time |
| `src/agent.ts` | One Codex thread per contact; persistent inbox; retries; thread rotation |
| `src/milo.ts` | Milo's tools, header, delivery rules, welcome-back |
| `src/router.ts` | Inbound WhatsApp: approvals, rate limit, dedupe |
| `src/media.ts` | The media desk: lookups, adds, progress, Plex check, retries, cancel |
| `src/jobs.ts` | The check-in loop and outbox |
| `src/backstage.ts` | Thor and the media agent |
| `src/memory.ts` | Mem0 (per-person memory), extraction via Codex, local embeddings |
| `src/plex.ts` | Library browsing and watch history |
| `src/console.ts`, `console.html` | harness.thenairn.com: every conversation in full |
| `src/channels/` | WhatsApp (Baileys), Telegram, and a local test channel |
| `prompts/` | Milo, Milo-with-Tom, Thor, media agent briefs |
| `shims/better-sqlite3` | bun:sqlite stand-in for Mem0's native dependency |

## State (`${CONFIG_DIR}/harness`)

`harness.sqlite` (people, requests, outbox, trace), `whatsapp-auth/` (Baileys
session for Milo's number), `codex/` (Codex home; no auth.json: tokens are
handed over in memory), `credentials.json` (ChatGPT tokens, Telegram bot token;
mode 600), `memory-*.sqlite` (Mem0), `local_cache/` (embedding model).

## Operating it

```bash
cd /mnt/user/HQ/thenairn.com
docker compose -p thenairncom up -d --build --no-deps harness   # deploy a change
docker logs -f harness                                           # watch it
```

Test without WhatsApp: run it with `TEST_PORT=7811` (a local fake WhatsApp;
`POST /in`, `GET /out`) and `MEDIA_DRY_RUN=1` (reads the real stack, changes
nothing). The console's "+ New test guest" then talks to Milo as a stranger.

**OpenClaw must not run alongside it.** It holds the same WhatsApp session and
Telegram bot; two holders fight and WhatsApp can unlink the device. It's behind
the `openclaw` Compose profile and its channels are disabled in `openclaw.json`.
