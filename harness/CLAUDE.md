# harness

Read `README.md` first: what this is, how it's built, and how to deploy it.

- Bun, not Node: `bun src/main.ts`, `bun test`, `bunx tsc --noEmit -p .` to type-check.
- Deploy with `docker compose -p thenairncom up -d --build --no-deps harness` from `..`. Never an unqualified `up`.
- Milo's safety is structural: keep his threads `locked` with no execution environment, keep owner tools behind `guard()`, and never let guest-written text reach Thor or the media agent.
- Before changing how Milo talks, test it: `TEST_PORT=7811 MEDIA_DRY_RUN=1` and the console's test guest.
- The Codex binary is pinned in `package.json`; `dynamicTools` is an experimental app-server API. After any upgrade, re-check that Milo's tools still work and that his code sandbox still has no filesystem or network.
