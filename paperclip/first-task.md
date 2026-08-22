# Inventory check: what RainnWorks actually has

Your first job is to find out what exists. Not to propose structure — that comes
after, and it will be worth more once it is based on fact rather than on what we
half-remember.

## Context
RainnWorks is Thomas Nairn's French company (EURL/SARL). He is the sole associate
and gérant. It is the commercial entity behind his contracting work — he is CTO
at Rowm, contracted through RainnWorks — and it is also the umbrella for his own
projects and the home infrastructure that supports them.

Treat that as a summary that may be stale. Part of this task is telling us what
is actually true.

## What you have access to
You are running in the `paperclip` container on Tower, the Unraid server that
hosts most of this.

- **`/mnt/user/HQ`** (read-write) — where the box is operated from. Working
  repos, the shared Claude configuration, infrastructure.
- **`/mnt/user/Internal`** (read-only) — ~35 project repos, most dormant since
  2020–2023.
- **GitHub** — `gh` is installed and authenticated as `Inlustra`, with access to
  the `RainnWorks` and `Inlustra` orgs including private repos. `gh api` and
  `gh repo list` work. `git clone` works over HTTPS for private repos too.
  There is deliberately no SSH key in this container: git@github.com remotes are
  rewritten to HTTPS and authenticated with the gh token, so a leak here does not
  hand over the server's identity.
- **Docker** — the stack on this box is defined by `COMPOSE_FILE` in
  `/mnt/user/HQ/thenairn.com/.env`, which lists every compose file.

## What to inventory
1. **The server.** What is actually running on Tower, what each thing is for, and
   what is dead but still switched on. The compose stack is the map.
2. **HQ.** What each directory is, which are git repos and where they point,
   which are live versus retired. Include the shared Claude configuration
   (skills, commands, plugins) — that is the environment agents inherit.
3. **GitHub / RainnWorks.** Every repo in the org: what it is, whether it is
   active or abandoned, and whether it corresponds to anything checked out on
   this box. Note repos that exist on GitHub but not locally, and vice versa.
4. **Internal.** A lighter pass — enough to say what is there and whether any of
   it still matters.

## What we want out of it
An inventory we can act on:
- what exists, and what each thing is actually for
- what is alive, what is abandoned, and what is ambiguous
- what is duplicated, contradictory, or half-migrated
- what is undocumented, or documented wrongly

Be concrete. Prefer "this exists, was last touched on X, appears to do Y" over
tidy categories.

## Known traps
- `/mnt/user/HQ/CLAUDE.md` is the entry point, but it currently has large
  uncommitted changes and describes directories that do not exist. Do not take it
  at face value — checking it is part of the job.
- Several things on this box were retired rather than deleted, and some were
  archived under `_retired/`. Expect to find remnants that look live but are not.
- You share credentials and git worktrees with other agent sessions on this box.
  Read freely; be careful about writing.

## Then what
Once we have the inventory, the next questions are org structure, how agents
should get at code, and what they should remember between runs. Do not answer
those yet — but note anything you find that will matter when we do.
